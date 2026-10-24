import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missNote, missSelection, missSummary } from '../public/misses.js';

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
  missing: 3.87, limitedRuns: 8, expected: {}, flags: ['underestimated', 'held back by a limit'],
};

test('a low after SMBs reads as what the loop gave and expected', () => {
  assert.equal(missSummary(LOW, mmol), 'Low of 2.9 mmol/L after 2.05 U of SMB in the hour before, about 0.6 U more than the low left room for.'
    + ' At its largest SMB the loop expected no lower than 4.6 mmol/L. 2.05 U came after 20 g of rescue carbs.');
});

test('an under-dosed high reads as what the loop dosed for and missed', () => {
  assert.equal(missSummary(HIGH, mmol), 'High of 16.0 mmol/L. In the hour before, the loop dosed for 5.6 mmol/L and gave 4.95 U of SMB.'
    + ' Had it seen the peak coming it would have asked for about 3.87 U more. A limit capped 8 of its runs.');
});

test('the selection runs from what led to the miss to just after it, at most 12 hours', () => {
  assert.deepEqual(missSelection(LOW), { from: t0 - HOUR, to: t0 + 50 * MIN });
  assert.deepEqual(missSelection(HIGH), { from: t0 - HOUR, to: t0 + 11 * HOUR });
});

test('Claude is told the flags and the summary', () => {
  assert.match(missNote(LOW, mmol), /^loopk flagged this as a loop miss \(SMBs after rescue carbs\): Low of 2\.9 mmol\/L/);
});
