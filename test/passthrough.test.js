import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, tokenFor } from './helpers.js';
import { Callers, createPassthroughApp } from '../src/passthrough/index.js';
import { Sealer } from '../src/auth/seal.js';
import { nightscoutSource } from '../src/data/nightscout/index.js';
import { loadTestProfile, saveTestProfile } from '../src/oref/testprofile.js';
import { saveSettings, storedSettings } from '../src/oref/settings.js';
import { loadConfig } from '../src/config.js';

// Another loopk plays the Nightscout server; the server under test keeps
// nothing and serves each caller with their own token on it.
let s;
let writer;
let reader;
let callers;
let app;
const MIN = 60000;
const t0 = Date.UTC(2026, 0, 10);
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });
const profile = {
  units: 'mg/dl', dia: 5, timezone: 'UTC', basal: [entry('00:00', 1)], sens: [entry('00:00', 100)],
  carbratio: [entry('00:00', 10)], target_low: [entry('00:00', 100)], target_high: [entry('00:00', 110)],
};

const passthrough = (env = {}) => {
  const config = loadConfig({ DATA_SOURCE: 'nightscout', NIGHTSCOUT_URL: s.url, SESSION_KEY: 'test-session-key', ...env });
  const c = new Callers(config);
  return { callers: c, app: createPassthroughApp(config, { callers: c }) };
};

before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'viewer', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set({ Authorization: `Bearer ${writer.jwt}` })
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);
  await post('profile', { date: t0 - 10 * 24 * 60 * MIN, defaultProfile: 'P', store: { P: profile } });
  for (let m = 0; m < 120; m += 5) await post('entries', { type: 'sgv', date: t0 + m * MIN, sgv: 100 + m, device: 'G7' });
  ({ callers, app } = passthrough());
});
after(async () => {
  await callers?.close();
  await s.close();
});

const entriesQuery = `/api/v3/entries?date$gte=${t0}&date$lt=${t0 + 30 * MIN}&sort=date`;

test('sealed credentials open only with the key that sealed them, unchanged', () => {
  const sealer = new Sealer('one key');
  const sealed = sealer.seal({ url: 'https://ns.example', token: 'reader-0123' });
  assert.deepEqual(sealer.open(sealed), { url: 'https://ns.example', token: 'reader-0123' });
  assert.ok(!sealed.includes('reader'));
  assert.equal(new Sealer('another key').open(sealed), null);
  const flipped = Buffer.from(sealed, 'base64url');
  flipped[20] ^= 1;
  assert.equal(sealer.open(flipped.toString('base64url')), null);
  assert.equal(sealer.open('nonsense'), null);
});

test('without a token there are the pages and the sign-in, nothing else', async () => {
  await request(app).get('/login').expect(200).expect('Content-Type', /html/);
  const { body } = await request(app).get('/api/session').expect(401);
  assert.equal(body.keepsNothing, true);
  assert.equal(body.nightscout, s.url);
  await request(app).get(entriesQuery).expect(401);
  await request(app).get(`${entriesQuery}&token=nope-0000`).expect(401);
  await request(app).get(entriesQuery).set('Authorization', 'Bearer not.a.jwt').expect(401);
  assert.equal(callers.size, 0);
});

test('signing in with a token keeps it sealed in the cookie and serves the page with what the token may do', async () => {
  await request(app).post('/auth/token').send({ token: 'nope-0000' }).expect(401);
  const res = await request(app).post('/auth/token').send({ token: reader.accessToken }).expect(200);
  assert.equal(res.body.name, 'viewer');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^loopk_session=.*HttpOnly/);
  assert.ok(!cookie.includes(reader.accessToken));

  const agent = request.agent(app);
  agent.jar.setCookie(cookie);
  const session = (await agent.get('/api/session').expect(200)).body;
  assert.equal(session.keepsNothing, true);
  assert.equal(session.user.name, 'viewer');
  assert.deepEqual(session.permissions, ['api:*:read']);
  assert.deepEqual((await agent.get(entriesQuery).expect(200)).body.result.map((d) => d.sgv), [100, 105, 110, 115, 120, 125]);
  const hours = (await agent.get(`/api/reports/hours?from=${t0}&to=${t0 + 2 * 60 * MIN}`).expect(200)).body;
  assert.ok(hours.rows.length > 0);
  // access is the Nightscout server's; a read token changes nothing there
  await agent.get('/api/admin/users').expect(404);
  await agent.post('/api/v3/entries').send({ type: 'sgv', date: t0, sgv: 90, app: 'test' }).expect(403);

  await agent.post('/auth/logout').expect(200);
  await agent.get('/api/session').expect(401);
});

test('API clients bring the token as ?token= or as a JWT from the token exchange, which carries it sealed', async () => {
  assert.equal((await request(app).get(`${entriesQuery}&token=${reader.accessToken}`).expect(200)).body.result.length, 6);

  const { body } = await request(app).get(`/api/v2/authorization/request/${reader.accessToken}`).expect(200);
  assert.equal(body.sub, 'viewer');
  assert.deepEqual(body.permissionGroups, [['api:*:read']]);
  assert.ok(!Buffer.from(body.token.split('.')[1], 'base64url').toString().includes(reader.accessToken));
  const bearer = { Authorization: `Bearer ${body.token}` };
  assert.equal((await request(app).get(entriesQuery).set(bearer).expect(200)).body.result.length, 6);
  await request(app).get('/api/v2/authorization/request/nope-0000').expect(401);
  // a JWT signed with another key is no use here
  const other = passthrough({ SESSION_KEY: 'another key' });
  try {
    await request(other.app).get(entriesQuery).set(bearer).expect(401);
  } finally {
    await other.callers.close();
  }
});

