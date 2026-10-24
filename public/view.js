// The glucose page's view in its address: which time range the chart shows
// and which overlays are on, so a view can be bookmarked, shared and linked
// to (the MCP server's links). Pure: the page (app.js) applies and writes it.
//
//   ?start=2026-10-24T06:00%2B02:00&duration=3h&show=pred,basal,loop
//
// - start: the left edge of the chart, ISO 8601 with its offset; left out
//   while the chart follows "now".
// - duration: the chart's length: 90m, 3h, 1d, 7d.
// - show: the overlays that are on (OVERLAYS); "show=" with none. A list
//   with an unknown name is ignored.

const MIN = 60000;
const UNIT_MS = { m: MIN, h: 60 * MIN, d: 24 * 60 * MIN };

export const MIN_DURATION = 15 * MIN;
export const MAX_DURATION = 30 * UNIT_MS.d;
/** Overlay names in the address, in the order they are written. */
export const OVERLAYS = ['pred', 'basal', 'loop'];

/** "90m", "3h", "1d" as ms; null unless a whole number within the limits. */
export function parseDuration (text) {
  const m = /^(\d{1,5})([mhd])$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  return ms >= MIN_DURATION && ms <= MAX_DURATION ? ms : null;
}

/** A duration (ms) in the largest whole unit: 1d, 3h, 90m. */
export function formatDuration (ms) {
  const minutes = Math.max(1, Math.round(ms / MIN));
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * A time in ISO 8601 to the minute with its offset from UTC, e.g.
 * 2026-10-24T06:00+02:00. `offsetMinutes` defaults to the browser's offset
 * at that time.
 */
export function formatStart (t, offsetMinutes = -new Date(t).getTimezoneOffset()) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const d = new Date(Math.round(t / MIN) * MIN + offsetMinutes * MIN);
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    + `${sign}${p(Math.trunc(offsetMinutes / 60))}:${p(offsetMinutes % 60)}`;
}

/** An ISO 8601 time with a date, a time and an offset (or Z) as ms; null otherwise. */
export function parseStart (text) {
  // An unencoded "+" in a query reads as a space.
  const s = String(text ?? '').trim().replace(/ (\d{2}:?\d{2})$/, '+$1');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : null;
}

/**
 * The view in a query string (location.search, with or without "?"):
 * { start (ms, null: follows now), duration (ms or null), show (overlay
 * names, or null when the address names none) }. Values that are not
 * understood are null, so the page keeps its own setting for them.
 */
export function parseView (search) {
  const q = new URLSearchParams(search || '');
  // A list with a name the page does not know is left to the page as a whole.
  const names = q.has('show') ? q.get('show').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const show = names && names.every((s) => OVERLAYS.includes(s)) ? names : null;
  return {
    start: q.has('start') ? parseStart(q.get('start')) : null,
    duration: q.has('duration') ? parseDuration(q.get('duration')) : null,
    show: show && [...new Set(show)].sort((a, b) => OVERLAYS.indexOf(a) - OVERLAYS.indexOf(b)),
  };
}

/**
 * The query string ("?start=…&duration=…&show=…") for a view: start (ms,
 * null while following now), duration (ms), show (overlay names).
 * `offsetMinutes` is the offset to write start with (default the browser's).
 */
export function viewSearch ({ start, duration, show }, { offsetMinutes } = {}) {
  const parts = [];
  // Only "+" needs encoding: colons are fine in a query and easier to read.
  if (start != null) parts.push(`start=${formatStart(start, offsetMinutes).replace('+', '%2B')}`);
  if (duration != null) parts.push(`duration=${formatDuration(duration)}`);
  if (show) parts.push(`show=${OVERLAYS.filter((o) => show.includes(o)).join(',')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
