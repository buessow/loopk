import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERIOD_HOURS, SETTING_FIELDS, decisionRows, decisionText, formChanges, missLists, parseView, periodEnding, periodRows, predMmol, shiftPeriod, simOverlay, viewQuery,
} from '../public/simulate-model.js';
import { chartSvg, hoverSvg, stepRows } from '../public/glucosechart.js';
import { DEFAULTS } from '../src/oref/settings.js';

const empty = { settings: {}, extra: '', profileName: '', percentage: NaN, isfFactor: 1, carbRatioFactor: 1, basalFactor: 1, target: NaN, algorithm: '', tempTarget: '', tempTargetValue: NaN, tempTargetMinutes: NaN, sensitivityRatio: NaN };
const mmol = (v) => (v / 18).toFixed(1);

test('a form unchanged from the baseline makes no changes', () => {
  assert.deepEqual(formChanges({ ...empty, settings: { max_iob: 5, enableUAM: true } }, { max_iob: 5, enableUAM: true }), {});
});

test('a form makes changes of what differs, glucose in mg/dL', () => {
  const c = formChanges({
    ...empty,
    settings: { max_iob: 7, enableUAM: true, lgsThreshold: undefined },
    extra: '{"enableSMB_with_COB": true}',
    percentage: 120,
    isfFactor: 0.9,
    target: 6,
    algorithm: 'AUTO_ISF',
    tempTarget: 'set',
    tempTargetValue: 8,
    tempTargetMinutes: 90,
    sensitivityRatio: 1.1,
  }, { max_iob: 5, enableUAM: true }, 'mmol/L');
  assert.deepEqual(c, {
    settings: { max_iob: 7, enableSMB_with_COB: true },
    profile: { percentage: 120, isfFactor: 0.9, targetMgdl: 108 },
    algorithm: 'AUTO_ISF',
    tempTarget: { targetMgdl: 144, minutes: 90 },
    sensitivityRatio: 1.1,
  });
  assert.deepEqual(formChanges({ ...empty, target: 110, tempTarget: 'none' }, {}, 'mg/dL'), { profile: { targetMgdl: 110 }, tempTarget: null });
  assert.throws(() => formChanges({ ...empty, extra: '[1]' }, {}), /JSON object/);
});

test('a decision reads as its SMB and temp', () => {
  assert.equal(decisionText({ smb: 0.5, rate: 1.2, duration: 30 }), 'SMB 0.5 U, 1.20 U/h for 30 min');
  assert.equal(decisionText({ smb: 0, rate: null }), 'temp unchanged');
  assert.equal(decisionText({ smb: 0, rate: 0, duration: 0 }), 'cancel temp');
});

test('decision rows compare recorded, unchanged and changed, one value per cell', () => {
  const d = { algorithm: 'AUTO_ISF', smb: 0.4, rate: 1, duration: 30, eventualBG: 180, insulinReq: 0.8, targetBG: 100, sensitivityRatio: 1, variableSens: 54, iob: 1.234, cob: 12.4, limits: [{ kind: 'maxIob', value: 3 }] };
  const rows = decisionRows({ recorded: { ...d, smb: 0.4 }, baseline: d, changed: { ...d, smb: 0.8, limits: [] } }, mmol);
  const row = (label) => rows.find((r) => r[0] === label);
  assert.deepEqual(row('SMB (U)'), ['SMB (U)', '0.4', '0.4', '0.8']);
  assert.deepEqual(row('Eventual glucose'), ['Eventual glucose', '10.0', '10.0', '10.0']);
  assert.deepEqual(row('Limits hit'), ['Limits hit', '–', 'max IOB 3', 'none']);
  for (const r of rows) assert.equal(r.length, 4);
});

test('period rows show actual, simulated and the band; insulin without a band', () => {
  const st = (mean) => ({ mean, ranges: { veryLow: 0, low: 1, target: 90, high: 8, veryHigh: 1 }, lows70: 1, lows54: 0, minutesBelow70: 15, highs250: 1, insulin: { total: 40, basal: 10, smb: 25, smbCount: 50, largestSmb: 1.2 } });
  const rows = periodRows({ actual: st(126), simulated: { ...st(117), low: st(120), high: st(114) }, misses: { actual: 3, simulated: 1 } }, mmol);
  assert.deepEqual(rows[0], ['Mean glucose', '7.0', '6.5', '6.7', '6.3']);
  assert.deepEqual(rows.find((r) => r[0] === 'Total insulin (U)'), ['Total insulin (U)', '40.0', '40.0', '', '']);
  assert.deepEqual(rows.at(-1), ['Loop misses', '3', '1', '', '']);
});

test('the view is kept in the address', () => {
  assert.equal(viewQuery({ mode: 'run', run: 1000 }), 'run=1000');
  assert.equal(viewQuery({ mode: 'period', from: 1000, to: 2000 }), 'from=1000&to=2000');
  assert.deepEqual(parseView('?run=1000'), { mode: 'run', run: 1000 });
  assert.deepEqual(parseView('?from=1000&to=2000'), { mode: 'period', from: 1000, to: 2000 });
  assert.equal(parseView('?from=2000&to=1000'), null);
  assert.equal(parseView('?run=abc'), null);
});

test('the form has a field for every setting, of its type', () => {
  assert.deepEqual(SETTING_FIELDS.map((f) => f.key).sort(), Object.keys(DEFAULTS).sort());
  for (const f of SETTING_FIELDS) {
    const d = DEFAULTS[f.key];
    assert.ok(f.group && f.label && f.aaps, f.key);
    assert.equal(f.kind, d === null ? 'number' : typeof d, f.key);
  }
});

