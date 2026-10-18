import test from 'node:test';
import assert from 'node:assert/strict';
import { latestCollectionUpdates, reportFreshness } from '../src/monitoring/freshness.js';

test('latestCollectionUpdates queries the Loopk timestamps used for freshness', async () => {
  const queries = [];
  const pool = {
    async query (sql) {
      queries.push(sql);
      if (sql.includes('entries')) return { rows: [{ timestamp: 1760774400000 }] };
      if (sql.includes('heartrate')) return { rows: [{ timestamp: new Date('2025-10-18T12:01:00Z') }] };
      return { rows: [{ timestamp: null }] };
    },
  };

  assert.deepEqual(await latestCollectionUpdates(pool), [
    { collection: 'entries', timestamp: 1760774400000 },
    { collection: 'heartrate', timestamp: 1760788860000 },
    { collection: 'treatments', timestamp: null },
    { collection: 'devicestatus', timestamp: null },
  ]);
  assert.deepEqual(queries, [
    'SELECT MAX(date) AS timestamp FROM entries',
    'SELECT MAX(created_at) AS timestamp FROM heartrate',
    'SELECT MAX(created_at) AS timestamp FROM treatments',
    'SELECT MAX(created_at) AS timestamp FROM devicestatus',
  ]);
});

test('reportFreshness records every delay and emits events only for a new update', () => {
  const calls = { metrics: [], logs: [], events: [] };
  const newrelic = {
    recordMetric: (...args) => calls.metrics.push(args),
    recordLogEvent: (event) => calls.logs.push(event),
    recordCustomEvent: (...args) => calls.events.push(args),
  };
  const previous = new Map();
  const updates = [{ collection: 'entries', timestamp: 1760774400000 }];

  reportFreshness(newrelic, updates, previous, 1760774410000);
  reportFreshness(newrelic, updates, previous, 1760774420000);

  assert.deepEqual(calls.metrics, [
    ['nightscout_entries_last', 1760774400000],
    ['nightscout_entries_sync_delay', 10000],
    ['nightscout_entries_last', 1760774400000],
    ['nightscout_entries_sync_delay', 20000],
  ]);
  assert.equal(calls.logs.length, 1);
  assert.deepEqual(calls.events, [[
    'nightscout:update:entries',
    { time: 1760774400000, timeStr: '2025-10-18T08:00:00.000Z' },
  ]]);
});
