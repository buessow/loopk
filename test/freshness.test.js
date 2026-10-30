import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { MONITORED_COLLECTIONS, latestCollectionUpdates, reportFreshness } from '../src/monitoring/freshness.js';
import { createStatsd } from '../src/monitoring/statsd.js';
import { startServer } from './helpers.js';

test('latestCollectionUpdates reads the Loopk timestamps used for freshness', async () => {
  const asked = [];
  const data = {
    async latest (collection, column) {
      asked.push(`${collection}.${column}`);
      if (collection === 'entries') return 1760774400000;
      if (collection === 'heartrate') return new Date('2025-10-18T12:01:00Z');
      return null;
    },
  };

  assert.deepEqual(await latestCollectionUpdates(data), [
    { collection: 'entries', timestamp: 1760774400000 },
    { collection: 'heartrate', timestamp: 1760788860000 },
    { collection: 'treatments', timestamp: null },
    { collection: 'devicestatus', timestamp: null },
  ]);
  assert.deepEqual(asked, ['entries.date', 'heartrate.created_at', 'treatments.created_at', 'devicestatus.created_at']);
});

test('every freshness query is answered from an index', async (t) => {
  const { ctx, close } = await startServer();
  t.after(close);
  const client = await ctx.data.pool.connect();
  try {
    // Empty test tables make a table scan cheapest; forbid it so the plan only
    // falls back to one when no index can answer the query.
    await client.query('SET enable_seqscan = off');

    for (const { collection, column } of MONITORED_COLLECTIONS) {
      const { rows } = await client.query(`EXPLAIN SELECT MAX(${column}) AS timestamp FROM ${collection}`);
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.doesNotMatch(plan, /Seq Scan/, `${collection}.${column}:\n${plan}`);
    }
  } finally {
    client.release();
  }
});

test('reportFreshness sends every delay and logs each collection only when it changes', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const gauges = [];
  const metrics = { gauge: (...args) => gauges.push(args) };
  const previous = new Map();
  const updates = [
    { collection: 'entries', timestamp: 1760774400000 },
    { collection: 'treatments', timestamp: null },
  ];

  reportFreshness(metrics, updates, previous, 1760774410000);
  reportFreshness(metrics, updates, previous, 1760774420000);

  assert.deepEqual(gauges, [
    ['loopk.entries_sync_delay_seconds', 10],
    ['loopk.entries_sync_delay_seconds', 20],
  ]);
  assert.deepEqual(lines, [
    'entries update 2025-10-18T08:00:00.000Z, 10s ago',
    'treatments is empty',
  ]);
});

test('createStatsd sends gauges as StatsD lines and never negative values', async (t) => {
  const server = dgram.createSocket('udp4');
  t.after(() => server.close());
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const received = [];
  const twoMessages = new Promise((resolve) => {
    server.on('message', (message) => {
      received.push(message.toString());
      if (received.length === 2) resolve();
    });
  });

  const metrics = createStatsd({ port: server.address().port });
  metrics.gauge('loopk.entries_sync_delay_seconds', 12.5);
  metrics.gauge('loopk.heartrate_sync_delay_seconds', -3);
  await twoMessages;
  await metrics.close();

  assert.deepEqual(received.sort(), [
    'loopk.entries_sync_delay_seconds:12.5|g',
    'loopk.heartrate_sync_delay_seconds:0|g',
  ]);
});
