// Calculations of the reports page (reports.js), kept free of the DOM so
// they can be tested: periods, grouping of the hourly totals that
// /api/reports/hours returns, the metrics of a group, and the dashboard
// document stored per person.

import { gmiFromMmol, DAY, HOUR, MIN, MGDL_PER_MMOL } from './model.js';

export const PERIODS = {
  '7d': 'Last 7 days',
  '14d': 'Last 14 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '1y': 'Last year',
  all: 'All data',
  custom: 'Dates…',
};
const PERIOD_DAYS = { '7d': 7, '14d': 14, '30d': 30, '90d': 90, '1y': 365 };

export const GROUPS = {
  none: 'Whole period',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  hour: 'Hour of day',
  weekday: 'Weekday',
};

export const DISPLAYS = {
  number: 'Number',
  bar: 'Bar chart',
  line: 'Line chart',
  doughnut: 'Doughnut',
  table: 'Table',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Local midnight of a 'YYYY-MM-DD' date (in the browser's time zone). */
function localMidnight (date, addDays = 0) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d + addDays).getTime();
}

/**
 * The time range [from, to) (ms) of a period: { preset } of PERIODS, with
 * { from, to } dates ('YYYY-MM-DD', both included) for 'custom'.
 */
export function periodRange (period, now = Date.now()) {
  const preset = period?.preset || '14d';
  if (preset === 'all') return { from: 0, to: now };
  if (preset === 'custom' && period.from && period.to) {
    return { from: localMidnight(period.from), to: Math.min(now, localMidnight(period.to, 1)) };
  }
  // Whole local days, today included.
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (PERIOD_DAYS[preset] || 14) + 1);
  return { from: from.getTime(), to: now };
}

export function periodLabel (period) {
  if (period?.preset === 'custom' && period.from && period.to) return `${period.from} – ${period.to}`;
  return PERIODS[period?.preset] || PERIODS['14d'];
}

// --- totals ----------------------------------------------------------------

const FIELDS = ['readings', 'sgvSum', 'sgvSquares', 'veryLow', 'low', 'target', 'high', 'veryHigh',
  'bolus', 'basal', 'profileBasal', 'carbs', 'hrCount', 'hrSum'];

export function emptyTotals () {
  const t = { hours: 0 };
  for (const f of FIELDS) t[f] = 0;
  return t;
}

/** The hourly rows of a /api/reports/hours response as { t (ms), local (ms, shifted to local time), ...fields }. */
export function hourRows ({ columns, rows }) {
  const at = Object.fromEntries(columns.map((c, i) => [c, i]));
  return rows.map((r) => {
    const t = r[at.hour] * HOUR;
    const out = { t, local: t + r[at.offset] * MIN };
    for (const f of FIELDS) out[f] = r[at[f]] ?? 0;
    return out;
  });
}

function add (totals, row) {
  totals.hours += 1;
  for (const f of FIELDS) totals[f] += row[f];
}

/** Key and sort order of the group a row's local time falls in. */
function groupOf (local, group) {
  const d = new Date(local);
  switch (group) {
    case 'day': return dateKey(d);
    case 'week': {
      const monday = new Date(local - ((d.getUTCDay() + 6) % 7) * DAY);
      return dateKey(monday);
    }
    case 'month': return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    case 'year': return String(d.getUTCFullYear());
    case 'hour': return d.getUTCHours();
    case 'weekday': return (d.getUTCDay() + 6) % 7;
    default: return 'all';
  }
}

/** The next key after `key` of a date group, to fill in groups without data. */
function nextKey (key, group) {
  if (group === 'year') return String(Number(key) + 1);
  if (group === 'month') {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  const d = new Date(`${key}T00:00:00Z`).getTime() + (group === 'week' ? 7 : 1) * DAY;
  return dateKey(new Date(d));
}

function groupLabel (key, group, withYear) {
  switch (group) {
    case 'day':
    case 'week': {
      const [y, m, d] = key.split('-').map(Number);
      return `${d} ${MONTHS[m - 1]}${withYear ? ` ${String(y).slice(2)}` : ''}`;
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return `${MONTHS[m - 1]} ${y}`;
    }
    case 'hour': return `${pad(key)}:00`;
    case 'weekday': return WEEKDAYS[key];
    case 'none': return 'All';
    default: return String(key);
  }
}

/**
 * The rows with from <= t < to, added up per group: [{ key, label, totals }]
 * in order. Date groups without data in between are included (empty);
 * hours of the day and weekdays are all included.
 */
export function groupTotals (rows, group, { from, to }) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.t < from || r.t >= to) continue;
    const key = groupOf(r.local, group);
    if (!byKey.has(key)) byKey.set(key, emptyTotals());
    add(byKey.get(key), r);
  }
  let keys;
  if (group === 'hour') keys = Array.from({ length: 24 }, (_, i) => i);
  else if (group === 'weekday') keys = Array.from({ length: 7 }, (_, i) => i);
  else if (group === 'none') keys = ['all'];
  else {
    const present = [...byKey.keys()].sort();
    keys = [];
    for (let k = present[0]; k != null && k <= present[present.length - 1]; k = nextKey(k, group)) keys.push(k);
  }
  const years = new Set(keys.map((k) => String(k).slice(0, 4)));
  return keys.map((key) => ({
    key,
    label: groupLabel(key, group, years.size > 1),
    totals: byKey.get(key) || emptyTotals(),
  }));
}

