import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartSeries, combinePcts, hourlyProfile, meanSd, rowSummary } from '../public/profiles-model.js';

const stat = (...values) => ({ n: values.length, sum: values.reduce((a, b) => a + b, 0), sumSq: values.reduce((a, b) => a + b * b, 0) });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/** A usage with the same hourly stats every hour. */
function usage (pct, {
  minutes = 60, basal = 1, bolus = 0, sensitivity = { minutes: 0, sum: 0 }, days = stat(), hourBasal = stat(), hourBolus = stat(), hourRatio = stat(),
} = {}) {
  const hours = Array.from({ length: 24 }, () => ({ basal: hourBasal, bolus: hourBolus, ratio: hourRatio }));
  return { pct, minutes, basal, bolus, sensitivity, days, hours };
}

test('mean and sample standard deviation come from sums and sums of squares', () => {
  const r = meanSd(stat(2, 4, 4, 4, 5, 5, 7, 9));
  assert.equal(r.n, 8);
  close(r.mean, 5);
  close(r.sd, Math.sqrt(32 / 7));
  assert.deepEqual(meanSd(stat(3)), { n: 1, mean: 3, sd: null });
  assert.deepEqual(meanSd(stat()), { n: 0, mean: null, sd: null });
});

test('percentages of a profile combine by adding their sums', () => {
  const all = combinePcts([
    usage(100, { minutes: 120, basal: 2, hourBasal: stat(1, 2), sensitivity: { minutes: 100, sum: 110 }, hourRatio: stat(1.1) }),
    usage(150, { minutes: 60, basal: 1.5, bolus: 1, hourBasal: stat(3), sensitivity: { minutes: 50, sum: 40 }, hourRatio: stat(1.2) }),
  ]);
  assert.deepEqual([all.pct, all.minutes, all.basal, all.bolus], [null, 180, 3.5, 1]);
  assert.deepEqual(all.hours[7].basal, stat(1, 2, 3));
  assert.deepEqual(all.hours[7].ratio, stat(1.1, 1.2));
  assert.deepEqual(all.sensitivity, { minutes: 150, sum: 150 });
  assert.equal(rowSummary(all, 180).sensitivity, 1);
  assert.deepEqual(all.days, stat());
});

test('the hourly profile averages rates that change within an hour', () => {
  // Before the first time the first rate applies, as in src/predict/grid.js.
  const p = hourlyProfile([[3600, 1], [5400, 2], [79200, 0.5]]);
  assert.equal(p[0], 1);
  assert.equal(p[1], 1.5);
  assert.equal(p[2], 2);
  assert.equal(p[23], 0.5);
  assert.equal(hourlyProfile([[0, 1]], 120)[5], 1.2);
  assert.deepEqual(hourlyProfile(null).slice(0, 2), [null, null]);
});

test('a row sums insulin and scales it to a day of use', () => {
  const r = rowSummary(usage(100, { minutes: 720, basal: 10, bolus: 2, days: stat(20, 24) }), 2880);
  assert.deepEqual([r.hours, r.share, r.total, r.perDay, r.fullDays, r.dayMean], [12, 25, 12, 24, 2, 22]);
  close(r.daySd, Math.sqrt(8));
  assert.equal(rowSummary(usage(100, { minutes: 0, basal: 0 }), 0).perDay, null);
  assert.equal(r.sensitivity, null);
});

test('the chart shows the profile, the percentages used and the delivered insulin as mean ± SD', () => {
  const profile = { schedule: [[0, 1]], pcts: [usage(100, { hourBasal: stat(1, 3) }), usage(80, { hourBasal: stat(0.8), hourBolus: stat(0.2) })] };
  const all = chartSeries(profile);
  assert.equal(all.profile[0], 1);
  assert.deepEqual(all.adjusted.map((a) => [a.pct, a.values[0]]), [[80, 0.8]]);
  close(all.basal.mean[0], 1.6);
  assert.equal(all.basal.n[0], 3);
  assert.deepEqual(all.ratio.mean.slice(0, 1), [null]);
  const only = chartSeries(profile, 100);
  assert.deepEqual(only.adjusted, []);
  assert.equal(only.basal.mean[0], 2);
  close(only.basal.low[0], 2 - Math.SQRT2);
  close(only.basal.high[0], 2 + Math.SQRT2);
  assert.deepEqual([only.bolus.mean[0], only.bolus.low[0]], [null, null]);
  const eighty = chartSeries(profile, 80);
  // One sample: no spread.
  assert.deepEqual([eighty.bolus.low[0], eighty.bolus.mean[0], eighty.bolus.high[0]], [0.2, 0.2, 0.2]);
});
