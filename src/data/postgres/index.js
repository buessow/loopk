// The Postgres data source: the Nightscout collections as documents
// (collection.js, mapped to tables by schema.js), the reads loopk's
// features make over them (records.js) and loopk's own state (state.js).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollectionStore } from './collection.js';
import { recordStores } from './records.js';
import { stateStores } from './state.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

// Freshness columns of the monitor (src/monitoring/freshness.js); each is indexed.
const FRESHNESS_SQL = (collection, column) => `SELECT MAX(${column}) AS timestamp FROM ${collection}`;

export function postgresSource (pool) {
  let version = null;
  return {
    kind: 'postgres',
    /** The pool, for Postgres-only tools and tests. */
    pool,
    /** Documents of a Nightscout collection (entries, treatments, devicestatus, profile, food, settings, heartrate). */
    collection: (name) => new CollectionStore(pool, name),
    /** Fails fast when setup-databases.sh has not applied every migration to this database. */
    async checkSchema () {
      const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql'));
      let applied = new Set();
      try {
        const { rows } = await pool.query('SELECT filename FROM schema_migrations');
        applied = new Set(rows.map((r) => r.filename));
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      const pending = files.filter((f) => !applied.has(f));
      if (pending.length) {
        throw new Error(`Database schema is not current (pending: ${pending.join(', ')}). Run ./setup-databases.sh.`);
      }
    },
    /** What APIv3's version reports as storage. */
    async storage () {
      if (!version) version = { storage: 'postgresql', version: (await pool.query('SHOW server_version')).rows[0].server_version };
      return version;
    },
    /** The newest value of `column` in `collection` (from the monitor's fixed list), as stored. */
    async latest (collection, column) {
      return (await pool.query(FRESHNESS_SQL(collection, column))).rows[0].timestamp;
    },
    ...recordStores(pool),
    ...stateStores(pool),
    close: () => pool.end(),
  };
}