// --- metrics ---------------------------------------------------------------

/** Glucose (mg/dL) in the unit shown. */
const glucose = (mg, ctx) => (mg == null ? null : ctx.mgdl ? mg : mg / MGDL_PER_MMOL);
const meanMg = (t) => (t.readings ? t.sgvSum / t.readings : null);
const sdMg = (t) => {
  if (t.readings < 2) return null;
  const m = t.sgvSum / t.readings;
  return Math.sqrt(Math.max(0, t.sgvSquares / t.readings - m * m));
};
const share = (count, t) => (t.readings ? 100 * count / t.readings : null);
/** An amount per day (per hour in an hour-of-day report) over the hours of the group. */
const rate = (amount, t, ctx) => (t.hours ? amount / t.hours * (ctx.perHour ? 1 : 24) : null);
const glucoseUnit = (ctx) => (ctx.mgdl ? 'mg/dL' : 'mmol/L');
const perDay = (unit) => (ctx) => `${unit}/${ctx.perHour ? 'h' : 'day'}`;

/**
 * What a widget can show. A metric has a value(totals, ctx), or series of
 * values drawn together (stacked); ctx is { mgdl, perHour }. `digits` is a
 * number or a function of ctx; `color` names a CSS variable.
 */
export const METRICS = {
  tir: { label: 'Time in range', unit: '%', digits: 0, value: (t) => share(t.target, t) },
  ranges: {
    label: 'Time in ranges',
    unit: '%',
    digits: 0,
    series: [
      { label: 'Very low', color: '--range-very-low', value: (t) => share(t.veryLow, t) },
      { label: 'Low', color: '--range-low', value: (t) => share(t.low, t) },
      { label: 'In range', color: '--range-target', value: (t) => share(t.target, t) },
      { label: 'High', color: '--range-high', value: (t) => share(t.high, t) },
      { label: 'Very high', color: '--range-very-high', value: (t) => share(t.veryHigh, t) },
    ],
  },
  below: { label: 'Time below range', unit: '%', digits: 1, value: (t) => share(t.veryLow + t.low, t) },
  veryLow: { label: 'Time very low', unit: '%', digits: 1, value: (t) => share(t.veryLow, t) },
  above: { label: 'Time above range', unit: '%', digits: 0, value: (t) => share(t.high + t.veryHigh, t) },
  veryHigh: { label: 'Time very high', unit: '%', digits: 1, value: (t) => share(t.veryHigh, t) },
  mean: { label: 'Mean glucose', unit: glucoseUnit, digits: (ctx) => (ctx.mgdl ? 0 : 1), value: (t, ctx) => glucose(meanMg(t), ctx) },
  sd: { label: 'Standard deviation', unit: glucoseUnit, digits: (ctx) => (ctx.mgdl ? 0 : 1), value: (t, ctx) => glucose(sdMg(t), ctx) },
  cv: { label: 'Coefficient of variation', unit: '%', digits: 0, value: (t) => (meanMg(t) && sdMg(t) != null ? 100 * sdMg(t) / meanMg(t) : null) },
  gmi: { label: 'GMI', unit: '%', digits: 1, value: (t) => gmiFromMmol(meanMg(t) == null ? null : meanMg(t) / MGDL_PER_MMOL) },
  coverage: { label: 'Sensor coverage', unit: '%', digits: 0, value: (t) => (t.hours ? Math.min(100, 100 * t.readings / (t.hours * 12)) : null) },
  readings: { label: 'Readings', unit: '', digits: 0, value: (t) => t.readings },
  insulin: {
    label: 'Insulin',
    unit: perDay('U'),
    digits: 1,
    series: [
      { label: 'Basal', color: '--chart-basal', value: (t, ctx) => rate(t.basal, t, ctx) },
      { label: 'Bolus', color: '--chart-bolus', value: (t, ctx) => rate(t.bolus, t, ctx) },
    ],
  },
  tdd: { label: 'Total insulin', unit: perDay('U'), digits: 1, value: (t, ctx) => rate(t.bolus + t.basal, t, ctx) },
  bolus: { label: 'Bolus insulin', unit: perDay('U'), digits: 1, value: (t, ctx) => rate(t.bolus, t, ctx) },
  basal: { label: 'Basal insulin', unit: perDay('U'), digits: 1, value: (t, ctx) => rate(t.basal, t, ctx) },
  basalShare: { label: 'Basal share', unit: '%', digits: 0, value: (t) => (t.bolus + t.basal > 0 ? 100 * t.basal / (t.bolus + t.basal) : null) },
  basalVsProfile: {
    label: 'Basal vs profile',
    unit: '%',
    digits: 0,
    value: (t) => (t.profileBasal > 0 ? 100 * t.basal / t.profileBasal : null),
  },
  carbs: { label: 'Carbs', unit: perDay('g'), digits: 0, value: (t, ctx) => rate(t.carbs, t, ctx) },
  carbRatio: { label: 'Carbs per bolus unit', unit: 'g/U', digits: 1, value: (t) => (t.bolus > 0 ? t.carbs / t.bolus : null) },
  heartRate: { label: 'Mean heart rate', unit: 'bpm', digits: 0, value: (t) => (t.hrCount ? t.hrSum / t.hrCount : null) },
};

