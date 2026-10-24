// Deletes the glucose readings AAPS's "Random BG" source made up (device
// 'Random', SIMULATED_SOURCES in src/predict/index.js) from the database in
// DATABASE_URL. Like a DELETE through API v3, it marks them not valid with a
// new srvModified, so API clients and browser caches see them go; --permanent
// removes the rows instead. Without --apply it only counts them.
//
//   node --env-file=.env scripts/remove-simulated.js [--apply] [--permanent]

import { parseArgs } from 'node:util';
import { createPool } from '../src/db/index.js';
import { SIMULATED_SOURCES } from '../src/predict/index.js';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    permanent: { type: 'boolean', default: false },
  },
});

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set: run with --env-file=.env');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL);
const SIMULATED = `type = 'sgv' AND device = ANY($1)`;

try {
  const { rows } = await pool.query(
    `SELECT device, count(*)::int AS n, count(*) FILTER (WHERE is_valid IS DISTINCT FROM false)::int AS valid,
       min(date) AS first, max(date) AS last
     FROM entries WHERE ${SIMULATED} GROUP BY device ORDER BY device`,
    [SIMULATED_SOURCES],
  );
  if (!rows.length) console.log('No simulated readings.');
  for (const r of rows) {
    console.log(`${r.device}: ${r.n} readings (${r.valid} still valid), ${r.first.toISOString()} to ${r.last.toISOString()}`);
  }
  const valid = rows.reduce((sum, r) => sum + r.valid, 0);
  if (!rows.length || (!valid && !args.permanent)) {
    if (rows.length) console.log('All are deleted already (--permanent removes the rows).');
  } else if (!args.apply) {
    console.log(`Dry run: add --apply to delete them${args.permanent ? ' permanently' : ''}.`);
  } else if (args.permanent) {
    const { rowCount } = await pool.query(`DELETE FROM entries WHERE ${SIMULATED}`, [SIMULATED_SOURCES]);
    console.log(`Removed ${rowCount} readings.`);
  } else {
    const { rowCount } = await pool.query(
      `UPDATE entries SET is_valid = false, srv_modified = now(), modified_by = 'remove-simulated'
       WHERE ${SIMULATED} AND is_valid IS DISTINCT FROM false`,
      [SIMULATED_SOURCES],
    );
    console.log(`Marked ${rowCount} readings deleted.`);
  }
} finally {
  await pool.end();
}
