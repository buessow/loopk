import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { nightscoutSource } from '../src/data/nightscout/index.js';
import { Coverage } from '../src/data/nightscout/coverage.js';
import { hourlyTotals } from '../src/reports/index.js';
import { profileAt } from '../src/analysis/context.js';
import { findMisses } from '../src/analysis/misses.js';
import { createApp, createContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Another loopk plays the Nightscout server: what the Nightscout source
// answers from its in-memory copy must match what that server's own
// Postgres source answers.
let s;
let writer;
let reader;
let ns;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 10);
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });
let post;

before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'viewer', { canWrite: false });
  post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);

  await post('profile', {
    date: t0 - 10 * DAY,
    defaultProfile: 'P',
    store: {
      P: {
        units: 'mg/dl', dia: 5, timezone: 'UTC', basal: [entry('00:00', 1)], sens: [entry('00:00', 100)],
        carbratio: [entry('00:00', 10)], target_low: [entry('00:00', 100)], target_high: [entry('00:00', 110)],
      },
    },
  });
  // Readings over three days, and a low on the second.
  for (let m = 0; m < 3 * 24 * 60; m += 30) {
    const low = m >= 24 * 60 + 60 && m < 24 * 60 + 120;
    await post('entries', { type: 'sgv', date: t0 + m * MIN, sgv: low ? 55 : 120 + (m % 120) / 2, device: 'G7' });
  }
  for (const day of [0, 1, 2]) {
    await post('treatments', { eventType: 'Meal Bolus', date: t0 + day * DAY + 8 * HOUR, insulin: 4, carbs: 40 });
    await post('treatments', { eventType: 'Temp Basal', date: t0 + day * DAY + 2 * HOUR, durationInMilliseconds: 30 * MIN, absolute: 2, rate: 2 });
  }
  await post('treatments', { eventType: 'Correction Bolus', date: t0 + DAY + 30 * MIN, insulin: 1, type: 'SMB', isSMB: true });
  for (let m = 0; m < 2 * 24 * 60; m += 60) {
    const run = { bg: 120, eventualBG: 130, targetBG: 100, sensitivityRatio: 1.1, IOB: 0.5, COB: 0, rate: 1, duration: 30, reason: 'Eventual BG 130 > 100', algorithm: 'SMB' };
    await post('devicestatus', { date: t0 + m * MIN, device: 'openaps://phone', openaps: { suggested: { ...run, deliverAt: new Date(t0 + m * MIN).toISOString() } } });
  }
  await post('heartrate', { date: t0 + 20 * MIN, beatsPerMinute: 80 });
  // A switch before the first reading, and a temporary 150% on the second day.
  const profileJson = JSON.stringify({ units: 'mg/dl', dia: 5, timezone: 'UTC', basal: [entry('00:00', 0.8)], sens: [entry('00:00', 90)], carbratio: [entry('00:00', 9)], target_low: [entry('00:00', 100)], target_high: [entry('00:00', 100)] });
  await post('treatments', { eventType: 'Profile Switch', date: t0 - 5 * DAY, profile: 'P', duration: 0, percentage: 100, profileJson });
  await post('treatments', { eventType: 'Profile Switch', date: t0 + DAY + 6 * HOUR, profile: 'P', duration: 120, percentage: 150, profileJson });

  ns = await nightscoutSource({ url: s.url, token: reader.accessToken, pageSize: 50 });
});
after(async () => {
  await ns?.close();
  await s.close();
});

test('coverage keeps loaded ranges merged and names the gaps', () => {
  const c = new Coverage();
  c.add(10, 20);
  c.add(30, 40);
  assert.deepEqual(c.gaps(0, 50), [[0, 10], [20, 30], [40, 50]]);
  c.add(15, 35);
  assert.deepEqual(c.ranges, [[10, 40]]);
  assert.deepEqual(c.gaps(12, 38), []);
});

