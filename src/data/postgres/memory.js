// An in-memory Postgres (PGlite, in this process) with loopk's schema, as a
// pool-like object (pglite.js).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pglitePool } from './pglite.js';

export { pglitePool } from './pglite.js';

export const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

/** The migrations in order: [{ name, sql }]. */
export async function readMigrations () {
  const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await fs.readFile(path.join(MIGRATIONS, name), 'utf8') })));
}

/** A new in-memory database with every migration applied, as a pool-like object. */
export async function memoryPool () {
  const db = await PGlite.create();
  await migrate(db, await readMigrations());
  return pglitePool(db);
}
