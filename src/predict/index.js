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
 * The prediction API document: glucose (mg/dL) 15 and 30 minutes after the
 * newest reading, with the 10th–90th percentile range, and the probability
 * of falling below 70 within 30 minutes.
 */
export function predict (readings, { model, timeZone, minutes = [15, 30] }) {
  const { slot, inputs, reason } = buildInputs(readings, { model, timeZone });
  const base = { model: model.version };
  if (!inputs) return { ...base, available: false, reason, date: slot };
  const latest = Math.max(...readings.filter((r) => r.sgv >= SGV_MIN && r.sgv <= SGV_MAX).map((r) => r.date));
  const out = run(inputs, model);
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
  };
}

/** Readings for a prediction: the newest one and the 2 h (and anchors) before it. */
export async function recentReadings (pool, model) {
  const minutes = (model.history + ANCHOR_SLOTS + 1) * model.slotMinutes;
  const { rows } = await pool.query(
    `WITH g AS (
       SELECT date, sgv, utc_offset FROM entries
        WHERE type = 'sgv' AND sgv BETWEEN $1 AND $2 AND date IS NOT NULL AND is_valid IS DISTINCT FROM false)
     SELECT date, sgv, utc_offset FROM g
      WHERE date >= (SELECT max(date) FROM g) - make_interval(mins => $3)
      ORDER BY date`,
    [SGV_MIN, SGV_MAX, minutes]);
  return rows.map((r) => ({
    date: new Date(r.date).getTime(),
    sgv: r.sgv,
    ...(r.utc_offset != null ? { utcOffset: r.utc_offset } : {}),
  }));
}
