import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { buildInputs, interpolate, newestReading, predict, readingsBetween, run, zoneOffset } from '../src/predict/index.js';
import { PredictionRecorder } from '../src/predict/recorder.js';
import { modelProblems } from '../src/predict/store.js';
import { startServer, tokenFor } from './helpers.js';

// Synthetic readings run through a random network of the server model's
// shape (modelling/export.py): the same code paths, derived from no data.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/prediction.json', import.meta.url), 'utf8'));
const { model } = fixture;

test('inputs and outputs match the Python model on the fixture readings', () => {
  for (const c of fixture.cases) {
    const built = buildInputs(c.readings, { model });
    assert.equal(built.slot, c.slot, c.name);
    if (!c.available) {
      assert.equal(built.inputs, undefined, c.name);
      continue;
    }
    built.inputs.forEach((v, i) => assert.ok(Math.abs(v - c.inputs[i]) < 1e-9, `${c.name}: input ${i}`));
    const out = run(built.inputs, model);
    for (const key of ['mean', 'q0.1', 'q0.9']) {
      out[key].forEach((v, h) => assert.ok(Math.abs(v - c.expected[key][h]) < 1e-3, `${c.name}: ${key}[${h}]`));
    }
    assert.ok(Math.abs(out.p_low_30 - c.expected.p_low_30) < 1e-6, `${c.name}: p_low_30`);
  }
});

test('interpolation fills at most two slots at the start of a gap, like pandas', () => {
  const out = interpolate([1, NaN, NaN, NaN, 5, NaN, 7, NaN], 2);
  assert.deepEqual(out.slice(0, 7), [1, 2, 3, NaN, 5, 6, 7]);
  assert.ok(Number.isNaN(out[7]));
});

test('the fallback time zone follows summer time', () => {
  assert.equal(zoneOffset(Date.UTC(2026, 0, 15, 12), 'Europe/Zurich'), 60);
  assert.equal(zoneOffset(Date.UTC(2026, 6, 15, 12), 'Europe/Zurich'), 120);
});

test('prediction reports 15 and 30 minutes after the newest reading', () => {
  const c = fixture.cases.find((x) => x.available);
  const p = predict(c.readings, { model });
  const newest = Math.max(...c.readings.map((r) => r.date));
  assert.equal(p.available, true);
  assert.deepEqual(p.predictions.map((x) => x.minutes), [15, 30]);
  assert.equal(p.predictions[1].date, newest + 30 * 60000);
  // A random network's percentiles may cross; only a trained one orders them.
  for (const x of p.predictions) assert.ok([x.sgv, x.low, x.high].every(Number.isInteger));
  assert.equal(typeof p.lowWarning, 'boolean');
});

test('past predictions are what the readings up to then predicted for now', () => {
  const c = fixture.cases.find((x) => x.name === 'wavy, regular');
  const p = predict(c.readings, { model });
  assert.deepEqual(p.past.map((x) => x.minutes), [15, 30]);
  const newest = Math.max(...c.readings.map((r) => r.date));
  for (const x of p.past) {
    const then = predict(c.readings.filter((r) => r.date <= x.madeAt), { model });
    assert.equal(then.date, x.madeAt);
    assert.equal(newest - x.madeAt, x.minutes * 60000);
    assert.equal(x.sgv, then.predictions.find((q) => q.minutes === x.minutes).sgv);
    assert.ok(Math.abs(x.errorPercent - (x.sgv - x.actual) / x.actual * 100) < 1, `${x.minutes} min: ${x.errorPercent}%`);
  }
  // Without readings that far back there is nothing to compare.
  const short = c.readings.filter((r) => r.date > newest - 2.2 * 3600000);
  assert.deepEqual(predict(short, { model }).past.map((x) => x.minutes), [15]);
});

test('a model passes its own checks, and fails them when changed', () => {
  assert.deepEqual(modelProblems(model), []);
  const tampered = structuredClone(model);
  tampered.layers[0].bias[0] += 1;
  assert.match(modelProblems(tampered).join(), /check 0/);
  const reshaped = structuredClone(model);
  reshaped.layers.at(-1).weights.pop();
  reshaped.layers.at(-1).bias.pop();
  assert.match(modelProblems(reshaped).join(), /outputs/);
  assert.match(modelProblems({ ...model, checks: [] }).join(), /checks/);
  assert.match(modelProblems([]).join(), /JSON object/);
});

let s;
let reader;
let uploader;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });

before(async () => {
  s = await startServer();
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  uploader = await tokenFor(s.ctx, 'export', { canWrite: false, canUploadModel: true });
});
after(() => s.close());

async function addReadings (writer, end, values) {
  for (const [i, v] of values.entries()) {
    if (v == null) continue;
    const date = end - (values.length - 1 - i) * 5 * 60000;
    await request(s.app).post('/api/v3/entries').set(auth(writer))
      .send({ date, sgv: v, type: 'sgv', device: 'test', app: 'test', utcOffset: 120 }).expect(201);
  }
}

