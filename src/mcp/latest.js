#!/usr/bin/env node
// The package at <site>/mcp/local.tgz: it starts loopk's current MCP package
// (local.js, at the versioned URL <site>/mcp/local.json names) with this
// process's stdio and environment. npx keeps what it fetched from a URL, so
// an agent added with this one keeps this file: it must not need changing,
// and imports nothing but Node.
//
// The site is LOOPK_SITE, else LOOPK_URL (a full server serves its own
// packages), else https://loopk.cc. Offline, it runs the version it ran last.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const site = (env.LOOPK_SITE || env.LOOPK_URL || 'https://loopk.cc').replace(/\/$/, '');
const last = path.join(os.homedir(), '.cache', 'loopk', `${encodeURIComponent(site)}.json`);

async function current () {
  try {
    const res = await fetch(`${site}/mcp/local.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const named = await res.json();
    await fs.mkdir(path.dirname(last), { recursive: true }).then(() => fs.writeFile(last, JSON.stringify(named))).catch(() => {});
    return named;
  } catch (err) {
    try {
      return JSON.parse(await fs.readFile(last, 'utf8'));
    } catch {
      console.error(`loopk-mcp: ${site}/mcp/local.json: ${err.message}`);
      process.exit(1);
    }
  }
}

const { path: pkg } = await current();
// A version's URL never changes what it holds, so npx's copy needs no check
// (which offline waits for its retries).
const child = spawn('npx', ['-y', '--prefer-offline', '--no-update-notifier', new URL(pkg, `${site}/`).href], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (err) => {
  console.error(`loopk-mcp: npx: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
