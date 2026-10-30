import { createDataSource } from '../src/data/index.js';
import { latestCollectionUpdates, reportFreshness } from '../src/monitoring/freshness.js';
import { createStatsd } from '../src/monitoring/statsd.js';

const intervalMs = Math.max(1000, Number(process.env.MONITOR_INTERVAL_MS) || 10000);
const data = await createDataSource({ databaseUrl: process.env.DATABASE_URL });
const metrics = createStatsd({
  host: process.env.STATSD_HOST || undefined,
  port: Number(process.env.STATSD_PORT) || undefined,
});
const previous = new Map();
let stopping = false;
let wake;

async function monitorOnce () {
  try {
    const updates = await latestCollectionUpdates(data);
    reportFreshness(metrics, updates, previous);
  } catch (err) {
    console.error('Unable to query Loopk freshness', err);
  }
}

function wait (milliseconds) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      wake = null;
      resolve();
    }, milliseconds);
    wake = () => {
      clearTimeout(timeout);
      wake = null;
      resolve();
    };
  });
}

function stop () {
  if (stopping) return;
  stopping = true;
  wake?.();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  while (!stopping) {
    await monitorOnce();
    if (!stopping) await wait(intervalMs);
  }
} finally {
  await data.close();
  await metrics.close();
}
