// An in-memory Postgres (PGlite: Postgres compiled to WebAssembly, in this
// process) with loopk's schema, behind the small part of pg.Pool's interface
// the Postgres source uses: query(sql, params) and connect() for a
// transaction. PGlite has one connection, so a client checked out with
// connect() holds it until release() and other queries wait for it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

/** A pool-like object over a PGlite database. */
export function pglitePool (db) {
  let tail = Promise.resolve();
  // Runs fn alone: after everything queued before it.
  const exclusive = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  const query = async (sql, params) => {
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: Math.max(r.rows.length, r.affectedRows || 0) };
  };
  return {
    query: (sql, params) => exclusive(() => query(sql, params)),
    /** A client holding the database for a transaction until release(). */
    connect () {
      return new Promise((resolve) => {
        exclusive(() => new Promise((release) => resolve({ query, release })));
      });
    },
    end: () => db.close(),
  };
}

/** A new in-memory database with every migration applied, as a pool-like object. */
export async function memoryPool () {
  const db = await PGlite.create();
  const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  await db.exec('CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const f of files) {
    await db.exec(await fs.readFile(path.join(MIGRATIONS, f), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
  }
  return pglitePool(db);
}