test('the Nightscout source answers as the server it reads, loading only the ranges asked for', async () => {
  const day = [t0, t0 + DAY];
  assert.deepEqual(await ns.glucose.between(...day), await s.ctx.data.glucose.between(...day));
  // the first day of readings (and the day the latest-before lookups need), not the rest
  assert.deepEqual(ns.loader.coverage.entries.ranges, [[t0, t0 + DAY]]);

  // a longer period adds only what was missing
  const all = { from: t0 - DAY, to: t0 + 3 * DAY, timeZone: 'Europe/Zurich', now: t0 + 4 * DAY };
  assert.deepEqual(await hourlyTotals(ns, all), await hourlyTotals(s.ctx.data, all));
  assert.deepEqual(ns.loader.coverage.entries.ranges, [[t0, t0 + 3 * DAY]]);

  assert.deepEqual(await findMisses(ns, { from: t0, to: t0 + 2 * DAY }), await findMisses(s.ctx.data, { from: t0, to: t0 + 2 * DAY }));
  assert.ok((await findMisses(ns, { from: t0, to: t0 + 2 * DAY })).length > 0);
  for (const t of [t0 + DAY, t0 + DAY + 7 * HOUR]) assert.deepEqual(await profileAt(ns, t), await profileAt(s.ctx.data, t));
  assert.equal((await profileAt(ns, t0 + DAY)).date, t0 - 5 * DAY);
  for (const [a, b] of [[t0, t0 + DAY], [t0 + DAY, t0 + 2 * DAY]]) {
    const model = await ns.treatments.forModel(a, b);
    assert.deepEqual(model, await s.ctx.data.treatments.forModel(a, b));
    assert.ok(model.profileSwitches.length > 0);
  }
  assert.deepEqual(await ns.loop.runs(t0, t0 + DAY), await s.ctx.data.loop.runs(t0, t0 + DAY));
});

test('changes on the server arrive with the next refresh', async () => {
  const t = t0 + 12 * HOUR + 1000;
  await post('entries', { type: 'sgv', date: t, sgv: 222, device: 'G7' });
  const at = async () => (await ns.glucose.between(t, t + 1)).map((r) => r.sgv);
  assert.deepEqual(await at(), []);
  ns.loader.refreshed = 0;
  assert.deepEqual(await at(), [222]);
});

test('searches of the glucose page load their range; writes go to the server, which must allow them', async () => {
  const docs = await ns.collection('entries').findMany({ filter: [{ field: 'date', operator: 'gte', value: t0 + 2 * DAY }, { field: 'date', operator: 'lt', value: t0 + 2 * DAY + HOUR }], sort: { date: 1 }, onlyValid: true });
  assert.equal(docs.length, 2);

  const note = { identifier: 'ns-note-1', eventType: 'Note', notes: 'from loopk', date: t0 + DAY, created_at: new Date(t0 + DAY).toISOString(), app: 'test' };
  await assert.rejects(ns.collection('treatments').insert(note), /HTTP 403/);
  const rw = await nightscoutSource({ url: s.url, token: writer.accessToken });
  try {
    const stored = await rw.collection('treatments').insert(note);
    assert.equal(stored.notes, 'from loopk');
    assert.equal((await s.ctx.data.collection('treatments').findOne('ns-note-1')).notes, 'from loopk');
    await assert.rejects(async () => rw.collection('treatments').patch('ns-note-1', {}), /changes it there only/);
  } finally {
    await rw.close();
  }
});

test('a loopk over a Nightscout source takes no changes through its own API', async () => {
  const config = loadConfig({ DATA_SOURCE: 'nightscout', ADMIN_EMAILS: 'admin@example.com' });
  const ctx = await createContext(config, ns);
  const app = createApp(ctx);
  const token = await tokenFor(ctx, 'phone');
  await request(app).post('/api/v3/entries').set(auth(token)).send({ type: 'sgv', date: t0, sgv: 100, app: 'test' }).expect(403);
  const { body } = await request(app).get(`/api/v3/entries?date$gte=${t0}&date$lt=${t0 + HOUR}&sort=date`).set(auth(token)).expect(200);
  assert.deepEqual(body.result.map((d) => d.sgv), [120, 135]);
  assert.equal((await request(app).get('/api/v3/version').expect(200)).body.result.storage.storage, 'nightscout');
});

test('a wrong token is refused before anything is loaded', async () => {
  await assert.rejects(nightscoutSource({ url: s.url, token: 'nope-0000' }), /did not accept the access token/);
});

test('a collection the server does not have, as Nightscout has no heart rate, reads as empty', async () => {
  const fetch = (url, options) => (String(url).includes('/api/v3/heartrate')
    ? Promise.resolve(new Response(JSON.stringify({ status: 404, message: 'Bad operation or collection' }), { status: 404 }))
    : globalThis.fetch(url, options));
  const plain = await nightscoutSource({ url: s.url, token: reader.accessToken, fetch });
  try {
    assert.deepEqual(await plain.heartrate.between(t0, t0 + DAY), []);
    plain.loader.refreshed = 0;
    assert.equal((await plain.glucose.between(t0, t0 + HOUR)).length, 2);
  } finally {
    await plain.close();
  }
});
