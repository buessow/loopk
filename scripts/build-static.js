// Writes loopk's static server (docs/modes.md) into a directory, for GitHub
// Pages (.github/workflows/pages.yml): the MCP package an agent runs itself
// (mcp/local-<version>.tgz, named by mcp/local.json), the package that starts
// the current one (mcp/local.tgz, src/mcp/latest.js), and with --pages the
// pages and what the browser needs to be loopk itself, as the full server
// serves them (createPageRoutes in src/app.js). Nothing in it is anyone's
// data.
//
//   node scripts/build-static.js <dir> [--pages] [--keep-from=https://loopk.cc]
//
// Each publish replaces the whole site, and npx keeps a package by its URL:
// --keep-from fetches the packages the published site holds (mcp/versions.json)
// and keeps the last KEEP of them, so an agent added with an older version's
// URL can still install it. Agents added with mcp/local.tgz run the current one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BROWSER_SOURCE } from '../src/app.js';
import { readMigrations } from '../src/data/postgres/memory.js';
import { latestPackage, mcpPackage, versionOf } from '../src/mcp/pack.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// MCP packages kept, the current one included.
const KEEP = 10;
// PGlite's files the browser does not load: source maps, types, the CommonJS
// build and the Postgres extensions loopk does not use.
const PGLITE_SKIP = /\.(map|d\.ts|d\.cts|cjs)$|\.tar\.gz$/;

/** The packages `site` publishes now, checked against their names: [{ version, at, tgz }]. */
async function published (site) {
  const res = await fetch(new URL('/mcp/versions.json', site));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${site}/mcp/versions.json: HTTP ${res.status}`);
  const kept = [];
  for (const { version, at } of await res.json()) {
    const tgz = await fetch(new URL(`/mcp/local-${version}.tgz`, site));
    if (!tgz.ok) continue;
    const bytes = Buffer.from(await tgz.arrayBuffer());
    let tar = null;
    try {
      tar = gunzipSync(bytes);
    } catch { /* not a package at all */ }
    // packages published before versions came from the tar are named by their gzip
    if ((!tar || versionOf(tar) !== version) && versionOf(bytes) !== version) throw new Error(`${site}: local-${version}.tgz does not match its name`);
    kept.push({ version, at, tgz: bytes });
  }
  return kept;
}

async function writeMcp (dir, keepFrom) {
  const { tgz, version } = await mcpPackage();
  const live = keepFrom ? await published(keepFrom) : [];
  // the current package keeps the time it was first published
  const at = live.find((p) => p.version === version)?.at ?? new Date().toISOString();
  const versions = [{ version, at, tgz }, ...live.filter((p) => p.version !== version)].slice(0, KEEP);
  await fs.mkdir(path.join(dir, 'mcp'), { recursive: true });
  for (const p of versions) await fs.writeFile(path.join(dir, 'mcp', `local-${p.version}.tgz`), p.tgz);
  await fs.writeFile(path.join(dir, 'mcp', 'versions.json'), JSON.stringify(versions.map(({ version, at }) => ({ version, at }))));
  await fs.writeFile(path.join(dir, 'mcp', 'local.json'), JSON.stringify({ version, path: `/mcp/local-${version}.tgz` }));
  await fs.writeFile(path.join(dir, 'mcp', 'local.tgz'), (await latestPackage()).tgz);
  return versions.map((p) => p.version);
}

async function writePages (dir) {
  await fs.cp(path.join(root, 'public'), dir, { recursive: true });
  for (const part of BROWSER_SOURCE) await fs.cp(path.join(root, 'src', part), path.join(dir, 'src', part), { recursive: true });
  await fs.cp(path.join(root, 'node_modules', '@electric-sql', 'pglite', 'dist'), path.join(dir, 'vendor', 'pglite'), {
    recursive: true,
    filter: (from) => !PGLITE_SKIP.test(from),
  });
  await fs.writeFile(path.join(dir, 'migrations.json'), JSON.stringify(await readMigrations()));
}

/** Until the pages run without the full server: what is here, and how an agent adds loopk. */
async function writePlaceholder (dir, version) {
  const command = `claude mcp add --scope user loopk \\
  -e NIGHTSCOUT_URL=https://your.nightscout.example \\
  -e NIGHTSCOUT_TOKEN=&lt;an access token on it&gt; \\
  -- npx -y https://loopk.cc/mcp/local.tgz`;
  await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>loopk</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --code: #f2f2f4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --fg: #f2f2f4; --muted: #a1a1a6; --code: #1e1e21; } }
  body { margin: 0 auto; max-width: 44rem; padding: 2rem 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  pre { background: var(--code); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<h1>loopk</h1>
<p>Static pages of <a href="https://github.com/buessow/loopk">loopk</a>: code only. Nothing here keeps or receives anyone's data.</p>
<p>The pages that run loopk in your browser are coming. Agents can already run loopk's MCP tools themselves, reading your Nightscout server directly (Node 20 or later):</p>
<pre>${command}</pre>
<p class="muted">Codex, Gemini CLI and other MCP clients take the same command and variables. It runs the current package at each start: ${version}, from commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}.</p>
</body>
</html>
`);
}

async function main () {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: node scripts/build-static.js <dir> [--pages] [--keep-from=<site>]');
    process.exit(2);
  }
  const keepFrom = args.find((a) => a.startsWith('--keep-from='))?.slice('--keep-from='.length);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const versions = await writeMcp(dir, keepFrom);
  if (args.includes('--pages')) await writePages(dir);
  else await writePlaceholder(dir, versions[0]);
  console.log(`build-static: ${dir}, MCP package ${versions[0]}${versions.length > 1 ? `, keeping ${versions.slice(1).join(' ')}` : ''}`);
}

await main();
