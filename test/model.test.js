import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, basalSegments, profileTimeline, tempBasals, eventSeries, gmiFromMmol, onBoard, timeInRanges, trendDirection, HOUR, MIN } from '../public/model.js';

const profile = {
  defaultProfile: 'P',
  store: { P: { basal: [{ time: '00:00', value: 0.8, timeAsSeconds: 0 }, { time: '06:00', value: 1.0, timeAsSeconds: 21600 }] } },
};

function localTime (h, m = 0) {
  const d = new Date(2026, 9, 17, h, m, 0, 0);
  return d.getTime();
}

test('profile schedule and temp basals become delivered/profile steps', () => {
  const start = localTime(4);
  const end = localTime(8);
  const temps = tempBasals([
    { eventType: 'Temp Basal', date: localTime(5), duration: 60, absolute: 2 },
    { eventType: 'Temp Basal', date: localTime(5, 30), duration: 30, rate: 0 }, // replaces the first
  ]);
  const segs = basalSegments({ start, end, timeline: profileTimeline(profile, []), temps });
  assert.deepEqual(segs.map((s) => [new Date(s.t0).getHours() + new Date(s.t0).getMinutes() / 60, s.rate, s.prof]), [
    [4, 0.8, 0.8],
    [5, 2, 0.8],
    [5.5, 0, 0.8],
    [6, 1.0, 1.0],
  ]);
  assert.equal(segs[segs.length - 1].t1, end);
});

test('profile switch percentage scales the profile', () => {
  const tl = profileTimeline(profile, [{ eventType: 'Profile Switch', date: localTime(7), profile: 'P', percentage: 150 }]);
  const segs = basalSegments({ start: localTime(6), end: localTime(8), timeline: tl, temps: [] });
  assert.deepEqual(segs.map((s) => s.prof), [1.0, 1.5]);
});

test('events: boluses, SMBs, carbs, BG checks in mmol', () => {
  const ev = eventSeries([
    { eventType: 'Meal Bolus', date: 1, insulin: 4, carbs: 40 },
    { eventType: 'Correction Bolus', date: 2, insulin: 0.3, type: 'SMB' },
    { eventType: 'BG Check', date: 3, glucose: 108, units: 'mg/dl' },
    { eventType: 'Correction Bolus', date: 4, insulin: 2, type: 'PRIMING' },
  ]);
  assert.deepEqual(ev.map((e) => [e.type, e.v]), [['bolus', 4], ['carbs', 40], ['bolus', 0.3], ['bg', 6]]);
  assert.equal(ev[2].smb, true);
});

test('IOB/COB from recent AAPS device status only', () => {
  const now = Date.now();
  assert.deepEqual(onBoard([{ date: now - MIN, openaps: { iob: { iob: 1.234 }, suggested: { COB: 12 } } }], now), { iob: 1.234, cob: 12 });
  assert.deepEqual(onBoard([{ date: now - 2 * HOUR, openaps: { iob: { iob: 1 } } }], now), { iob: null, cob: null });
});

test('GMI uses the published CGM mean-glucose equation', () => {
  // 8 mmol/L is 144 mg/dL: 3.31 + 0.02392 × 144 = 6.75448%.
  assert.equal(gmiFromMmol(8).toFixed(5), '6.75448');
  assert.equal(gmiFromMmol(null), null);
  assert.equal(gmiFromMmol(Infinity), null);
});

test('time in ranges splits glucose into five exclusive bands', () => {
  const ranges = timeInRanges([2.9, 3, 3.9, 10, 10.1, 13.9, 14]);
  assert.deepEqual(ranges, { veryLow: 14, low: 14, inRange: 29, high: 29, veryHigh: 14 });
  assert.deepEqual(timeInRanges([]), { veryLow: null, low: null, inRange: null, high: null, veryHigh: null });
});

test('trend direction compares values after their display rounding', () => {
  assert.equal(trendDirection(65, 64), 'up');
  assert.equal(trendDirection(64, 65), 'down');
  assert.equal(trendDirection(64.4, 64.49), 'flat');
  assert.equal(trendDirection(6.81, 6.79, 1), 'flat');
  assert.equal(trendDirection(6.86, 6.79, 1), 'up');
  assert.equal(trendDirection(6.8, null, 1), null);
});

test('buildModel converts mg/dL to mmol/L and windows events', () => {
  const now = Date.now();
  const m = buildModel({
    entries: [{ date: now - 5 * MIN, sgv: 180, type: 'sgv' }, { date: now - 10 * MIN, sgv: 90, type: 'sgv' }],
    treatments: [{ eventType: 'Note', date: now }, { eventType: 'Meal Bolus', date: now - 30 * HOUR, carbs: 10 }],
    heartrate: [{ date: now, beatsPerMinute: 70 }],
    devicestatus: [],
    profile,
    now,
  });
  assert.deepEqual(m.g.map((p) => p.v), [5, 10]);
  assert.equal(m.events.length, 0);
  assert.equal(m.hr[0].v, 70);
  assert.ok(m.basal.length > 0);
});
