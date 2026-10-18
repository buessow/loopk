// The freshness monitor uses the event time for glucose readings and the
// server creation time for the remaining Nightscout collections, matching the
// former MongoDB monitor. Every column must be indexed: the monitor polls
// every ten seconds, so a table scan here is a constant load on Postgres.
export const MONITORED_COLLECTIONS = [
  { collection: 'entries', column: 'date' },
  { collection: 'heartrate', column: 'created_at' },
  { collection: 'treatments', column: 'created_at' },
  { collection: 'devicestatus', column: 'created_at' },
];

function timestampMs (value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Return the most recent source timestamp for each collection. */
export async function latestCollectionUpdates (pool) {
  return Promise.all(MONITORED_COLLECTIONS.map(async ({ collection, column }) => {
    // Collection and column come only from MONITORED_COLLECTIONS above.
    const { rows: [row] } = await pool.query(`SELECT MAX(${column}) AS timestamp FROM ${collection}`);
    return { collection, timestamp: timestampMs(row.timestamp) };
  }));
}

/**
 * Report a snapshot as Netdata StatsD gauges. The log gets a line only when a
 * collection changes, so the journal shows when each one last updated without
 * repeating the gauges every few seconds.
 */
export function reportFreshness (metrics, updates, previous = new Map(), now = Date.now()) {
  for (const { collection, timestamp } of updates) {
    if (timestamp !== null) metrics.gauge(`loopk.${collection}_sync_delay_seconds`, (now - timestamp) / 1000);
    if (previous.has(collection) && previous.get(collection) === timestamp) continue;
    previous.set(collection, timestamp);
    if (timestamp === null) console.log(`${collection} is empty`);
    else console.log(`${collection} update ${new Date(timestamp).toISOString()}, ${Math.round((now - timestamp) / 1000)}s ago`);
  }
  return previous;
}
