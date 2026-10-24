import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { doubledAt, episodes, loopMisses, reasonPredictions, runLimits } from '../src/analysis/misses.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 9, 24, 4);
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });

// Glucose (mg/dL) every 5 minutes from `start`, linear between [minute, value] points.
function curve (start, points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [m0, v0] = points[i];
    const [m1, v1] = points[i + 1];
    for (let m = m0; m < m1; m += 5) out.push({ date: start + m * MIN, sgv: Math.round(v0 + (v1 - v0) * (m - m0) / (m1 - m0)) });
  }
  const [m, v] = points[points.length - 1];
  out.push({ date: start + m * MIN, sgv: v });
  return out;
}

// Rescue carbs at 72 mg/dL, 2 U of SMB for them, a rise to 125 and a low of 55 within the hour.
const RESCUE = curve(t0, [[-60, 90], [0, 72], [30, 125], [70, 55], [80, 55], [120, 100], [190, 110]]);
const RESCUE_SMBS = [10, 15, 20, 25].map((m) => ({ date: t0 + m * MIN, insulin: 0.5, smb: true }));
const RESCUE_REASON = 'COB: 20, Dev: 1.0, ISF: 5.6, CR: 9, Target: 6.1, minPredBG 7.0, minGuardBG 5.0, IOBpredBG 3.0, COBpredBG 12.0; Eventual BG 12.0 >= 6.1, insulinReq 0.9. Microbolusing 0.5U.';

test('SMBs for rescue carbs before a second low count as a miss', () => {
  const runs = RESCUE_SMBS.map((s) => ({ date: s.date, bg: 80, eventual_bg: 216, target_bg: 110, isf: 100, insulin_req: 0.9, reason: RESCUE_REASON }));
  const [miss, ...rest] = loopMisses({ readings: RESCUE, treatments: [{ date: t0, carbs: 20 }, ...RESCUE_SMBS], runs });
  assert.equal(rest.length, 0);
  assert.equal(miss.kind, 'low');
  assert.equal(miss.glucose, 55);
  assert.equal(miss.smb, 2);
  assert.equal(miss.smbAfterRescue, 2);
  assert.equal(miss.rescueCarbs, 20);
  assert.deepEqual(miss.flags, ['SMBs after rescue carbs']);
  // (110 - 55) / 100: the insulin that took glucose from the target to the low.
  assert.equal(miss.excess, 0.55);
  // The loop allowed for 5.0 mmol/L (90 mg/dL) at the lowest.
  assert.equal(miss.expected.minGuardBG, 90);
  assert.equal(miss.missedBy, 35);
});

test('a low with too little SMB to explain it is not a miss', () => {
  const smbs = [{ date: t0 + 10 * MIN, insulin: 0.3, smb: true }];
  assert.deepEqual(loopMisses({ readings: RESCUE, treatments: smbs, runs: [] }), []);
  // 2 U, but at an ISF of 400 mg/dL/U they explain only 0.14 U of the low.
  const runs = RESCUE_SMBS.map((s) => ({ date: s.date, target_bg: 110, isf: 400, reason: RESCUE_REASON }));
  assert.deepEqual(loopMisses({ readings: RESCUE, treatments: RESCUE_SMBS, runs }), []);
});

test('a high the loop dosed for far too mildly counts as underestimated', () => {
  const readings = curve(t0, [[-90, 140], [0, 185], [60, 300], [120, 200], [180, 150]]);
  const runs = [];
  for (let m = -60; m <= 0; m += 5) {
    runs.push({ date: t0 + m * MIN, bg: 160, eventual_bg: 180, target_bg: 100, isf: 50, reason: 'COB: 0, Dev: 2, ISF: 50, Target: 100, minPredBG 140, minGuardBG 120; Eventual BG 180 >= 100, insulinReq 0.8' });
  }
  const smbs = [{ date: t0 - 30 * MIN, insulin: 0.4, smb: true }];
  const [miss] = loopMisses({ readings, treatments: smbs, runs });
  assert.equal(miss.kind, 'high');
  assert.equal(miss.glucose, 300);
  assert.equal(miss.dosedFor, 140);
  assert.equal(miss.smb, 0.4);
  assert.deepEqual(miss.flags, ['underestimated', 'no carbs logged']);
  // (300 - 140) / 50: what the loop would have asked for had it seen the peak.
  assert.equal(miss.missing, 3.2);

  // Expecting nearly the peak is not a miss.
  const seen = runs.map((r) => ({ ...r, eventual_bg: 290, reason: 'Target: 100, minPredBG 280' }));
  assert.deepEqual(loopMisses({ readings, treatments: smbs, runs: seen }), []);
});