test('a stored profile goes in by name, at the recorded percentage unless one is given', () => {
  assert.deepEqual(formChanges({ ...empty, profileName: 'Sport' }, {}), { profile: { name: 'Sport' } });
  assert.deepEqual(formChanges({ ...empty, profileName: 'Sport', percentage: 80 }, {}), { profile: { name: 'Sport', percentage: 80 } });
});

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 25, 12);

test('a period is picked by its length and moved by half of it, never past now', () => {
  assert.ok(PERIOD_HOURS.includes(24) && Math.max(...PERIOD_HOURS) === 14 * 24);
  assert.deepEqual(periodEnding(NOW + HOUR, 6, NOW), { from: NOW - 6 * HOUR, to: NOW });
  const day = periodEnding(NOW, 24, NOW);
  assert.deepEqual(shiftPeriod(day, -1, NOW), { from: NOW - 36 * HOUR, to: NOW - 12 * HOUR });
  assert.deepEqual(shiftPeriod(shiftPeriod(day, -1, NOW), 1, NOW), day);
  assert.deepEqual(shiftPeriod(day, 1, NOW), day);
});

// A period's result as POST /api/simulate/period sends it (mg/dL).
const T0 = NOW - HOUR;
const RESULT = {
  from: T0,
  to: NOW,
  series: {
    glucose: [[T0, 180, 162, 171, 153], [T0 + 5 * MIN, 180, null, null, null], [T0 + 10 * MIN, 198, 180, 189, 171]],
    simulatedBasal: [[T0, 1], [T0 + 5 * MIN, 1], [T0 + 10 * MIN, 2]],
    simulatedSmbs: [[T0 + 5 * MIN, 0.4]],
    runs: [{ t: T0 + 5 * MIN, bg: 180, eventual: 216, target: 108, isf: 54, iob: 1.2, cob: 10, insulinReq: 0.8, smb: 0.4, rate: 2, duration: 30, reason: 'x' }],
    windows: [T0],
  },
  misses: {
    actualList: [{ kind: 'high', start: T0, end: T0 + HOUR, glucose: 250, both: true }, { kind: 'low', start: T0, end: T0 + HOUR, glucose: 60, both: false }],
    simulatedList: [{ kind: 'high', start: T0, end: T0 + HOUR, glucose: 240, both: true }, { kind: 'low', start: NOW, end: NOW, glucose: 62, both: false }],
  },
};

test('the simulation becomes the overlay of the chart, in mmol/L', () => {
  const sim = simOverlay(RESULT);
  assert.deepEqual(sim.g, [{ t: T0, v: 9 }, { t: T0 + 10 * MIN, v: 10 }]);
  assert.deepEqual(sim.band[0], { t: T0, lo: 9.5, hi: 8.5 });
  // equal rates in a row make one segment
  assert.deepEqual(sim.basal, [{ t0: T0, t1: T0 + 10 * MIN, rate: 1 }, { t0: T0 + 10 * MIN, t1: T0 + 15 * MIN, rate: 2 }]);
  assert.deepEqual(sim.smbs, [{ t: T0 + 5 * MIN, v: 0.4 }]);
  assert.equal(sim.runs[0].eventual, 12);
  assert.equal(sim.runs[0].iob, 1.2);
  assert.deepEqual(sim.windows, []);
  assert.deepEqual(predMmol({ IOB: [180, 90] }), { IOB: [10, 5] });
});

test('every miss is listed with what became of it', () => {
  const { actual, simulated } = missLists(RESULT.misses);
  assert.deepEqual(actual.map((m) => m.fate), ['both', 'gone']);
  assert.deepEqual(simulated.map((m) => m.fate), ['both', 'new']);
});

test('a 5-minute step shows actual and simulated side by side', () => {
  const fmt = (v) => v.toFixed(1);
  const rows = stepRows({
    t: T0,
    actual: { g: 10, basal: 1, smb: 0, run: { iob: 1, cob: 0, eventual: 11, target: 6, insulinReq: 0.5, isf: 3, rate: 1, duration: 30, smb: 0 } },
    sim: { g: 9, basal: 2, smb: 0.4, run: { iob: 1.4, cob: 0, eventual: 9, target: 6, insulinReq: 0, isf: 3, rate: 2, duration: 30, smb: 0.4 } },
  }, fmt);
  const row = (label) => rows.find((r) => r[0] === label);
  assert.deepEqual(row('Glucose'), ['Glucose', '10.0', '9.0']);
  assert.deepEqual(row('SMB (U)'), ['SMB (U)', '–', '0.40']);
  assert.deepEqual(row('Decision'), ['Decision', 'temp 1.00 U/h for 30 min', 'temp 2.00 U/h for 30 min, SMB 0.4 U']);
  for (const r of rows) assert.equal(r.length, 3);
});

test('the glucose chart draws the simulation over the actual data and compares on hover', () => {
  const data = {
    g: [{ t: T0, v: 10 }, { t: T0 + 10 * MIN, v: 11 }], hr: [], cobSeries: [], events: [{ t: T0 + 5 * MIN, type: 'bolus', v: 0.3, smb: true }],
    basal: [{ t0: T0, t1: NOW, rate: 0.8, prof: 0.8 }], forecast: {}, loop: [],
  };
  const o = { data, W: 900, t0: T0, t1: NOW, units: 'mmol/L', style: 'boxes', showProfile: true, showLoop: true, sim: simOverlay(RESULT) };
  const svg = chartSvg(o);
  assert.match(svg, /^<svg/);
  assert.match(svg, /stroke:var\(--chart-simulated\);stroke-width:2/);
  const { html } = hoverSvg(o, T0 + 10 * MIN);
  assert.match(html, /Actual/);
  assert.match(html, /Simulated/);
  // without a simulation the hover is the glucose page's
  assert.doesNotMatch(hoverSvg({ ...o, sim: null }, T0).html, /Simulated/);
});

