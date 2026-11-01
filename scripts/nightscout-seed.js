// Copies the last days of one Nightscout (or loopk) to another through API
// v3, as AAPS uploads them: entries, treatments, device status and heart
// rate of the period, and the profile store documents. For filling the test
// Nightscout (nightscout-test.sh) with real-shaped data.
//
//   SOURCE_URL=… SOURCE_TOKEN=… [TARGET_URL=… TARGET_TOKEN=…] \
//     node scripts/nightscout-seed.js [days=14]
//
// TARGET_URL defaults to the test Nightscout (NS_URL in .cache/nightscout.env)
// and TARGET_TOKEN to its NS_ADMIN_TOKEN. The
// data is health data: keep the target on this machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NightscoutClient } from '../src/sync/client.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.cache', 'nightscout.env');
const local = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)))
  : {};

const days = Number(process.argv[2] || 14);
const source = new NightscoutClient({ url: process.env.SOURCE_URL || '', token: process.env.SOURCE_TOKEN || '', pageSize: 500 });
const testUrl = local.NS_URL || 'http://localhost:1340';
const targetUrl = process.env.TARGET_URL || testUrl;
// The test Nightscout's token only for the test Nightscout.
const target = new NightscoutClient({ url: targetUrl, token: process.env.TARGET_TOKEN || (targetUrl === testUrl ? local.NS_ADMIN_TOKEN : '') || '' });
if (!source.url || !source.token || !target.token) {
  console.error('usage: SOURCE_URL=… SOURCE_TOKEN=… [TARGET_URL=… TARGET_TOKEN=…] node scripts/nightscout-seed.js [days]');
  process.exit(2);
}

// What the server sets itself, and loopk's own fields.
const SERVER_FIELDS = ['_id', 'srvCreated', 'srvModified', 'subject', 'modifiedBy', 'isValid', 'isReadOnly'];
const clean = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !SERVER_FIELDS.includes(k)));

async function copy (collection, docs) {
  let done = 0;
  let failed = 0;
  let missing = false;
  const queue = [...docs];
  const worker = async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      try {
        await target.post(`/api/v3/${collection}`, { app: 'loopk-seed', ...clean(doc) });
        done++;
      } catch (err) {
        if (/HTTP 404 \(Bad operation or collection\)/.test(err.message)) {
          queue.length = 0;
          missing = true;
          return;
        }
        if (failed++ < 3) console.warn(`  ${collection} ${doc.identifier}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (missing) return console.log(`${collection}: ${target.url} has no such collection`);
  console.log(`${collection}: ${done} copied${failed ? `, ${failed} failed` : ''}`);
}

await source.check();
await target.check();
const from = Date.now() - days * 24 * 3600 * 1000;
const field = { entries: 'date', treatments: 'created_at', devicestatus: 'date', heartrate: 'date' };
await copy('profile', await source.search('profile', {}));
for (const [collection, f] of Object.entries(field)) {
  const value = f === 'created_at' ? new Date(from).toISOString() : from;
  let docs;
  try {
    docs = await source.search(collection, { [`${f}$gte`]: value });
  } catch (err) {
    console.warn(`${collection}: not read (${err.message})`);
    continue;
  }
  await copy(collection, docs);
}
