import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS, autoTitle, defaultDashboard, formatValue, groupTotals, hourRows, neededFrom, normalizeDashboard, periodRange, widgetData,
} from '../public/reports-model.js';

const HOUR = 3600000;
const COLUMNS = ['hour', 'offset', 'readings', 'sgvSum', 'sgvSquares', 'veryLow', 'low', 'target', 'high', 'veryHigh',
  'bolus', 'basal', 'profileBasal', 'carbs', 'hrCount', 'hrSum'];

/** Hourly rows from `start` (ms, UTC) with the same values every hour. */
function hours (start, n, values = {}, offset = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = { hour: start / HOUR + i, offset, ...values };
    rows.push(COLUMNS.map((c) => r[c] ?? 0));
  }
  return hourRows({ columns: COLUMNS, rows });
}

const all = { from: -Infinity, to: Infinity };

test('hours are grouped by local day, week, month, hour of day and weekday', () => {
  // Monday 5 Jan 2026, 22:00 UTC is 23:00 at UTC+1: four hours span two local days.
  const rows = hours(Date.UTC(2026, 0, 5, 22), 4, { readings: 12 }, 60);
  const days = groupTotals(rows, 'day', all);
  assert.deepEqual(days.map((g) => [g.key, g.totals.hours]), [['2026-01-05', 1], ['2026-01-06', 3]]);
  assert.equal(days[0].label, '5 Jan');
  assert.deepEqual(groupTotals(rows, 'week', all).map((g) => g.key), ['2026-01-05']);
  assert.deepEqual(groupTotals(rows, 'month', all).map((g) => g.label), ['Jan 2026']);
  const byHour = groupTotals(rows, 'hour', all);
  assert.equal(byHour.length, 24);
  assert.deepEqual([23, 0, 1, 2].map((h) => byHour[h].totals.hours), [1, 1, 1, 1]);
  assert.equal(byHour[0].label, '00:00');
  const weekdays = groupTotals(rows, 'weekday', all);
  assert.deepEqual(weekdays.map((g) => g.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(weekdays.slice(0, 2).map((g) => g.totals.hours), [1, 3]);
});

test('date groups without data in between are kept, and only the period counts', () => {
  const rows = [...hours(Date.UTC(2025, 11, 30), 1), ...hours(Date.UTC(2026, 0, 2), 1), ...hours(Date.UTC(2026, 0, 3), 1)];
  const days = groupTotals(rows, 'day', all);
  assert.deepEqual(days.map((g) => g.key), ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(days[1].totals.hours, 0);
  // Spanning two years, days show the year.
  assert.equal(days[0].label, '30 Dec 25');
  assert.deepEqual(groupTotals(rows, 'month', all).map((g) => g.key), ['2025-12', '2026-01']);
  assert.deepEqual(groupTotals(rows, 'day', { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 3) }).map((g) => g.key), ['2026-01-02']);
  assert.deepEqual(groupTotals([], 'day', all), []);
});

test('glucose metrics in either unit, from the readings of a group', () => {
  // 10 readings per hour: 7 in range, 2 low, 1 very high; mean 135, SD 45 mg/dL.
  const n = 10;
  const rows = hours(Date.UTC(2026, 0, 1), 2, { readings: n, sgvSum: n * 135, sgvSquares: n * (135 ** 2 + 45 ** 2), target: 7, low: 2, veryHigh: 1 });
  const [{ totals }] = groupTotals(rows, 'none', all);
  const mmol = { mgdl: false, perHour: false };
  const mg = { mgdl: true, perHour: false };
  assert.equal(METRICS.mean.value(totals, mg), 135);
  assert.equal(formatValue(METRICS.mean.value(totals, mmol), METRICS.mean, mmol), '7.5');
  assert.ok(Math.abs(METRICS.sd.value(totals, mg) - 45) < 1e-9);
  assert.ok(Math.abs(METRICS.cv.value(totals, mg) - 100 / 3) < 1e-9);
  assert.equal(METRICS.tir.value(totals), 70);
  assert.equal(METRICS.below.value(totals), 20);
  assert.equal(METRICS.veryHigh.value(totals), 10);
  assert.equal(formatValue(METRICS.gmi.value(totals), METRICS.gmi, mg), '6.5');
  assert.ok(Math.abs(METRICS.coverage.value(totals) - 100 * 10 / 12) < 1e-9);
  assert.deepEqual(METRICS.ranges.series.map((s) => s.value(totals)), [0, 20, 70, 0, 10]);
  assert.equal(formatValue(METRICS.mean.value(groupTotals([], 'none', all)[0].totals, mg), METRICS.mean, mg), '–');
});

test('insulin and carbs are per day, and per hour by hour of day', () => {
  // Two days: 0.5 U basal and 0.25 U bolus every hour, 120 g carbs on the first day.
  const rows = hours(Date.UTC(2026, 0, 1), 48, { basal: 0.5, bolus: 0.25, profileBasal: 0.4 });
  rows[12].carbs = 120;
  const whole = widgetData(rows, { metric: 'tdd', group: 'none', display: 'number' }, { range: all, mgdl: false });
  assert.deepEqual(whole.series[0].values, [18]);
  const days = widgetData(rows, { metric: 'carbs', group: 'day', display: 'bar' }, { range: all, mgdl: false });
  assert.deepEqual(days.series[0].values, [120, 0]);
  const byHour = widgetData(rows, { metric: 'insulin', group: 'hour', display: 'bar' }, { range: all, mgdl: false });
  assert.equal(byHour.ctx.perHour, true);
  assert.deepEqual(byHour.series.map((s) => [s.label, s.values[0]]), [['Basal', 0.5], ['Bolus', 0.25]]);
  const [{ totals }] = groupTotals(rows, 'none', all);
  assert.ok(Math.abs(METRICS.basalShare.value(totals) - 200 / 3) < 1e-9);
  assert.ok(Math.abs(METRICS.basalVsProfile.value(totals) - 125) < 1e-9);
  assert.equal(METRICS.carbRatio.value(totals), 10);
});

test('a number widget shows the whole period, whatever it is grouped by', () => {
  const rows = hours(Date.UTC(2026, 0, 1), 48, { readings: 12, target: 6 });
  const data = widgetData(rows, { metric: 'tir', group: 'day', display: 'number' }, { range: all, mgdl: false });
  assert.deepEqual(data.series[0].values, [50]);
});

test('periods are whole local days up to now, or the chosen dates', () => {
  const now = new Date(2026, 5, 15, 12).getTime();
  assert.deepEqual(periodRange({ preset: '14d' }, now), { from: new Date(2026, 5, 2).getTime(), to: now });
  assert.deepEqual(periodRange({ preset: 'all' }, now), { from: 0, to: now });
  const custom = periodRange({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }, now);
  assert.equal(custom.from, new Date(2026, 0, 1).getTime());
  assert.equal(custom.to, new Date(2026, 1, 1).getTime());
  const dashboard = normalizeDashboard({ period: { preset: '7d' }, widgets: [{ metric: 'tir', period: { preset: '90d' } }] });
  assert.equal(neededFrom(dashboard, now), new Date(2026, 5, 15 - 89).getTime());
});

test('a stored dashboard is cleaned up', () => {
  const d = normalizeDashboard({
    period: { preset: 'custom', from: '2026-02-01', to: '2026-01-01' },
    widgets: [
      { id: 'a', metric: 'tir', group: 'day', display: 'bar', x: 0, y: 0, w: 6, h: 4 },
      { id: 'a', metric: 'mean', group: 'fortnight', display: 'radar', x: 40, w: 0, period: { preset: 'custom', from: '2026-01-01', to: '2026-01-31' } },
      { id: 'b', metric: 'removedMetric' },
      null,
    ],
  });
  assert.deepEqual(d.period, { preset: '14d' });
  assert.deepEqual(d.widgets.map((w) => w.id), ['a', 'a_']);
  assert.deepEqual(d.widgets[1], {
    id: 'a_', metric: 'mean', group: 'none', display: 'bar', title: '', period: { preset: 'custom', from: '2026-01-01', to: '2026-01-31' }, x: 0, y: 0, w: 6, h: 4,
  });
  const standard = defaultDashboard();
  assert.ok(standard.widgets.length > 5);
  assert.deepEqual(normalizeDashboard(standard), standard);
  assert.equal(autoTitle({ metric: 'mean', group: 'hour', display: 'line' }), 'Mean glucose by hour of day');
  assert.equal(autoTitle({ metric: 'mean', group: 'hour', display: 'number' }), 'Mean glucose');
});
