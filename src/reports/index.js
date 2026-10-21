// Hourly totals for the reports page (public/reports.js): per UTC hour, the
// glucose readings counted by range, the insulin delivered as boluses and as
// basal, the profile basal, carbs and heart rate. Sums, not averages, so the
// page can add hours up into any period (day, week, hour of day, ...) and
// work out means, spreads and per-day amounts from them. Basal is integrated
// per minute from the profile in effect and the temp basals, as for the
// predictions (src/predict/grid.js).

import { treatmentGrid } from '../predict/grid.js';
import { VALID_SGV, treatmentsBetween, zoneOffset } from '../predict/index.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Hours the basal is integrated over at once (per minute), to bound memory.
const CHUNK_HOURS = 30 * 24;
// The database moves duplicate treatments out as they are stored (migration 0010).
const NO_DUPLICATES = { insulin: 0, carbs: 0, seconds: 0 };

/**
 * One row per hour: hour (ms since the epoch / HOUR), UTC offset of the
 * time zone (minutes), readings and the sum and sum of squares of their
 * glucose (mg/dL), readings very low (< 54), low (54-69), in target
 * (70-180), high (181-250) and very high (> 250), bolus, basal and profile
 * basal (U), carbs (g), heart-rate readings and their sum (bpm).
 */
export const COLUMNS = [
  'hour', 'offset', 'readings', 'sgvSum', 'sgvSquares', 'veryLow', 'low', 'target', 'high', 'veryHigh',
  'bolus', 'basal', 'profileBasal', 'carbs', 'hrCount', 'hrSum',
];
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

const GLUCOSE_SQL = `
  SELECT floor(extract(epoch FROM date) / 3600)::float8 AS h, count(*)::int AS n,
         sum(sgv)::float8 AS s, sum(sgv::float8 * sgv) AS ss,
         count(*) FILTER (WHERE sgv < 54)::int AS very_low,
         count(*) FILTER (WHERE sgv >= 54 AND sgv < 70)::int AS low,
         count(*) FILTER (WHERE sgv >= 70 AND sgv <= 180)::int AS target,
         count(*) FILTER (WHERE sgv > 180 AND sgv <= 250)::int AS high,
         count(*) FILTER (WHERE sgv > 250)::int AS very_high
    FROM entries
   WHERE ${VALID_SGV} AND date >= $1 AND date < $2
   GROUP BY 1`;

const HEARTRATE_SQL = `
  SELECT floor(extract(epoch FROM date) / 3600)::float8 AS h, count(*)::int AS n, sum(beats_per_minute)::float8 AS s
    FROM heartrate
   WHERE date >= $1 AND date < $2 AND beats_per_minute BETWEEN 25 AND 250 AND is_valid IS DISTINCT FROM false
   GROUP BY 1`;

export function validTimeZone (timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Records with from <= date < to. */
const within = (list, from, to) => (list || []).filter((r) => r.date >= from && r.date < to);

/**
 * Hourly totals for from <= time < to (ms), limited to the time from the
 * first reading to now. Returns { columns, rows, from, to, timeZone } with
 * one row (see COLUMNS) for every hour, also the hours without readings.
 */
export async function hourlyTotals (pool, { from, to, timeZone, now = Date.now() }) {
  const { rows: [first] } = await pool.query(`SELECT min(date) AS date FROM entries WHERE ${VALID_SGV}`);
  const start = first.date ? Math.max(from, new Date(first.date).getTime()) : Infinity;
  const fromH = Math.floor(start / HOUR);
  const toH = Math.ceil(Math.min(to, now) / HOUR);
  if (!(toH > fromH)) return { columns: COLUMNS, rows: [], from: null, to: null, timeZone };

  const range = [new Date(fromH * HOUR), new Date(toH * HOUR)];
  // Temp basals and extended boluses started up to a day before still run.
  const [glucose, heartrate, treatments] = await Promise.all([
    pool.query(GLUCOSE_SQL, range),
    pool.query(HEARTRATE_SQL, range),
    treatmentsBetween(pool, fromH * HOUR - DAY, toH * HOUR),
  ]);

  const zone = new Map();
  const offsetAt = (minute) => {
    const h = Math.floor(minute / 60);
    if (!zone.has(h)) zone.set(h, zoneOffset(h * HOUR, timeZone));
    return zone.get(h);
  };

  const rows = [];
  for (let h = fromH; h < toH; h++) {
    const row = new Array(COLUMNS.length).fill(0);
    row[COL.hour] = h;
    row[COL.offset] = offsetAt(h * 60);
    rows.push(row);
  }
  for (const r of glucose.rows) {
    const row = rows[r.h - fromH];
    row[COL.readings] = r.n;
    row[COL.sgvSum] = r.s;
    row[COL.sgvSquares] = r.ss;
    row[COL.veryLow] = r.very_low;
    row[COL.low] = r.low;
    row[COL.target] = r.target;
    row[COL.high] = r.high;
    row[COL.veryHigh] = r.very_high;
  }
  for (const r of heartrate.rows) {
    const row = rows[r.h - fromH];
    row[COL.hrCount] = r.n;
    row[COL.hrSum] = round(r.s, 1);
  }

  for (let h = fromH; h < toH; h += CHUNK_HOURS) {
    const n = Math.min(CHUNK_HOURS, toH - h);
    const a = h * HOUR - DAY;
    const b = (h + n) * HOUR;
    const grid = treatmentGrid({
      boluses: within(treatments.boluses, a, b),
      extended: within(treatments.extended, a, b),
      tempBasals: within(treatments.tempBasals, a, b),
      carbs: within(treatments.carbs, a, b),
      profileSwitches: within(treatments.profileSwitches, -Infinity, b),
      profileStores: treatments.profileStores,
    }, { firstSlot: h, n, slotMinutes: 60, offsetAt, duplicates: NO_DUPLICATES });
    for (let i = 0; i < n; i++) {
      const row = rows[h - fromH + i];
      row[COL.bolus] = round(grid.bolus[i], 4);
      row[COL.basal] = round(grid.basal[i], 4);
      row[COL.profileBasal] = round(grid.profileBasal[i], 4);
      row[COL.carbs] = round(grid.carbs[i], 1);
    }
  }
  return { columns: COLUMNS, rows, from: fromH * HOUR, to: toH * HOUR, timeZone };
}
