// The package an agent runs loopk's MCP from (`npx -y <loopk>/mcp/local-<version>.tgz`,
// local.js): the modules local.js imports, followed from it, in the
// repository's layout so their relative imports hold, the files they read
// (the migrations its in-memory Postgres needs, the AAPS guide), and a package.json with the packages they import
// at this server's versions. Built in memory, once; the same files make the same
// tar (fixed times), so the version changes only with the code.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = 'src/mcp/local.js';
// Files read at run time rather than imported: the AAPS guide (src/analysis/guide.js).
const READ_FILES = ['docs/aaps-algorithms.md'];
// npm's own fixed time for packed files (1985-10-26).
const MTIME = 499162500;
// import/export … from '…' at the start of a line, and import('…').
const IMPORT = /^(?:import|export)\b[^;'`]*?\bfrom\s*'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/gm;

/**
 * The repository's files local.js needs, followed through relative imports,
 * and the packages they import: { files, packages }.
 */
export async function packageFiles () {
  const seen = new Set();
  const packages = new Set();
  const visit = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const [, from, dynamic] of text.matchAll(IMPORT)) {
      const spec = from ?? dynamic;
      if (spec.startsWith('.')) await visit(path.posix.join(path.posix.dirname(file), spec));
      else if (!spec.startsWith('node:')) packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
    }
  };
  await visit(ENTRY);
  const migrations = (await fs.readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).map((f) => `migrations/${f}`);
  return { files: [...[...seen].sort(), ...migrations.sort(), ...READ_FILES], packages: [...packages].sort() };
}

/** The package.json of the package, with `packages` at this server's versions. */
async function manifest (packages) {
  const own = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    name: 'loopk-mcp',
    version: own.version || '0.0.0',
    description: 'loopk\'s MCP server, run by the agent over stdio (LOOPK_URL, LOOPK_TOKEN)',
    type: 'module',
    bin: { 'loopk-mcp': ENTRY },
    engines: own.engines || { node: '>=20' },
    dependencies: Object.fromEntries(packages.map((d) => {
      if (!own.dependencies[d]) throw new Error(`${d}, imported for the MCP package, is not a dependency`);
      return [d, own.dependencies[d]];
    })),
  };
}

/** One ustar entry: a 512-byte header, then the content padded to 512. */
function entry (name, content, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`${name}: too long for a tar header`);
  const header = Buffer.alloc(512);
  const field = (value, offset, length) => header.write(value, offset, length, 'ascii');
  const octal = (n, offset, length) => field(n.toString(8).padStart(length - 1, '0'), offset, length - 1);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(content.length, 124, 12);
  octal(MTIME, 136, 12);
  header.fill(' ', 148, 156); // the checksum counts itself as spaces
  field('0', 156, 1);
  field('ustar\x0000', 257, 8);
  let sum = 0;
  for (const b of header) sum += b;
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

let built = null;

/**
 * A package's version: the start of the sha256 of its tar, not of the gzip,
 * which another Node's zlib packs into other bytes.
 */
export const versionOf = (tar) => createHash('sha256').update(tar).digest('hex').slice(0, 12);

/** The package as a gzipped tarball, with a version from its content: { tgz, version, etag, files, manifest }. */
export function mcpPackage () {
  built ??= (async () => {
    const { files, packages } = await packageFiles();
    const pkg = await manifest(packages);
    const parts = [entry('package/package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), 0o644)];
    for (const f of files) parts.push(entry(`package/${f}`, await fs.readFile(path.join(root, f)), f === ENTRY ? 0o755 : 0o644));
    parts.push(Buffer.alloc(1024));
    const tar = Buffer.concat(parts);
    const tgz = zlib.gzipSync(tar, { level: 9 });
    const version = versionOf(tar);
    return { tgz, version, etag: `"${version}"`, files, manifest: pkg };
  })().catch((err) => {
    built = null;
    throw err;
  });
  return built;
}

const LAUNCHER = 'src/mcp/latest.js';
let launcher = null;

/**
 * The package at the URL that stays (`npx -y <site>/mcp/local.tgz`, latest.js):
 * it starts the current package, so it changes only with latest.js: { tgz, etag }.
 */
export function latestPackage () {
  launcher ??= (async () => {
    const own = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const pkg = {
      name: 'loopk-mcp-latest',
      version: '1.0.0',
      description: 'Starts loopk\'s current MCP package (LOOPK_SITE, default https://loopk.cc)',
      type: 'module',
      bin: { 'loopk-mcp': LAUNCHER },
      engines: own.engines || { node: '>=20' },
    };
    const tar = Buffer.concat([
      entry('package/package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), 0o644),
      entry(`package/${LAUNCHER}`, await fs.readFile(path.join(root, LAUNCHER)), 0o755),
      Buffer.alloc(1024),
    ]);
    const tgz = zlib.gzipSync(tar, { level: 9 });
    return { tgz, etag: `"${versionOf(tar)}"` };
  })().catch((err) => {
    launcher = null;
    throw err;
  });
  return launcher;
}
