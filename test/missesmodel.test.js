import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitText, missNote, missSelection, missSummary } from '../public/misses.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 9, 24, 5);
const mmol = (v) => `${(v / 18).toFixed(1)} mmol/L`;

const LOW = {
  kind: 'low', start: t0, end: t0 + 20 * MIN, glucose: 52, from: t0 - HOUR, smb: 2.05, excess: 0.6,
  smbAfterRescue: 2.05, rescueCarbs: 20, expected: { minGuardBG: 83 }, flags: ['SMBs after rescue carbs'],
};
const HIGH = {
  kind: 'high', start: t0, end: t0 + 14 * HOUR, glucose: 288, from: t0 - HOUR, smb: 4.95, dosedFor: 101,
  missing: 3.87, limitedRuns: 8, expected: {}, flags: ['underestimated', 'SMBs capped'],
  limits: [{ kind: 'uamSmbSize', runs: 8, value: 0.6 }, { kind: 'maxIob', runs: 1, value: 10 }],
};

test('a low after SMBs reads as what the loop gave and expected', () => {
  assert.equal(missSummary(LOW, mmol), 'Low of 2.9 mmol/L after 2.05 U of SMB in the hour before, about 0.6 U more than the low left room for.'
    + ' At its largest SMB the loop expected no lower than 4.6 mmol/L. 2.05 U came after 20 g of rescue carbs.');
});

test('an under-dosed high reads as what the loop dosed for and missed', () => {
  assert.equal(missSummary(HIGH, mmol), 'High of 16.0 mmol/L. In the hour before, the loop dosed for 5.6 mmol/L and gave 4.95 U of SMB.'
    + ' Had it seen the peak coming it would have asked for about 3.87 U more.'
    + ' In 8 runs an SMB was cut to the SMB size limit of 0.6 U, set by "Max minutes of basal to limit SMB to for UAM" (IOB was more than the logged carbs needed).'
    + ' In 1 run the loop asked for less because IOB would have gone over max IOB of 10 U ("Maximum total IOB OpenAPS can\'t go over").');
});

test('a max IOB of 0 names its causes, duplicate readings their own', () => {
  assert.match(limitText({ kind: 'maxIob', runs: 3, value: 0 }), /^In 3 runs max IOB was 0 U, .*Low Glucose Suspend mode and when the app has expired\)\.$/);
  assert.match(limitText({ kind: 'duplicates', runs: 6, value: 0 }), /^In 6 runs max IOB was 0 U because of duplicate glucose readings/);
  const glucose = (v) => `${v} mg/dL`;
  assert.match(missSummary({ kind: 'high', glucose: 300, causedByDuplicates: true, limits: [{ kind: 'duplicates', runs: 6, value: 0 }], expected: {} }, glucose), /^High of 300 mg\/dL, caused by duplicate glucose readings\. In 6 runs/);
  assert.match(limitText({ kind: 'maxBasal', runs: 1, value: 3.4 }), /^In 1 run the temp basal was cut to the max safe basal of 3\.4 U\/h/);
});

test('the selection runs from what led to the miss to just after it, at most 12 hours', () => {
  assert.deepEqual(missSelection(LOW), { from: t0 - HOUR, to: t0 + 50 * MIN });
  assert.deepEqual(missSelection(HIGH), { from: t0 - HOUR, to: t0 + 11 * HOUR });
});

test('Claude is told the flags and the summary', () => {
  assert.match(missNote(LOW, mmol), /^loopk flagged this as a loop miss \(SMBs after rescue carbs\): Low of 2\.9 mmol\/L/);
});