test('only model upload tokens and admins may upload, and a bad model is refused', async () => {
  const writer = await tokenFor(s.ctx, 'aaps');
  await request(s.app).put('/api/prediction/model').send(model).expect(401);
  await request(s.app).put('/api/prediction/model').set(auth(writer)).send(model).expect(403);
  const refused = await request(s.app).put('/api/prediction/model').set(auth(reader)).send(model).expect(403);
  assert.equal(refused.body.permission, 'model:upload');
  assert.match(refused.body.description, /Upload model/);
  const bad = await request(s.app).put('/api/prediction/model').set(auth(uploader)).send({ ...model, horizons: 3 }).expect(422);
  assert.ok(bad.body.problems.length);
  await request(s.app).get('/api/prediction/model').set(auth(reader)).expect(404);
});

test('a model upload token cannot read or write data', async () => {
  await request(s.app).get('/api/v3/entries').set(auth(uploader)).expect(403);
  await request(s.app).post('/api/v3/entries').set(auth(uploader))
    .send({ date: Date.now(), sgv: 100, type: 'sgv' }).expect(403);
  await request(s.app).get('/api/prediction').set(auth(uploader)).expect(403);
});

test('prediction API answers without a model, then predicts after an upload', async () => {
  const none = await request(s.app).get('/api/prediction').set(auth(reader)).expect(200);
  assert.equal(none.body.available, false);
  assert.match(none.body.reason, /no prediction model/);

  const up = await request(s.app).put('/api/prediction/model').set(auth(uploader)).send(model).expect(201);
  assert.equal(up.body.version, model.version);
  assert.equal(up.body.uploadedBy, 'export');
  const info = await request(s.app).get('/api/prediction/model').set(auth(reader)).expect(200);
  assert.equal(info.body.id, up.body.id);

  const writer = await tokenFor(s.ctx, 'uploader');
  const empty = await request(s.app).get('/api/prediction').set(auth(reader)).expect(200);
  assert.equal(empty.body.available, false);
  const end = Math.floor(Date.now() / 300000) * 300000 + 60000;
  // 2 h of readings with 20 minutes missing an hour ago.
  await addReadings(writer, end - 3 * 3600000, Array.from({ length: 26 }, (_, i) => (i >= 12 && i < 16 ? null : 150 - 2 * i)));
  const gap = await request(s.app).get('/api/prediction').set(auth(reader)).expect(200);
  assert.equal(gap.body.available, false);
  assert.match(gap.body.reason, /gap/);

  // 2 h 40 min, enough for the predictions made 15 and 30 minutes ago.
  await addReadings(writer, end, Array.from({ length: 33 }, (_, i) => 200 - 3 * i));
  const res = await request(s.app).get('/api/prediction').set(auth(reader)).expect(200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.available, true);
  assert.equal(res.body.model, model.version);
  assert.equal(res.body.date, end);
  const [p15, p30] = res.body.predictions;
  assert.equal(p15.minutes, 15);
  assert.equal(p30.date, end + 30 * 60000);
  assert.deepEqual(res.body.past.map((x) => x.minutes), [15, 30]);
  assert.ok(res.body.past.every((x) => Number.isFinite(x.errorPercent)));
});

test('a newer upload replaces the model in use', async () => {
  const next = { ...model, version: 'random-test-model-2' };
  await request(s.app).put('/api/prediction/model').set(auth(uploader)).send(next).expect(201);
  const info = await request(s.app).get('/api/prediction/model').set(auth(reader)).expect(200);
  assert.equal(info.body.version, 'random-test-model-2');
});

test('predictions are recorded once per reading and returned by the history', async () => {
  const recorded = await s.ctx.predictions.record();
  assert.ok(recorded > 0 && recorded % 2 === 0, `${recorded} rows`);
  assert.equal(await s.ctx.predictions.record(), 0);

  const newest = await newestReading(s.ctx.pool);
  const res = await request(s.app).get(`/api/prediction/history?from=${newest - 3600000}&to=${newest + 3600000}`)
    .set(auth(reader)).expect(200);
  const latest = res.body.filter((p) => p.madeAt === newest);
  assert.deepEqual(latest.map((p) => p.minutes), [15, 30]);
  const live = predict(await readingsBetween(s.ctx.pool, newest - 4 * 3600000, newest), { model: { ...model, version: 'random-test-model-2' } });
  for (const p of latest) {
    const q = live.predictions.find((x) => x.minutes === p.minutes);
    assert.equal(p.date, q.date);
    assert.equal(p.sgv, q.sgv);
  }
  assert.ok(res.body.every((p, i) => !i || res.body[i - 1].date <= p.date));
  await request(s.app).get('/api/prediction/history?from=0').set(auth(reader)).expect(400);
  await request(s.app).get('/api/prediction/history').set(auth(uploader)).expect(403);

  const writer = await tokenFor(s.ctx, 'aaps-next');
  await addReadings(writer, newest + 5 * 60000, [120]);
  assert.equal(await s.ctx.predictions.record(), 2);
});

test('a started recorder records when new readings arrive', async () => {
  const recorder = new PredictionRecorder(s.ctx, s.ctx.models, { delayMs: 10 });
  const newest = await newestReading(s.ctx.pool);
  recorder.start();
  try {
    const writer = await tokenFor(s.ctx, 'aaps-live');
    await addReadings(writer, newest + 5 * 60000, [118]);
    const count = async () => (await s.ctx.pool.query('SELECT count(*)::int AS n FROM glucose_predictions WHERE made_at = $1', [new Date(newest + 5 * 60000)])).rows[0].n;
    for (let i = 0; i < 100 && await count() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await count(), 2);
  } finally {
    await recorder.stop();
  }
});
