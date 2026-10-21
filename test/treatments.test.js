import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { CollectionStore } from '../src/db/collection.js';
import { startServer, tokenFor } from './helpers.js';

let s;
let writer;
const auth = () => ({ Authorization: `Bearer ${writer.jwt}` });
const MIN = 60000;
let next = Date.UTC(2026, 0, 1);

before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
});
after(() => s.close());

/** A time well apart from the other tests' treatments. */
function freshTime () {
  next += 6 * 3600000;
  return next;
}

let counter = 0;
async function post (doc) {
  const identifier = doc.identifier || `t-${++counter}`;
  const res = await request(s.app).post('/api/v3/treatments').set(auth())
    .send({ app: 'AAPS', device: 'phone', utcOffset: 60, identifier, ...doc }).expect((r) => assert.ok([200, 201].includes(r.status), r.text));
  assert.equal(res.body.identifier ?? identifier, identifier);
  return identifier;
}

const stored = async (identifier) => (await s.ctx.pool.query('SELECT identifier FROM treatments WHERE identifier = $1', [identifier])).rowCount === 1;
const removed = async (identifier) => (await s.ctx.pool.query(
  'SELECT duplicate_of FROM removed_treatments WHERE identifier = $1', [identifier])).rows[0]?.duplicate_of ?? null;
const delivered = async (identifier) => (await s.ctx.pool.query(
  'SELECT delivered_insulin AS u FROM treatments WHERE identifier = $1', [identifier])).rows[0].u;

test('a bolus uploaded again under another identifier is answered but kept out of treatments', async () => {
  const t = freshTime();
  const smb = await post({ eventType: 'Correction Bolus', type: 'SMB', isSMB: true, date: t, insulin: 0.4 });
  const copy = await post({ eventType: 'Meal Bolus', type: 'NORMAL', date: t + 3000, insulin: 0.4 });
  assert.ok(await stored(smb));
  assert.ok(!(await stored(copy)));
  assert.equal(await removed(copy), smb);
  await request(s.app).get(`/api/v3/treatments/${copy}`).set(auth()).expect(404);

  // Sent again, as an uploader retrying: still answered, still one copy kept away.
  await post({ identifier: copy, eventType: 'Meal Bolus', type: 'NORMAL', date: t + 3000, insulin: 0.4 });
  assert.equal(await removed(copy), smb);
  assert.equal((await s.ctx.pool.query('SELECT count(*)::int AS n FROM removed_treatments WHERE identifier = $1', [copy])).rows[0].n, 1);
});

test('the SMB stays when its copy came first', async () => {
  const t = freshTime();
  const copy = await post({ eventType: 'Meal Bolus', type: 'NORMAL', date: t, insulin: 0.6 });
  const smb = await post({ eventType: 'Correction Bolus', type: 'SMB', isSMB: true, date: t + 2500, insulin: 0.6 });
  assert.ok(await stored(smb));
  assert.equal(await removed(copy), smb);
});

test('other amounts, doses a minute apart and deleted treatments are not duplicates', async () => {
  const t = freshTime();
  const a = await post({ eventType: 'Correction Bolus', date: t, insulin: 0.4 });
  const b = await post({ eventType: 'Correction Bolus', date: t + 3000, insulin: 0.5 });
  const c = await post({ eventType: 'Correction Bolus', date: t + 90000, insulin: 0.4 });
  const primed = await post({ eventType: 'Correction Bolus', type: 'PRIMING', date: t + 1000, insulin: 0.4 });
  for (const id of [a, b, c, primed]) assert.ok(await stored(id), id);

  const later = freshTime();
  const gone = await post({ eventType: 'Correction Bolus', date: later, insulin: 1, isValid: false });
  const real = await post({ eventType: 'Correction Bolus', date: later + 2000, insulin: 1 });
  assert.ok(await stored(gone));
  assert.ok(await stored(real));
});

