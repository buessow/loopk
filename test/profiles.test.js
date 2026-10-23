import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';

let s;
let reader;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 1, 1);
const flat = (value) => ({ basal: [{ time: '00:00', timeAsSeconds: 0, value }], units: 'mg/dl' });

before(async () => {
  s = await startServer();
  const writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);

  await post('profile', { date: t0 - 2 * DAY, defaultProfile: 'P', store: { P: flat(1) } });
  await post('treatments', { eventType: 'Profile Switch', date: t0 - DAY, profile: 'P', percentage: 100, duration: 0 });
  await post('entries', { type: 'sgv', date: t0, sgv: 120 });
  // Day 0: a 3 U/h temp basal from 2:00 to 3:00 and an SMB.
  await post('treatments', { eventType: 'Temp Basal', date: t0 + 2 * HOUR, durationInMilliseconds: HOUR, absolute: 3, rate: 3 });
  await post('treatments', { eventType: 'Correction Bolus', date: t0 + 5 * HOUR + 10 * MIN, insulin: 0.5, isSMB: true, type: 'SMB' });
  // Loop runs with a sensitivity ratio of 1.2 every 10 minutes until 2:50; it holds for 30 minutes.
  for (let m = 0; m < 180; m += 10) {
    await post('devicestatus', { date: t0 + m * MIN, device: 'openaps://phone', openaps: { suggested: { sensitivityRatio: 1.2 } } });
  }
  // Day 1: 150% from 6:00 to 8:00, then back to 100%.
  await post('treatments', { eventType: 'Profile Switch', date: t0 + DAY + 6 * HOUR, profile: 'P', percentage: 150, duration: 120 });
  // P edited to 2 U/h and switched to on day 2.
  await post('profile', { date: t0 + DAY + 12 * HOUR, defaultProfile: 'P', store: { P: flat(2) } });
  await post('treatments', { eventType: 'Profile Switch', date: t0 + 2 * DAY, profile: 'P', percentage: 100, duration: 0 });
});
after(() => s.close());

test('profile usage splits time and insulin by profile version and percentage', async () => {
  const res = await request(s.app).get(`/api/reports/profiles?from=${t0 - DAY}&to=${t0 + 3 * DAY}&tz=UTC`)
    .set(auth(reader)).expect(200);
  // From the first reading on.
  assert.equal(res.body.from, t0);
  assert.equal(res.body.minutes, 3 * 1440);
  const [v2, v1] = res.body.profiles;
  assert.equal(res.body.profiles.length, 2);

  assert.deepEqual([v2.name, v2.current, v2.firstSeen, v2.schedule], ['P', true, t0 + 2 * DAY, [[0, 2]]]);
  assert.deepEqual(v2.pcts.map((u) => [u.pct, u.minutes, u.basal, u.bolus]), [[100, 1440, 48, 0]]);
  assert.deepEqual(v2.pcts[0].days, { n: 1, sum: 48, sumSq: 48 * 48 });

  assert.deepEqual([v1.name, v1.current, v1.firstSeen, v1.lastSeen], ['P', false, t0, t0 + 2 * DAY - MIN]);
  // Day 0: 23 h at 1 U/h and 1 h at 3 U/h; day 1: 22 h at 1 U/h and 2 h at 1.5 U/h.
  assert.deepEqual(v1.pcts.map((u) => [u.pct, u.minutes, u.basal, u.bolus]), [[100, 2760, 48, 0.5], [150, 120, 3, 0]]);
  // Only day 0 lies wholly under 100%.
  assert.deepEqual(v1.pcts[0].days, { n: 1, sum: 26.5, sumSq: 26.5 * 26.5 });
  assert.deepEqual(v1.pcts[1].days, { n: 0, sum: 0, sumSq: 0 });

  const [p100, p150] = v1.pcts;
  assert.deepEqual(p100.hours[2].basal, { n: 2, sum: 4, sumSq: 10 });
  assert.deepEqual(p100.hours[5].bolus, { n: 2, sum: 0.5, sumSq: 0.25 });
  assert.equal(p100.hours[6].basal.n, 1);
  assert.deepEqual(p150.hours[6].basal, { n: 1, sum: 1.5, sumSq: 2.25 });
  assert.equal(p150.hours[8].basal.n, 0);

  // The ratio in hours 0-2 of day 0 (3:00-3:19 is too little of hour 3).
  assert.deepEqual(p100.sensitivity, { minutes: 200, sum: 240 });
  assert.deepEqual(p100.hours[0].ratio, { n: 1, sum: 1.2, sumSq: 1.44 });
  assert.deepEqual(p100.hours[2].ratio, { n: 1, sum: 1.2, sumSq: 1.44 });
  assert.equal(p100.hours[3].ratio.n, 0);
  assert.deepEqual(v2.pcts[0].sensitivity, { minutes: 0, sum: 0 });
});

test('profile usage rejects a bad time zone', async () => {
  await request(s.app).get('/api/reports/profiles?tz=Nowhere/Else').set(auth(reader)).expect(400);
});
