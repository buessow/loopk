import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, tokenFor } from './helpers.js';
import { latestPackage, mcpPackage } from '../src/mcp/pack.js';
import { loadTestProfile } from '../src/oref/testprofile.js';

// loopk's MCP run by the agent itself (src/mcp/local.js), over stdio,
// reading a loopk server with a read token as the browser does.
const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 9, 24, 4);
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });

let s;
let reader;

before(async () => {
  s = await startServer({ TIME_ZONE: 'Europe/Zurich' });
  const writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'agent', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set({ Authorization: `Bearer ${writer.jwt}` })
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);
  const P = {
    units: 'mmol', dia: 5, timezone: 'Europe/Zurich', basal: [entry('00:00', 1)], sens: [entry('00:00', 5.4)],
    carbratio: [entry('00:00', 9)], target_low: [entry('00:00', 5.5)], target_high: [entry('00:00', 6.5)],
  };
  await post('profile', { date: t0 - 24 * HOUR, defaultProfile: 'P', store: { P } });
  // the switch to it as it took effect, which runs are replayed with
  await post('treatments', {
    eventType: 'Note', date: t0 - 23 * HOUR, notes: 'P', originalProfileName: 'P', originalCustomizedName: 'P', originalPercentage: 100,
    originalTimeshift: 0, originalDuration: 0, originalEnd: 0, profileJson: JSON.stringify(P),
  });
  for (let m = -60; m < 120; m += 5) await post('entries', { type: 'sgv', date: t0 + m * MIN, sgv: 100 + Math.max(0, m), device: 'G7 Native' });
  for (const m of [10, 15]) {
    await post('treatments', { eventType: 'Correction Bolus', date: t0 + m * MIN, insulin: 0.5, type: 'SMB', isSMB: true });
    const run = { bg: 110, eventualBG: 180, targetBG: 110, variable_sens: 100, insulinReq: 0.9, COB: 0, IOB: 0.5, units: 0.5, algorithm: 'SMB', reason: 'Eventual BG 10.0 >= 6.1, insulinReq 0.9. Microbolusing 0.5U.', predBGs: { IOB: [110, 120, 130] }, deliverAt: new Date(t0 + m * MIN).toISOString() };
    await post('devicestatus', { date: t0 + m * MIN, device: 'openaps://phone', openaps: { suggested: run, enacted: { ...run, smb: 0.5 } } });
  }
});
after(async () => {
  await s.close();
});

/** An MCP client of local.js run with `env`. */
async function agent (env) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp/local.js'], env: { PATH: process.env.PATH, ...env }, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError ? r.content[0].text : null, text: r.content[0].text };
  };
  return { client, call };
}

const run = (env, script = 'src/mcp/local.js') => new Promise((resolve) => {
  execFile(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }));
});

/** The files of a tar archive: { name: Buffer }. */
function untar (tar) {
  const out = {};
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString(), 8);
    out[name] = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test('the package holds what local.js imports, with the packages they import at this server\'s versions', async () => {
  const { tgz, etag, files, manifest } = await mcpPackage();
  assert.ok(files.includes('src/mcp/local.js') && files.includes('src/oref/simulate.js') && files.includes('public/view.js'));
  assert.ok(files.some((f) => f.startsWith('migrations/')));
  assert.ok(!files.some((f) => /routes\.js$|mcp\/server\.js$|postgres\/pool\.js$|follower\.js$/.test(f)), files.join(' '));
  assert.deepEqual(manifest.bin, { 'loopk-mcp': 'src/mcp/local.js' });
  assert.ok(!('express' in manifest.dependencies) && !('pg' in manifest.dependencies));
  assert.ok('@electric-sql/pglite' in manifest.dependencies && 'zod' in manifest.dependencies);
  const tar = gunzipSync(tgz);
  assert.equal(tar.subarray(0, 20).toString().replace(/\0.*/, ''), 'package/package.json');
  // npx keeps what it fetched from a URL: agents get the version's URL
  const { body: current } = await request(s.app).get('/mcp/local.json').expect(200);
  assert.equal(etag, `"${current.version}"`);
  assert.equal(current.path, `/mcp/local-${current.version}.tgz`);
  const res = await request(s.app).get(current.path).expect(200).expect('Content-Type', 'application/gzip').expect('ETag', etag);
  assert.equal(res.body.length, tgz.length);
  await request(s.app).get('/mcp/local-0123abcd.tgz').expect(200);
  await request(s.app).get('/mcp/local-0123abcd.tgz').set('If-None-Match', etag).expect(304);
  // the URL that stays starts the current package
  const latest = await latestPackage();
  const stays = await request(s.app).get('/mcp/local.tgz').expect(200).expect('ETag', latest.etag);
  assert.equal(stays.body.length, latest.tgz.length);
  assert.deepEqual(Object.keys(untar(gunzipSync(latest.tgz))), ['package/package.json', 'package/src/mcp/latest.js']);
});

