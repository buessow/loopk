import pg from 'pg';

// Return BIGINT columns as JS numbers: all of ours are epoch milliseconds.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));

export function createPool (databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => console.error('Postgres pool error', err));
  return pool;
}
