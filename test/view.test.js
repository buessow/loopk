import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseDuration, parseView, viewSearch } from '../public/view.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 9, 24, 4);

test('a view goes into the address and back unchanged', () => {
  const view = { start: t0, duration: 3 * HOUR, show: ['pred', 'basal', 'loop'] };
  const search = viewSearch(view, { offsetMinutes: 120 });
  assert.equal(search, '?start=2026-10-24T06:00%2B02:00&duration=3h&show=pred,basal,loop');
  assert.deepEqual(parseView(search), view);
  // West of UTC, and the other overlays.
  const west = { start: t0, duration: 90 * MIN, show: ['loop'] };
  assert.equal(viewSearch(west, { offsetMinutes: -270 }), '?start=2026-10-23T23:30-04:30&duration=90m&show=loop');
  assert.deepEqual(parseView(viewSearch(west, { offsetMinutes: -270 })), west);
  // As the address bar gives it, with or without "?".
  assert.deepEqual(parseView(search.slice(1)), view);
});

test('durations are written in their largest whole unit', () => {
  assert.deepEqual([90 * MIN, 3 * HOUR, DAY, 7 * DAY, 36 * HOUR].map(formatDuration), ['90m', '3h', '1d', '7d', '36h']);
  assert.deepEqual(['90m', '3h', '1d', '7d', '30d'].map(parseDuration), [90 * MIN, 3 * HOUR, DAY, 7 * DAY, 30 * DAY]);
});

test('a view following now has no start, and no overlays is an empty show', () => {
  assert.equal(viewSearch({ start: null, duration: DAY, show: [] }), '?duration=1d&show=');
  assert.deepEqual(parseView('?duration=1d&show='), { start: null, duration: DAY, show: [] });
  // An address without the view leaves every setting to the page.
  assert.deepEqual(parseView(''), { start: null, duration: null, show: null });
});

test('what the address gets wrong is left to the page', () => {
  assert.deepEqual(parseView('?start=yesterday&duration=3x&show=pred,units,basal'), { start: null, duration: null, show: null });
  // Repeated names count once, in the page's order.
  assert.deepEqual(parseView('?show=loop,pred,loop').show, ['pred', 'loop']);
  // Out of range, without an offset, or not a whole number.
  for (const d of ['5m', '31d', '1.5h', '-3h', '']) assert.equal(parseDuration(d), null, d);
  for (const s of ['2026-10-24T06:00', '2026-10-24', '2026-13-40T06:00+02:00']) assert.equal(parseView(`?start=${s}`).start, null, s);
  // A "+" typed into the address reads as a space; Z and an offset without colon work too.
  assert.equal(parseView('?start=2026-10-24T06:00+02:00').start, t0);
  assert.equal(parseView('?start=2026-10-24T04:00Z').start, t0);
  assert.equal(parseView('?start=2026-10-24T06:00%2B0200').start, t0);
  // No units parameter: a unit in the address is ignored.
  assert.equal('units' in parseView('?units=mg/dL'), false);
});
