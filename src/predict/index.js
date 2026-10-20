// Glucose 15 and 30 minutes ahead, from the last 2 h of CGM readings and the
// time of day. The network is trained offline and uploaded to the server
// (modelling/export.py, store.js); this module rebuilds its inputs exactly as
// modelling/glupred does and runs it.

const MIN = 60000;

// Readings outside this range are sensor errors (as in modelling/glupred/load.py).
export const SGV_MIN = 40;
export const SGV_MAX = 400;

// Slots before the history window that interpolation may need as an anchor.
const ANCHOR_SLOTS = 3;

/** UTC offset (minutes) of a time zone at time t. */
export function zoneOffset (t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(t));
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const local = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute);
  return Math.round((local - Math.floor(t / MIN) * MIN) / MIN);
}

/**
 * Linear interpolation of NaN runs between known values, filling at most
 * `limit` values at the start of each run (pandas limit + limit_area='inside').
 */
export function interpolate (values, limit) {
  const out = values.slice();
  let last = -1;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    if (last >= 0 && i - last > 1) {
      for (let j = last + 1; j < Math.min(i, last + 1 + limit); j++) {
        out[j] = values[last] + (values[i] - values[last]) * (j - last) / (i - last);
      }
    }
    last = i;
  }
  return out;
}

/**
 * Model inputs at the slot of the newest reading. `readings` are
 * { date (ms), sgv (mg/dL), utcOffset? (minutes) } in any order. Returns
 * { slot (ms), inputs } or { slot, reason } when the history has gaps.
 */
export function buildInputs (readings, { model, timeZone = model.fallbackTimeZone }) {
  const slotMs = model.slotMinutes * MIN;
  const rs = readings
    .filter((r) => Number.isFinite(r.date) && r.sgv >= SGV_MIN && r.sgv <= SGV_MAX)
    .sort((a, b) => a.date - b.date);
  if (!rs.length) return { slot: null, reason: 'no glucose readings' };
  const minute = (t) => Math.floor(t / MIN);
  const slotOf = (t) => Math.floor(minute(t) / model.slotMinutes);
  const last = slotOf(rs[rs.length - 1].date);
  const n = model.history + ANCHOR_SLOTS;
  const first = last - n + 1;
  const sum = new Array(n).fill(0);
  const count = new Array(n).fill(0);
  for (const r of rs) {
    const i = slotOf(r.date) - first;
    if (i < 0) continue;
    sum[i] += r.sgv;
    count[i] += 1;
  }
  const raw = sum.map((s, i) => (count[i] ? s / count[i] : NaN));
  const g = interpolate(raw, model.interpolateSlots);
  const now = raw[n - 1];
  const slot = last * slotMs;

  const inputs = {};
  inputs.g_now = now;
  for (let lag = 1; lag < model.history; lag++) {
    const v = g[n - 1 - lag];
    if (Number.isNaN(v)) return { slot, reason: 'gap in the last 2 h of glucose' };
    inputs[`gd_${lag}`] = v - now;
  }

  // Local time of the slot start: the uploader's offset from the newest
  // reading at or before it (if within a day), else the fallback zone's.
  const slotMinute = last * model.slotMinutes;
  const known = rs.filter((r) => Number.isFinite(r.utcOffset) && minute(r.date) <= slotMinute);
  const ref = known[known.length - 1];
  const offset = ref && slotMinute - minute(ref.date) <= 24 * 60 ? ref.utcOffset : zoneOffset(slot, timeZone);
  const hour = ((((slotMinute + offset) % 1440) + 1440) % 1440) / 60;
  inputs.hour_sin = Math.sin(2 * Math.PI * hour / 24);
  inputs.hour_cos = Math.cos(2 * Math.PI * hour / 24);
  return { slot, inputs: model.inputs.map((name) => inputs[name]) };
}

/** Runs the network: { mean, 'q0.1', 'q0.9', ... (mg/dL per horizon), p_low_30, ... }. */
export function run (inputs, model) {
  let x = inputs.map((v, i) => (v - model.mean[i]) / model.scale[i]);
  model.layers.forEach((layer, k) => {
    const hidden = k < model.layers.length - 1;
    x = layer.weights.map((row, j) => {
      let s = layer.bias[j];
      for (let i = 0; i < row.length; i++) s += row[i] * x[i];
      return hidden ? Math.max(0, s) : s;
    });
  });
  const H = model.horizons;
  const g = inputs[model.inputs.indexOf('g_now')];
  const path = (j) => model.targetScale.map((sd, h) => g * Math.exp(x[j * H + h] * sd));
  const out = { mean: path(0) };
  model.quantiles.forEach((q, j) => { out[`q${q}`] = path(j + 1); });
  const k = H * (1 + model.quantiles.length);
  model.events.forEach((name, j) => { out[name] = 1 / (1 + Math.exp(-x[k + j])); });
  return out;
}