test('lows a few minutes apart are one episode, a gap in readings splits them', () => {
  const readings = [[0, 65], [5, 60], [10, 85], [15, 66], [20, 64], [25, 90], [80, 60], [85, 62]]
    .map(([m, sgv]) => ({ date: t0 + m * MIN, sgv }));
  const lows = episodes(readings, { below: 70, end: 80 });
  assert.deepEqual(lows.map((e) => [(e.start - t0) / MIN, (e.end - t0) / MIN, e.extreme, e.readings]), [[0, 20, 60, 4], [80, 85, 60, 2]]);
});

test('reason predictions are read in mg/dL whatever units the profile has', () => {
  assert.deepEqual(reasonPredictions({ target_bg: 110, reason: RESCUE_REASON }), { minPredBG: 126, minGuardBG: 90, IOBpredBG: 54, COBpredBG: 216, UAMpredBG: null });
  assert.equal(reasonPredictions({ target_bg: 100, reason: 'Target: 100, minPredBG 85, minGuardBG -12;' }).minGuardBG, -12);
  assert.equal(reasonPredictions({ reason: 'no temp required' }).minPredBG, null);
});

test('the limits a run hit are read from its reason, with the setting behind the SMB size', () => {
  const uam = 'COB: 0, Dev: 8.1, ISF: 1.3, CR: 9.15, Target: 5.9, minPredBG 12.4, minGuardBG 11.8; Eventual BG 18.3 >= 5.9, max_iob 10.0,  insulinReq 4.954; maxBolus 0.6. Microbolusing 0.6U.';
  assert.deepEqual(runLimits({ iob: 9.5, cob: 0, reason: uam }), [{ kind: 'uamSmbSize', value: 0.6 }, { kind: 'maxIob', value: 10 }]);
  // 40 g on board at CR 10 need 4 U: with 3 U IOB the meal setting applies.
  const meal = 'COB: 40, Dev: 2.0, CR: 10, Target: 5.6; Eventual BG 12.4 >= 5.6,  insulinReq 1.73; maxBolus 0.4. Microbolusing 0.4U. adj. req. rate: 4.63 to maxSafeBasal: 3.4, temp 3.05 < 3.4U/hr.';
  assert.deepEqual(runLimits({ iob: 3, cob: 40, reason: meal }), [{ kind: 'smbSize', value: 0.4 }, { kind: 'maxBasal', value: 3.4 }]);
  assert.deepEqual(runLimits({ reason: 'Eventual BG 7.0 >= 6.0, insulinReq 0.2. Microbolusing 0.1U.' }), []);
  // Max IOB 0 while AAPS saw doubled readings.
  const zero = 'Target: 6.3; Eventual BG 22.3 >= 6.8, IOB 1.25 > max_iob 0.0; setting current basal of 0.99 as temp.';
  assert.deepEqual(runLimits({ reason: zero, doubled: true }), [{ kind: 'duplicates', value: 0 }]);
  assert.deepEqual(runLimits({ reason: zero }), [{ kind: 'maxIob', value: 0 }]);
});

test('doubled readings are two of the newest 11 at most 20 s apart, as AAPS checks', () => {
  const times = [];
  for (let m = 0; m <= 120; m += 5) times.push(t0 + m * MIN);
  times.splice(7, 0, t0 + 30 * MIN + 15000);
  times.sort((a, b) => a - b);
  assert.equal(doubledAt(times, t0 + 25 * MIN), false);
  assert.equal(doubledAt(times, t0 + 31 * MIN), true);
  // 10 readings later the pair is still among the newest 11, one more and it is out.
  assert.equal(doubledAt(times, t0 + 75 * MIN), true);
  assert.equal(doubledAt(times, t0 + 80 * MIN), false);
});

