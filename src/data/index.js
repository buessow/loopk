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

import { createPool } from './postgres/pool.js';
import { postgresSource } from './postgres/index.js';

export { BadFilterError, REMOVED } from './postgres/collection.js';

/** The data source for `config` (DATABASE_URL), or over an existing pool. */
export function createDataSource (config, pool = createPool(config.databaseUrl)) {
  return postgresSource(pool);
}