test('agents use the MCP server with ?token=', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.address().port}/mcp?token=${reader.accessToken}`)));
    const r = await client.callTool({ name: 'get_glucose', arguments: { from: new Date(t0).toISOString(), to: new Date(t0 + 30 * MIN).toISOString(), units: 'mg/dL' } });
    assert.ok(!r.isError, r.content[0].text);
    assert.match(r.content[0].text, /125/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('each token has its own cache, dropped when unused for a while', async () => {
  const before = callers.size;
  const a = await callers.get({ url: s.url, token: reader.accessToken });
  assert.equal(await callers.get({ url: s.url, token: reader.accessToken }), a);
  const b = await callers.get({ url: s.url, token: writer.accessToken });
  assert.notEqual(a.data, b.data);
  assert.equal(callers.size, Math.max(before, 2));
  callers.sweep(Date.now() + callers.idle + 1);
  assert.equal(callers.size, 0);
  // and is made again on the next request
  assert.notEqual(await callers.get({ url: s.url, token: reader.accessToken }), a);
});

test('without NIGHTSCOUT_URL the caller names the server at sign-in', async () => {
  const open = passthrough({ NIGHTSCOUT_URL: '' });
  try {
    assert.equal((await request(open.app).get('/api/session').expect(401)).body.nightscout, null);
    await request(open.app).post('/auth/token').send({ token: reader.accessToken }).expect(400);
    await request(open.app).post('/auth/token').send({ url: 'file:///etc/passwd', token: reader.accessToken }).expect(400);
    const res = await request(open.app).post('/auth/token').send({ url: `${s.url}/`, token: reader.accessToken }).expect(200);
    assert.equal(res.body.url, s.url);
    const agent = request.agent(open.app);
    agent.jar.setCookie(res.headers['set-cookie'][0]);
    assert.equal((await agent.get(entriesQuery).expect(200)).body.result.length, 6);
    // ?token= alone names no server
    await request(open.app).get(`${entriesQuery}&token=${reader.accessToken}`).expect(401);
  } finally {
    await open.callers.close();
  }
});

test('loopk settings are kept on the Nightscout server, for every token that may read them there', async () => {
  const test = { dia: 5, units: 'mg/dl', basal: [[0, 1.2]], isf: [[0, 100]], ic: [[0, 10]], targetLow: [[0, 100]], targetHigh: [[0, 110]] };
  const rw = await nightscoutSource({ url: s.url, token: writer.accessToken });
  const ro = await nightscoutSource({ url: s.url, token: reader.accessToken });
  try {
    assert.equal(await loadTestProfile(rw), null);
    await saveTestProfile(rw, { profile: test, note: 'more basal' }, 'agent');
    await saveSettings(rw, { maxSMBBasalMinutes: 60 }, { validFrom: t0, by: 'agent' });
    await saveSettings(rw, { maxSMBBasalMinutes: 90 }, { validFrom: t0 + 60 * MIN, by: 'agent' });

    // another source over the same server, as after a restart
    const again = await nightscoutSource({ url: s.url, token: writer.accessToken });
    try {
      const p = await loadTestProfile(again);
      assert.equal(p.note, 'more basal');
      assert.equal(p.updatedBy, 'agent');
      assert.deepEqual(p.basal, [[0, 1.2]]);
      assert.deepEqual(await storedSettings(again, t0 + 30 * MIN), { maxSMBBasalMinutes: 60 });
      assert.deepEqual(await storedSettings(again, t0 + 90 * MIN), { maxSMBBasalMinutes: 90 });
      assert.deepEqual(await again.loopSettings.changes(t0, t0 + 2 * 60 * MIN), [t0 + 60 * MIN]);
    } finally {
      await again.close();
    }
    // a read token sees them and may save none
    assert.equal((await loadTestProfile(ro)).note, 'more basal');
    await assert.rejects(saveTestProfile(ro, { profile: test }), /needs a token that may change settings/);
  } finally {
    await rw.close();
    await ro.close();
  }
});

test('agents simulate and write the AI Test profile through MCP with their own token, as far as it may change settings', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const agent = async (token) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.address().port}/mcp?token=${token}`)));
    return client;
  };
  const text = (r) => r.content[0].text;
  const ro = await agent(reader.accessToken);
  const rw = await agent(writer.accessToken);
  try {
    const settings = await ro.callTool({ name: 'get_loop_settings', arguments: { at: new Date(t0).toISOString() } });
    assert.ok(!settings.isError, text(settings));
    const period = await ro.callTool({ name: 'simulate_period', arguments: { from: new Date(t0).toISOString(), to: new Date(t0 + 120 * MIN).toISOString() } });
    assert.ok(text(period).length > 0);

    const refused = await ro.callTool({ name: 'set_test_profile', arguments: { based_on: 'P', note: 'from an agent' } });
    assert.ok(refused.isError);
    assert.match(text(refused), /needs a token that may change settings on http/);

    const saved = await rw.callTool({ name: 'set_test_profile', arguments: { based_on: 'P', dia_hours: 6, note: 'from an agent' } });
    assert.ok(!saved.isError, text(saved));
    // every token that may read settings there sees it
    callers.sweep(Date.now() + callers.idle + 1);
    const seen = JSON.parse(text(await ro.callTool({ name: 'get_test_profile', arguments: {} })));
    assert.equal(seen.note, 'from an agent');
  } finally {
    await ro.close();
    await rw.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