export const unitOf = (metric, ctx) => (typeof metric.unit === 'function' ? metric.unit(ctx) : metric.unit);
const digitsOf = (metric, ctx) => (typeof metric.digits === 'function' ? metric.digits(ctx) : metric.digits);

/** Series of a metric: [{ label, color?, value }] (one, unnamed, for a single value). */
export const seriesOf = (metric) => metric.series || [{ label: metric.label, value: metric.value }];

export function formatValue (value, metric, ctx) {
  if (value == null || !Number.isFinite(value)) return '–';
  return value.toFixed(digitsOf(metric, ctx));
}

/**
 * What a widget shows: its groups' labels and, per series, the values.
 * Returns { labels, series: [{ label, color, values }] }.
 */
export function widgetData (rows, widget, { range, mgdl }) {
  const metric = METRICS[widget.metric];
  const group = widget.display === 'number' ? 'none' : widget.group;
  const ctx = { mgdl, perHour: group === 'hour' };
  const groups = groupTotals(rows, group, range);
  return {
    ctx,
    labels: groups.map((g) => g.label),
    series: seriesOf(metric).map((s) => ({
      label: s.label,
      color: s.color,
      values: groups.map((g) => s.value(g.totals, ctx)),
    })),
  };
}

// --- dashboard -------------------------------------------------------------

export const DASHBOARD_VERSION = 1;
const GRID_COLUMNS = 12;

export function defaultDashboard () {
  const w = (metric, group, display, x, y, width, height, extra = {}) => ({ metric, group, display, x, y, w: width, h: height, ...extra });
  return normalizeDashboard({
    version: DASHBOARD_VERSION,
    period: { preset: '14d' },
    widgets: [
      w('tir', 'none', 'number', 0, 0, 3, 2),
      w('mean', 'none', 'number', 3, 0, 3, 2),
      w('gmi', 'none', 'number', 6, 0, 3, 2),
      w('tdd', 'none', 'number', 9, 0, 3, 2),
      w('ranges', 'day', 'bar', 0, 2, 8, 4),
      w('ranges', 'none', 'doughnut', 8, 2, 4, 4),
      w('mean', 'hour', 'line', 0, 6, 6, 4),
      w('below', 'hour', 'bar', 6, 6, 6, 4),
      w('insulin', 'week', 'bar', 0, 10, 6, 4, { period: { preset: '90d' } }),
      w('carbs', 'day', 'bar', 6, 10, 6, 4),
      w('tir', 'month', 'line', 0, 14, 12, 4, { period: { preset: '1y' } }),
    ],
  });
}

function normalizePeriod (p) {
  if (!p || !PERIODS[p.preset]) return null;
  if (p.preset !== 'custom') return { preset: p.preset };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return date.test(p.from) && date.test(p.to) && p.from <= p.to ? { preset: 'custom', from: p.from, to: p.to } : null;
}

const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

/** A stored dashboard with unknown metrics and bad values dropped or set to defaults. */
export function normalizeDashboard (doc) {
  const widgets = (Array.isArray(doc?.widgets) ? doc.widgets : [])
    .filter((x) => x && METRICS[x.metric])
    .map((x, i) => ({
      id: typeof x.id === 'string' && x.id ? x.id : `w${i + 1}`,
      metric: x.metric,
      group: GROUPS[x.group] ? x.group : 'none',
      display: DISPLAYS[x.display] ? x.display : 'bar',
      title: typeof x.title === 'string' ? x.title.slice(0, 120) : '',
      period: normalizePeriod(x.period),
      x: int(x.x, 0, GRID_COLUMNS - 1, 0),
      y: int(x.y, 0, 1000, 0),
      w: int(x.w, 1, GRID_COLUMNS, 6),
      h: int(x.h, 1, 20, 4),
    }));
  const ids = new Set();
  for (const x of widgets) {
    while (ids.has(x.id)) x.id += '_';
    ids.add(x.id);
  }
  return { version: DASHBOARD_VERSION, period: normalizePeriod(doc?.period) || { preset: '14d' }, widgets };
}

/** The earliest time any widget needs: what to load. */
export function neededFrom (dashboard, now = Date.now()) {
  const periods = [dashboard.period, ...dashboard.widgets.map((x) => x.period).filter(Boolean)];
  return Math.min(...periods.map((p) => periodRange(p, now).from));
}

export function autoTitle (widget) {
  const metric = METRICS[widget.metric];
  if (widget.display === 'number' || widget.group === 'none') return metric.label;
  return `${metric.label} by ${GROUPS[widget.group].toLowerCase()}`;
}