test('a high is marked as caused by duplicate readings when they alone held the loop back', () => {
  const readings = curve(t0, [[-90, 140], [0, 185], [60, 300], [120, 200], [180, 150]]);
  // A second reading 10 s after the one 30 minutes before the rise.
  const readingTimes = [...readings.map((r) => r.date), t0 - 30 * MIN + 10000].sort((a, b) => a - b);
  const runs = [];
  for (let m = -60; m <= 0; m += 5) {
    const limited = m >= -25 ? ' IOB 1.2 > max_iob 0.0; setting current basal of 1.0 as temp.' : '';
    runs.push({ date: t0 + m * MIN, bg: 180, eventual_bg: 290, target_bg: 100, isf: 50, reason: `Target: 100, minPredBG 280; Eventual BG 290 >= 100,${limited}` });
  }
  const [miss] = loopMisses({ readings, treatments: [], runs, readingTimes });
  assert.equal(miss.kind, 'high');
  assert.equal(miss.causedByDuplicates, true);
  assert.deepEqual(miss.flags, ['caused by duplicate readings', 'no carbs logged']);
  assert.deepEqual(miss.limits, [{ kind: 'duplicates', runs: 6, value: 0 }]);
  // Without the second reading it is max IOB 0 of unknown cause.
  const [plain] = loopMisses({ readings, treatments: [], runs });
  assert.equal(plain.causedByDuplicates, false);
  assert.deepEqual(plain.flags, ['max IOB reached', 'no carbs logged']);
  // Underestimated as well: the duplicates only add to it.
  const low = runs.map((r) => ({ ...r, eventual_bg: 180, reason: r.reason.replace('minPredBG 280', 'minPredBG 140') }));
  const [both] = loopMisses({ readings, treatments: [], runs: low, readingTimes });
  assert.equal(both.causedByDuplicates, false);
  assert.deepEqual(both.flags, ['underestimated', 'duplicate readings', 'no carbs logged']);
});

let s;
let writer;
let reader;
before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);
  for (const r of RESCUE) {
    await post('entries', { type: 'sgv', date: r.date, sgv: r.sgv, device: 'G7 Native' });
    // AAPS's Random BG source, made-up readings next to the sensor's.
    await post('entries', { type: 'sgv', date: r.date + 20000, sgv: 45, device: 'Random' });
  }
  await post('treatments', { eventType: 'Meal Bolus', date: t0, carbs: 20 });
  for (const smb of RESCUE_SMBS) {
    await post('treatments', { eventType: 'Correction Bolus', date: smb.date, insulin: smb.insulin, type: 'SMB', isSMB: true });
    const run = { bg: 80, eventualBG: 216, targetBG: 110, variable_sens: 100, insulinReq: 0.9, units: 0.5, reason: RESCUE_REASON };
    await post('devicestatus', { date: smb.date, device: 'openaps://phone', openaps: { suggested: run, enacted: { ...run, smb: 0.5 } } });
  }
});
after(() => s.close());

test('the misses endpoint lists the loop misses in a period', async () => {
  const res = await request(s.app).get(`/api/analysis/misses?from=${t0 - HOUR}&to=${t0 + 5 * HOUR}`).set(auth(reader)).expect(200);
  assert.equal(res.body.misses.length, 1);
  const [miss] = res.body.misses;
  assert.equal(miss.kind, 'low');
  // Not the Random source's 45.
  assert.equal(miss.glucose, 55);
  assert.equal(miss.smb, 2);
  assert.equal(miss.missedBy, 35);
  assert.deepEqual(miss.flags, ['SMBs after rescue carbs']);
});

test('the misses endpoint checks its period and access', async () => {
  await request(s.app).get(`/api/analysis/misses?from=${t0}&to=${t0}`).set(auth(reader)).expect(400);
  await request(s.app).get(`/api/analysis/misses?from=${t0 - 400 * 24 * HOUR}&to=${t0}`).set(auth(reader)).expect(400);
  await request(s.app).get('/api/analysis/misses').expect(401);
});