test('a bolus with carbs is kept over the same bolus without them', async () => {
  const t = freshTime();
  const bolus = await post({ eventType: 'Correction Bolus', date: t, insulin: 2 });
  const meal = await post({ eventType: 'Meal Bolus', date: t + 5000, insulin: 2, carbs: 30 });
  const carbs = await post({ eventType: 'Carb Correction', date: t + 8000, carbs: 30 });
  assert.ok(await stored(meal));
  assert.equal(await removed(bolus), meal);
  assert.equal(await removed(carbs), meal);
});

test('followed and imported treatments are checked for duplicates too', async () => {
  const t = freshTime();
  const store = new CollectionStore(s.ctx.pool, 'treatments');
  const doc = (identifier, extra) => ({ identifier, date: t, srvCreated: t, srvModified: t, app: 'AAPS', eventType: 'Correction Bolus', ...extra });
  const moved = await store.bulkUpsert([
    doc('bulk-smb', { type: 'SMB', isSMB: true, insulin: 0.3, srvCreated: t + 10 }),
    doc('bulk-copy', { eventType: 'Meal Bolus', insulin: 0.3, date: t + 1000 }),
    doc('bulk-other', { insulin: 1.1, date: t + 20 * MIN }),
  ]);
  assert.deepEqual(moved, ['bulk-copy']);
  assert.equal(await removed('bulk-copy'), 'bulk-smb');
  assert.ok(await stored('bulk-other'));
});

test('delivered insulin counts boluses, temp basals for the time they ran, and extended boluses once', async () => {
  const t = freshTime();
  const bolus = await post({ eventType: 'Correction Bolus', date: t, insulin: 1.5 });
  const primed = await post({ eventType: 'Correction Bolus', type: 'PRIMING', date: t + 60 * MIN, insulin: 0.7 });
  const carbs = await post({ eventType: 'Carb Correction', date: t + 61 * MIN, carbs: 20 });
  assert.equal(await delivered(bolus), 1.5);
  assert.equal(await delivered(primed), 0);
  assert.equal(await delivered(carbs), 0);

  // 1.2 U/h for 30 minutes, cut short by the next temp basal after 10.
  const temp = await post({ eventType: 'Temp Basal', date: t + 120 * MIN, durationInMilliseconds: 30 * MIN, rate: 1.2, absolute: 1.2 });
  assert.ok(Math.abs(await delivered(temp) - 0.6) < 1e-9);
  const cancel = await post({ eventType: 'Temp Basal', date: t + 130 * MIN, duration: 0 });
  assert.ok(Math.abs(await delivered(temp) - 0.2) < 1e-9);
  assert.equal(await delivered(cancel), 0);
  await request(s.app).delete(`/api/v3/treatments/${cancel}`).set(auth()).expect(200);
  assert.ok(Math.abs(await delivered(temp) - 0.6) < 1e-9, 'a deleted temp basal no longer ends the one before');
  const percent = await post({ eventType: 'Temp Basal', date: t + 200 * MIN, duration: 30, percent: 50 });
  assert.equal(await delivered(percent), null);

  // An extended bolus that a FAKE_EXTENDED temp basal emulates is delivered by that temp basal.
  const extended = await post({ eventType: 'Combo Bolus', date: t + 300 * MIN, enteredinsulin: 2, duration: 60 });
  assert.equal(await delivered(extended), 2);
  const fake = await post({
    eventType: 'Temp Basal', type: 'FAKE_EXTENDED', date: t + 300 * MIN, duration: 60, rate: 2.8, absolute: 2.8,
    extendedEmulated: { identifier: extended, eventType: 'Combo Bolus', enteredinsulin: 2, duration: 60 },
  });
  assert.equal(await delivered(extended), 0);
  assert.ok(Math.abs(await delivered(fake) - 2.8) < 1e-9);
});

test('delivered insulin is not part of the documents', async () => {
  const id = await post({ eventType: 'Correction Bolus', date: freshTime(), insulin: 0.8 });
  const res = await request(s.app).get(`/api/v3/treatments/${id}`).set(auth()).expect(200);
  assert.equal(res.body.result.insulin, 0.8);
  assert.ok(!('delivered_insulin' in res.body.result) && !('deliveredInsulin' in res.body.result));
});
