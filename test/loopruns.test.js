import { test } from 'node:test';
import assert from 'node:assert/strict';
import { algorithmName, algorithmPeriods, curvePoints, loopRuns, splitReason } from '../public/loopruns.js';

const MIN = 60000;
const t0 = Date.UTC(2026, 9, 22, 10);
const REASON = 'COB: 44.8, Dev: 2.1, BGI: -0.2, ISF: 5.1, CR: 9.15, Target: 6.0, minPredBG 10.1, minGuardBG 4.5; Eventual BG 22.3 >= 6.5, insulinReq 0.8; setting 30m low temp of 1.17U/h. Microbolusing 0.4U.';
const run = (extra) => ({
  bg: 90, eventualBG: 180, targetBG: 108, insulinReq: 0.8, COB: 44.8, IOB: 0.6, rate: 1.17, duration: 30, units: 0.4,
  sensitivityRatio: 1, variable_sens: 90, reason: REASON, algorithm: 'AUTO_ISF', runningDynamicIsf: true,
  predBGs: { IOB: [90, 81, 72], ZT: [90, 72] }, ...extra,
});

test('a loop run reads in mmol/L with what the loop set', () => {
  const [r] = loopRuns([{ date: t0, openaps: { suggested: run(), enacted: { ...run({ rate: 1.15 }), received: true, smb: 0 } } }]);
  assert.equal(r.t, t0);
  assert.equal(r.algorithm, 'AUTO_ISF');
  assert.equal(r.bg, 5);
  assert.equal(r.eventual, 10);
  assert.equal(r.target, 6);
  assert.equal(r.isf, 5);
  assert.equal(r.enacted, true);
  assert.equal(r.rate, 1.15);
  assert.equal(r.smb, 0.4);
  assert.equal(r.smbGiven, 0);
  assert.deepEqual(r.pred.IOB, [5, 4.5, 4]);
  assert.deepEqual(curvePoints(r, 'ZT'), [{ t: t0, v: 5 }, { t: t0 + 5 * MIN, v: 4 }]);
  assert.deepEqual(curvePoints(r, 'COB'), []);
});

test('suggestions only, no temp (-1) and runs uploaded twice', () => {
  const docs = [
    { date: t0, openaps: { suggested: run({ rate: -1, duration: -1, units: undefined }) } },
    { date: t0 + 2000, openaps: { suggested: run({ rate: -1, duration: -1, units: undefined }) } },
    { date: t0 + 5 * MIN, openaps: { iob: { iob: 1 } } },
  ];
  const runs = loopRuns(docs);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].enacted, false);
  assert.equal(runs[0].rate, null);
  assert.equal(runs[0].duration, null);
  assert.equal(runs[0].smb, null);
});

test('the reason splits into the values the loop used and its decision', () => {
  const { values, decision } = splitReason(REASON);
  assert.deepEqual(values.slice(0, 2), [['COB', 44.8], ['Dev', 2.1]]);
  assert.deepEqual(values.find(([n]) => n === 'minGuardBG'), ['minGuardBG', 4.5]);
  assert.match(decision, /^Eventual BG 22\.3 >= 6\.5, insulinReq 0\.8; setting 30m low temp/);
  assert.deepEqual(splitReason('no temp required'), { values: [], decision: 'no temp required' });
});

test('algorithm periods follow the runs and break at gaps', () => {
  const at = (m, algorithm, dynamicIsf) => ({ t: t0 + m * MIN, algorithm, dynamicIsf });
  const runs = [at(0, 'SMB', true), at(5, 'SMB', true), at(10, 'AUTO_ISF', true), at(15, 'AUTO_ISF', true), at(60, 'AUTO_ISF', true)];
  assert.equal(algorithmName(runs[0]), 'SMB + DynISF');
  assert.equal(algorithmName(at(0, 'SMB', false)), 'SMB');
  assert.deepEqual(algorithmPeriods(runs).map((p) => [p.name, (p.from - t0) / MIN, (p.to - t0) / MIN]), [
    ['SMB + DynISF', 0, 10],
    ['AUTO_ISF', 10, 20],
    ['AUTO_ISF', 60, 65],
  ]);
});
