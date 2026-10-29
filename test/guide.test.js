import { test } from 'node:test';
import assert from 'node:assert/strict';
import { algorithmPeriods, uniqueRuns } from '../src/analysis/guide.js';

test('loop runs uploaded twice within a minute count once', () => {
  const runs = [{ date: 0, reason: 'a' }, { date: 2000, reason: 'a' }, { date: 4000, reason: 'b' }, { date: 300000, reason: 'b' }];
  assert.deepEqual(uniqueRuns(runs).map((r) => r.date), [0, 4000, 300000]);
});

test('runs group into periods of one algorithm', () => {
  const runs = [{ date: 0, algorithm: 'SMB', dynamic_isf: false }, { date: 5, algorithm: 'SMB', dynamic_isf: false }, { date: 9 }, { date: 10, algorithm: 'AUTO_ISF', dynamic_isf: true }];
  assert.deepEqual(algorithmPeriods(runs), [
    { from: 0, to: 5, algorithm: 'SMB', dynamicIsf: false },
    { from: 10, to: 10, algorithm: 'AUTO_ISF', dynamicIsf: true },
  ]);
});
