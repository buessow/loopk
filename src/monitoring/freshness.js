// The freshness monitor uses the event time for glucose readings and the
// server creation time for the remaining Nightscout collections, matching the
// former MongoDB monitor.
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

/** Report a snapshot to New Relic, preserving the former monitor's names. */
export function reportFreshness (newrelic, updates, previous = new Map(), now = Date.now()) {
  for (const { collection, timestamp } of updates) {
    if (timestamp === null) {
      console.log(`${collection} is empty`);
      continue;
    }

    const date = new Date(timestamp);
    const delay = now - timestamp;
    console.log(`${collection}_datetime ${date.toISOString()}`);
    console.log(`${collection}_delay_ms ${delay}`);
    newrelic.recordMetric(`nightscout_${collection}_last`, timestamp);
    newrelic.recordMetric(`nightscout_${collection}_sync_delay`, delay);

    if (previous.get(collection) === timestamp) continue;
    newrelic.recordLogEvent({
      message: `${collection} update ${date.toISOString()}`,
      level: 'INFO',
      timestamp,
    });
    newrelic.recordCustomEvent(`nightscout:update:${collection}`, {
      time: timestamp,
      timeStr: date.toISOString(),
    });
    previous.set(collection, timestamp);
  }
  return previous;
}
