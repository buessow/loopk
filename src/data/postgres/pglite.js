// A PGlite database (Postgres compiled to WebAssembly) behind the small part
// of pg.Pool's interface the Postgres source uses: query(sql, params) and
// connect() for a transaction. PGlite has one connection, so a client
// checked out with connect() holds it until release() and other queries
// wait for it. Without Node's modules, for the server (memory.js) and the
// browser (public/localworker.js) alike.

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

/**
 * Applies the migrations [{ name, sql }], in order, that the database has
 * not had yet: all to a new one, the newer ones to one kept in the browser.
 */
export async function migrate (db, migrations) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await db.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
  for (const { name, sql } of migrations) {
    if (applied.has(name)) continue;
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
  }
}
