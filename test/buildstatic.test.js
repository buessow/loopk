import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { latestPackage, mcpPackage, versionOf } from '../src/mcp/pack.js';

// scripts/build-static.js: the static server's files (docs/modes.md).
const build = (...args) => new Promise((resolve, reject) => {
  execFile(process.execPath, ['scripts/build-static.js', ...args], (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
});

/** A static server of `dir`, as GitHub Pages serves it. */
async function serve (dir) {
  const server = http.createServer(async (req, res) => {
    try {
      res.end(await fs.readFile(path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withDirs (fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loopk-static-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('the static site holds the current MCP package, named by mcp/local.json, the one that starts it, and a page without the full server\'s', async () => {
  await withDirs(async (dir) => {
    const site = path.join(dir, 'site');
    await build(site);
    const { tgz, version } = await mcpPackage();
    assert.deepEqual(await readJson(path.join(site, 'mcp', 'local.json')), { version, path: `/mcp/local-${version}.tgz` });
    assert.deepEqual(await fs.readFile(path.join(site, 'mcp', `local-${version}.tgz`)), tgz);
    assert.deepEqual((await readJson(path.join(site, 'mcp', 'versions.json'))).map((v) => v.version), [version]);
    assert.deepEqual(await fs.readFile(path.join(site, 'mcp', 'local.tgz')), (await latestPackage()).tgz);
    const index = await fs.readFile(path.join(site, 'index.html'), 'utf8');
    assert.match(index, /npx -y https:\/\/loopk\.cc\/mcp\/local\.tgz/);
    await assert.rejects(fs.access(path.join(site, 'login.html')));
  });
});

test('with --pages the static site holds the pages, the browser\'s part of src, PGlite, the migrations and a service worker', async () => {
  await withDirs(async (dir) => {
    const site = path.join(dir, 'site');
    await build(site, '--pages');
    for (const f of ['simulate.html', 'localworker.js', 'src/oref/api.js', 'src/data/nightscout/index.js', 'src/reports/profiles.js', 'src/sport/mode.js', 'src/auth/permissions.js', 'vendor/pglite/index.js', 'vendor/pglite/pglite.wasm', 'vendor/pglite/pglite.data']) await fs.access(path.join(site, f));
    // nothing of the server's own, and no test pages
    for (const f of ['src/auth/index.js', 'src/mcp', 'src/api3', 'vendor/pglite/index.js.map', 'vendor/pglite/pgcrypto.tar.gz', 'direct-test.html', 'passkey-test.js']) await assert.rejects(fs.access(path.join(site, f)), f);
    const migrations = await readJson(path.join(site, 'migrations.json'));
    assert.equal(migrations[0].name, '0001_init.sql');
    // the pages know they are static, and wait for no live updates
    assert.match(await fs.readFile(path.join(site, 'site.js'), 'utf8'), /export const STATIC = true;/);
    assert.doesNotMatch(await fs.readFile(path.join(site, 'index.html'), 'utf8'), /socket\.io/);
    // the service worker keeps every page and file but the MCP packages
    const sw = await fs.readFile(path.join(site, 'sw.js'), 'utf8');
    const files = JSON.parse(/const FILES = (\[.*\]);/.exec(sw)[1]);
    for (const f of ['/', '/simulate', '/simulate.html', '/site.js', '/src/oref/api.js', '/vendor/pglite/pglite.wasm', '/migrations.json']) assert.ok(files.includes(f), f);
    assert.ok(!files.some((f) => f.startsWith('/mcp/') || f === '/sw.js'));
    // a new build of the same files is the same version
    await build(path.join(dir, 'again'), '--pages');
    assert.equal(/const VERSION = "(.*)";/.exec(await fs.readFile(path.join(dir, 'again', 'sw.js'), 'utf8'))[1], /const VERSION = "(.*)";/.exec(sw)[1]);
  });
});

test('a new build keeps the packages the published site holds, checked against their names, newest first', async () => {
  await withDirs(async (dir) => {
    // the published site: an older package and the current one
    const live = path.join(dir, 'live');
    await build(live);
    const old = gzipSync(Buffer.from('an older package'));
    const oldVersion = versionOf(Buffer.from('an older package'));
    await fs.writeFile(path.join(live, 'mcp', `local-${oldVersion}.tgz`), old);
    const { version } = await mcpPackage();
    const at = '2026-10-01T00:00:00.000Z';
    await fs.writeFile(path.join(live, 'mcp', 'versions.json'), JSON.stringify([{ version, at }, { version: oldVersion, at: '2026-09-01T00:00:00.000Z' }]));
    const pages = await serve(live);
    try {
      const site = path.join(dir, 'site');
      await build(site, `--keep-from=${pages.url}`);
      const versions = await readJson(path.join(site, 'mcp', 'versions.json'));
      assert.deepEqual(versions, [{ version, at }, { version: oldVersion, at: '2026-09-01T00:00:00.000Z' }]);
      assert.deepEqual(await fs.readFile(path.join(site, 'mcp', `local-${oldVersion}.tgz`)), old);

      // a package that is not what its name says is refused
      await fs.writeFile(path.join(live, 'mcp', `local-${oldVersion}.tgz`), 'changed');
      await assert.rejects(build(path.join(dir, 'again'), `--keep-from=${pages.url}`), /does not match its name/);
    } finally {
      await pages.close();
    }

    // a site that publishes none yet
    const empty = await serve(path.join(dir, 'nothing'));
    try {
      await build(path.join(dir, 'first'), `--keep-from=${empty.url}`);
      assert.equal((await readJson(path.join(dir, 'first', 'mcp', 'versions.json'))).length, 1);
    } finally {
      await empty.close();
    }
  });
});
