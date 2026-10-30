import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { signInUser } from '../src/web/session.js';

let s;
let writer;
let reader;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 0, 10);

before(async () => {
  s = await startServer({ ALLOWED_EMAILS: 'friend@example.com,other@example.com' });
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);

  await post('profile', { date: t0 - 24 * HOUR, defaultProfile: 'P', store: { P: { basal: [{ time: '00:00', timeAsSeconds: 0, value: 1 }], units: 'mg/dl' } } });
  // Hour 0: one reading in each range; hour 1: one in range.
  for (const [i, sgv] of [50, 60, 100, 200, 300].entries()) await post('entries', { type: 'sgv', date: t0 + i * 5 * MIN, sgv });
  await post('entries', { type: 'sgv', date: t0 + HOUR + 10 * MIN, sgv: 120 });
  await post('treatments', { eventType: 'Temp Basal', date: t0 + HOUR, durationInMilliseconds: 30 * MIN, absolute: 3, rate: 3 });
  await post('treatments', { eventType: 'Meal Bolus', date: t0 + 2 * HOUR + 10 * MIN, insulin: 2, carbs: 30 });
  await post('heartrate', { date: t0 + 20 * MIN, beatsPerMinute: 80 });
  await post('heartrate', { date: t0 + 25 * MIN, beatsPerMinute: 90 });
});
after(() => s.close());

async function cookieFor (email) {
  const user = await signInUser(s.ctx.data, s.ctx.config, { email });
  return `${s.ctx.auth.sessionCookieName()}=${s.ctx.auth.signSession(user)}`;
}

test('hourly totals count readings by range and add up delivered insulin, carbs and heart rate', async () => {
  const res = await request(s.app).get(`/api/reports/hours?from=${t0 - 5 * HOUR}&to=${t0 + 3 * HOUR}&tz=Europe/Zurich`)
    .set(auth(reader)).expect(200);
  const rows = res.body.rows.map((r) => Object.fromEntries(res.body.columns.map((c, i) => [c, r[i]])));
  // From the first reading on.
  assert.equal(res.body.from, t0);
  assert.deepEqual(rows.map((r) => r.hour * HOUR), [t0, t0 + HOUR, t0 + 2 * HOUR]);
  assert.deepEqual(rows.map((r) => r.offset), [60, 60, 60]);

  assert.deepEqual([rows[0].readings, rows[0].veryLow, rows[0].low, rows[0].target, rows[0].high, rows[0].veryHigh], [5, 1, 1, 1, 1, 1]);
  assert.equal(rows[0].sgvSum, 710);
  assert.equal(rows[0].sgvSquares, 50 ** 2 + 60 ** 2 + 100 ** 2 + 200 ** 2 + 300 ** 2);
  assert.deepEqual([rows[1].readings, rows[1].target], [1, 1]);
  assert.equal(rows[2].readings, 0);

  // 1 U/h profile; 3 U/h for the first half of hour 1.
  assert.deepEqual(rows.map((r) => r.profileBasal), [1, 1, 1]);
  assert.deepEqual(rows.map((r) => r.basal), [1, 2, 1]);
  assert.deepEqual(rows.map((r) => r.bolus), [0, 0, 2]);
  assert.deepEqual(rows.map((r) => r.carbs), [0, 0, 30]);
  assert.deepEqual([rows[0].hrCount, rows[0].hrSum], [2, 170]);
});

test('hourly totals need read access and a known time zone', async () => {
  await request(s.app).get('/api/reports/hours').expect(401);
  await request(s.app).get('/api/reports/hours?tz=Mars/Base').set(auth(reader)).expect(400);
  await request(s.app).get(`/api/reports/hours?from=${t0}&to=${t0 - 1}`).set(auth(reader)).expect(400);
  const none = await request(s.app).get(`/api/reports/hours?from=${t0 - 10 * HOUR}&to=${t0 - 5 * HOUR}`).set(auth(reader)).expect(200);
  assert.deepEqual(none.body.rows, []);
});

test('each person keeps their own dashboard', async () => {
  const friend = await cookieFor('friend@example.com');
  const other = await cookieFor('other@example.com');
  await request(s.app).get('/api/reports/dashboard').set('Cookie', friend).expect(204);

  const dashboard = { version: 1, period: { preset: '30d' }, widgets: [{ id: 'a', metric: 'tir', group: 'day', display: 'bar', x: 0, y: 0, w: 6, h: 4 }] };
  await request(s.app).put('/api/reports/dashboard').set('Cookie', friend).send(dashboard).expect(204);
  assert.deepEqual((await request(s.app).get('/api/reports/dashboard').set('Cookie', friend).expect(200)).body, dashboard);
  await request(s.app).get('/api/reports/dashboard').set('Cookie', other).expect(204);

  const changed = { ...dashboard, widgets: [] };
  await request(s.app).put('/api/reports/dashboard').set('Cookie', friend).send(changed).expect(204);
  assert.deepEqual((await request(s.app).get('/api/reports/dashboard').set('Cookie', friend).expect(200)).body, changed);

  await request(s.app).put('/api/reports/dashboard').set('Cookie', friend).send({ widgets: 'none' }).expect(400);
  await request(s.app).put('/api/reports/dashboard').set('Cookie', friend).send([1]).expect(400);
});

test('access tokens have no dashboard', async () => {
  await request(s.app).get('/api/reports/dashboard').expect(401);
  await request(s.app).get('/api/reports/dashboard').set(auth(reader)).expect(403);
  await request(s.app).put('/api/reports/dashboard').set(auth(writer)).send({ widgets: [] }).expect(403);
});

test('the reports page is served', async () => {
  const res = await request(s.app).get('/reports').expect(200);
  assert.match(res.text, /reports\.js/);
});
