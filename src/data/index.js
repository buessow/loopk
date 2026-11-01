// The data source: everything loopk reads and keeps goes through one object,
// ctx.data, so the storage behind it can be replaced. postgres/ is the one
// there is; a source keeps the same shape:
//
//   collection(name)        Nightscout documents of a collection, for the
//                           APIs, following and writes (CollectionStore's
//                           methods: findMany, insert, upsert, ...)
//   glucose, treatments,    reads over a stated time range (epoch ms), as
//   loop, profiles,         the features use them (postgres/records.js);
//   heartrate               a source that loads on demand fetches what a
//                           range needs first
//   serverKey, subjects,    loopk's own state: access, the followed server,
//   users, follow, sport,   sport mode, simulator settings, dashboards and
//   loopSettings,           predictions (postgres/state.js)
//   testProfiles,
//   dashboards, models,
//   predictions
//   storage(), latest(), close()
//
// nightscout/ is a source over another server: the Postgres queries run on
// an in-memory copy of the ranges they need, loaded on demand, and loopk's
// settings are kept on that server (nightscout/settings.js).

import { createPool } from './postgres/pool.js';
import { memoryPool } from './postgres/memory.js';
import { postgresSource } from './postgres/index.js';
import { nightscoutSource } from './nightscout/index.js';

export { BadFilterError, REMOVED } from './postgres/collection.js';

/**
 * The data source for `config`: DATA_SOURCE postgres (DATABASE_URL), memory,
 * or nightscout (NIGHTSCOUT_URL read with NIGHTSCOUT_TOKEN, kept nowhere).
 */
export async function createDataSource (config) {
  if (config.dataSource === 'memory') return postgresSource(await memoryPool());
  if (config.dataSource === 'nightscout') return nightscoutSource(config.nightscout);
  if (config.dataSource && config.dataSource !== 'postgres') throw new Error(`Unknown DATA_SOURCE ${config.dataSource}`);
  return postgresSource(createPool(config.databaseUrl));
}