test('the package runs on its own, unpacked as npx installs it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loopk-mcp-'));
  try {
    for (const [name, content] of Object.entries(untar(gunzipSync((await mcpPackage()).tgz)))) {
      const file = path.join(dir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    // the dependencies npx would install, from this checkout
    await fs.symlink(path.resolve('node_modules'), path.join(dir, 'package', 'node_modules'));
    // every module loads; it stops only for want of a server
    const none = await run({}, path.join(dir, 'package', 'src', 'mcp', 'local.js'));
    assert.match(none.stderr, /^loopk-mcp: set LOOPK_URL and LOOPK_TOKEN/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an agent runs loopk\'s tools and simulator itself with a read token, and saves the AI Test profile on loopk', async () => {
  const { client, call } = await agent({ LOOPK_URL: s.url, LOOPK_TOKEN: reader.accessToken });
  try {
    const g = await call('get_glucose', { from: new Date(t0).toISOString(), to: new Date(t0 + 30 * MIN).toISOString(), units: 'mg/dL' });
    assert.equal(g.error, null);
    assert.match(g.text, /125/);
    const r = await call('simulate_run', { time: new Date(t0 + 10 * MIN).toISOString(), changes: { profilePercentage: 120 } });
    assert.equal(r.error, null, r.text);
    const p = await call('simulate_period', { from: new Date(t0).toISOString(), to: new Date(t0 + 2 * HOUR).toISOString() });
    assert.equal(p.error, null, p.text);

    const bad = await call('set_test_profile', { based_on: 'P', dia_hours: 20 });
    assert.match(bad.error, /DIA must be 2 to 10 hours/);
    const saved = await call('set_test_profile', { based_on: 'P', dia_hours: 6, note: 'longer DIA' });
    assert.equal(saved.error, null, saved.text);
    const kept = await loadTestProfile(s.ctx.data);
    assert.equal(kept.note, 'longer DIA');
    assert.equal(kept.dia, 6);
    assert.equal(kept.updatedBy, 'agent');
    assert.equal(JSON.parse((await call('get_test_profile')).text).note, 'longer DIA');
  } finally {
    await client.close();
  }
});

test('the server answers saving the AI Test profile for read tokens, checked, and not without one', async () => {
  const profile = { dia: 5, units: 'mmol', basal: [[0, 1]], isf: [[0, 5]], ic: [[0, 9]], targetLow: [[0, 5.5]], targetHigh: [[0, 6.5]] };
  const auth = { Authorization: `Bearer ${reader.jwt}` };
  const { body } = await request(s.app).put('/api/simulate/test-profile').set(auth).send({ profile, basedOn: 'P', note: 'flat' }).expect(200);
  assert.equal(body.note, 'flat');
  assert.equal(body.basedOn, 'P');
  await request(s.app).put('/api/simulate/test-profile').set(auth).send({ profile: { ...profile, dia: 1 } }).expect(400);
  await request(s.app).put('/api/simulate/test-profile').send({ profile }).expect(401);
});

test('reading a Nightscout server directly, a read token may not save there', async () => {
  const { client, call } = await agent({ NIGHTSCOUT_URL: s.url, NIGHTSCOUT_TOKEN: reader.accessToken });
  try {
    assert.equal((await call('get_profile')).error, null);
    assert.match((await call('set_test_profile', { based_on: 'P', note: 'x' })).error, /needs a token that may change settings/);
  } finally {
    await client.close();
  }
});

test('without a server or with a wrong token the agent\'s MCP ends with a readable message', async () => {
  const none = await run({});
  assert.equal(none.code, 1);
  assert.match(none.stderr, /set LOOPK_URL and LOOPK_TOKEN/);
  const wrong = await run({ LOOPK_URL: s.url, LOOPK_TOKEN: 'nope-0000' });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /did not accept the access token/);
});

test('the package at the URL that stays runs the version mcp/local.json names, and offline the one it ran last', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loopk-latest-'));
  // a site with a stand-in for the current package, which prints what it was given
  const site = path.join(dir, 'site');
  await fs.mkdir(path.join(site, 'mcp'), { recursive: true });
  const stub = path.join(dir, 'stub', 'package');
  await fs.mkdir(stub, { recursive: true });
  await fs.writeFile(path.join(stub, 'package.json'), JSON.stringify({ name: 'stub', version: '1.0.0', bin: { stub: 'run.js' } }));
  await fs.writeFile(path.join(stub, 'run.js'), '#!/usr/bin/env node\nconsole.log(`v1 ${process.env.LOOPK_TOKEN}`);\n', { mode: 0o755 });
  await new Promise((resolve, reject) => execFile('tar', ['-czf', path.join(site, 'mcp', 'local-v1.tgz'), '-C', path.dirname(stub), 'package'], (err) => (err ? reject(err) : resolve())));
  await fs.writeFile(path.join(site, 'mcp', 'local.json'), JSON.stringify({ version: 'v1', path: '/mcp/local-v1.tgz' }));
  const server = http.createServer(async (req, res) => {
    try {
      res.end(await fs.readFile(path.join(site, new URL(req.url, 'http://x').pathname)));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  // its own home, so npx's cache and the version run last start empty
  const launch = () => new Promise((resolve) => {
    execFile(process.execPath, ['src/mcp/latest.js'], { env: { PATH: process.env.PATH, HOME: dir, LOOPK_SITE: url, LOOPK_TOKEN: 't0k' } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  try {
    const online = await launch();
    assert.equal(online.code, 0, online.stderr);
    assert.equal(online.stdout.trim(), 'v1 t0k');
    await new Promise((resolve) => server.close(resolve));
    const offline = await launch();
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(offline.stdout.trim(), 'v1 t0k');
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