/**
 * What the model predicts for the slot of the newest reading from the
 * readings `minutes` earlier, or null when those have gaps. The lead can be
 * longer than `minutes` when the reading that far back is missing.
 */
export function pastPrediction (readings, now, minutes, { model, timeZone }) {
  const slotMs = model.slotMinutes * MIN;
  const cutoff = now.slot - (minutes / model.slotMinutes - 1) * slotMs;
  const earlier = readings.filter((r) => r.date < cutoff);
  const built = buildInputs(earlier, { model, timeZone });
  if (!built.inputs) return null;
  const k = Math.round((now.slot - built.slot) / slotMs);
  if (k < 1 || k > model.horizons) return null;
  const predicted = run(built.inputs, model).mean[k - 1];
  const actual = now.inputs[model.inputs.indexOf('g_now')];
  return {
    minutes: k * model.slotMinutes,
    madeAt: Math.max(...earlier.filter((r) => r.sgv >= SGV_MIN && r.sgv <= SGV_MAX).map((r) => r.date)),
    sgv: Math.round(predicted),
    actual: Math.round(actual),
    errorPercent: Math.round((predicted - actual) / actual * 1000) / 10,
  };
}

/**
 * The prediction API document: glucose (mg/dL) 15 and 30 minutes after the
 * newest reading, with the 10th–90th percentile range, and the probability
 * of falling below 70 within 30 minutes. `past`: what was predicted for now
 * 15 and 30 minutes ago, with the error in percent of the actual glucose.
 */
export function predict (readings, { model, timeZone, minutes = [15, 30], past = [15, 30] }) {
  const now = buildInputs(readings, { model, timeZone });
  const base = { model: model.version };
  if (!now.inputs) return { ...base, available: false, reason: now.reason, date: now.slot };
  const latest = Math.max(...readings.filter((r) => r.sgv >= SGV_MIN && r.sgv <= SGV_MAX).map((r) => r.date));
  const out = run(now.inputs, model);
  const p = out.p_low_30;
  return {
    ...base,
    available: true,
    date: latest,
    predictions: minutes.map((m) => {
      const h = m / model.slotMinutes - 1;
      return {
        minutes: m,
        date: latest + m * MIN,
        sgv: Math.round(out.mean[h]),
        low: Math.round(out['q0.1'][h]),
        high: Math.round(out['q0.9'][h]),
      };
    }),
    lowProbability30: Math.round(p * 1000) / 1000,
    lowWarning: p >= model.lowWarning,
    past: past.map((m) => pastPrediction(readings, now, m, { model, timeZone })).filter(Boolean),
  };
}

/** Minutes of readings before the newest one that buildInputs may use. */
export function historyMinutes (model) {
  return (model.history + ANCHOR_SLOTS + 1) * model.slotMinutes;
}

/** SQL condition for the entries that are glucose readings the model uses. */
export const VALID_SGV = `type = 'sgv' AND sgv BETWEEN ${SGV_MIN} AND ${SGV_MAX} AND date IS NOT NULL AND is_valid IS DISTINCT FROM false`;

const reading = (r) => ({
  date: new Date(r.date).getTime(),
  sgv: r.sgv,
  ...(r.utc_offset != null ? { utcOffset: r.utc_offset } : {}),
});

/** Readings with from <= date <= to (ms), oldest first. */
export async function readingsBetween (pool, from, to) {
  const { rows } = await pool.query(
    `SELECT date, sgv, utc_offset FROM entries WHERE ${VALID_SGV} AND date >= $1 AND date <= $2 ORDER BY date`,
    [new Date(from), new Date(to)]);
  return rows.map(reading);
}

/** Date (ms) of the newest reading, or null. */
export async function newestReading (pool) {
  const { rows: [r] } = await pool.query(`SELECT max(date) AS date FROM entries WHERE ${VALID_SGV}`);
  return r.date ? new Date(r.date).getTime() : null;
}

/**
 * Readings for a prediction: the newest one and the 2 h (and anchors) before
 * it, plus `pastMinutes` more for the predictions made that much earlier.
 */
export async function recentReadings (pool, model, pastMinutes = 30) {
  const minutes = historyMinutes(model) + pastMinutes;
  const newest = await newestReading(pool);
  return newest == null ? [] : readingsBetween(pool, newest - minutes * MIN, newest);
}
