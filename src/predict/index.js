// Glucose 15 and 30 minutes ahead, from the last 2 h of CGM readings, the
// glucose level of the last days, the time of day, and the insulin and carbs
// given. The network is trained offline and uploaded to the server
// (modelling/export.py, store.js); this module rebuilds its inputs exactly as
// modelling/glupred does and runs it.

import { treatmentGrid } from './grid.js';

const MIN = 60000;
const DAY_SLOTS = 288;

// Readings outside this range are sensor errors (as in modelling/glupred/load.py).
export const SGV_MIN = 40;
export const SGV_MAX = 400;

// Slots before the history window that interpolation may need as an anchor.
const ANCHOR_SLOTS = 3;

const formats = new Map();

/** UTC offset (minutes) of a time zone at time t. */
export function zoneOffset (t, timeZone) {
  if (!formats.has(timeZone)) {
    formats.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }));
  }
  const parts = formats.get(timeZone).formatToParts(new Date(t));
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

const ACTIVITY = /^(ia|ca)_(past|fut)_(\d+)$/;
const LEVEL = /^g_mean_(\d+)d$/;
const TREATMENT_INPUTS = /^((ia|ca)_(past|fut)_\d+|iob|cob|profile_basal)$/;

/** What the model's inputs need, worked out once per model. */
const needs = new WeakMap();
function needsOf (model) {
  if (needs.has(model)) return needs.get(model);
  const levelDays = model.inputs.map((name) => LEVEL.exec(name)).filter(Boolean).map((m) => Number(m[1]));
  const treatments = model.inputs.some((name) => TREATMENT_INPUTS.test(name));
  let treatmentSlots = 0;
  const kernels = {};
  if (treatments) {
    const remaining = (k) => { let s = 0; return k.map((v) => 1 - (s += v)); };
    kernels.ia = { kernel: model.insulinKernel, remaining: remaining(model.insulinKernel) };
    kernels.ca = { kernel: model.carbKernel, remaining: remaining(model.carbKernel) };
    const lags = model.inputs.map((name) => ACTIVITY.exec(name)).filter((m) => m && m[2] === 'past').map((m) => Number(m[3]));
    const { quietSlots } = model.rescueCarbs;
    // Doses up to a kernel length before the oldest activity input act on
    // it; assumed rescue carbs look back quietSlots more.
    treatmentSlots = Math.max(0, ...lags) + Math.max(model.insulinKernel.length,
      model.carbKernel.length + quietSlots + 1, model.insulinStaleSlots);
  }
  const levelSlots = levelDays.length ? Math.max(...levelDays) * DAY_SLOTS : 0;
  const rescueSlots = treatments ? model.rescueCarbs.aboveSlots : 0;
  const n = Math.max(model.history, levelSlots, treatmentSlots + rescueSlots) + ANCHOR_SLOTS;
  const out = { n, treatments, treatmentSlots, levelDays, kernels };
  needs.set(model, out);
  return out;
}

/**
 * UTC offset (minutes) at each minute: the uploader's offset from the newest
 * reading at or before it, if within a day, else the fallback zone's (as
 * glupred.grid.local_offsets).
 */
function offsets (readings, timeZone) {
  const known = readings.filter((r) => Number.isFinite(r.utcOffset));
  const minutes = known.map((r) => Math.floor(r.date / MIN));
  const zone = new Map();
  return (minute) => {
    let lo = 0;
    let hi = minutes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (minutes[mid] <= minute) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && minute - minutes[lo - 1] <= 24 * 60) return known[lo - 1].utcOffset;
    // Zones change their offset at a multiple of 15 minutes.
    const bucket = Math.floor(minute / 15);
    if (!zone.has(bucket)) zone.set(bucket, zoneOffset(minute * MIN, timeZone));
    return zone.get(bucket);
  };
}

/**
 * Carbs assumed eaten but not logged (glupred.features.rescue_carbs):
 * `grams` in a slot where glucose falls below `low` after `aboveSlots`
 * slots above it, unless carbs were logged in the last `quietSlots` slots.
 * g[i] is the glucose of carbs[i]'s slot.
 */
function rescueCarbs (g, carbs, { low, grams, aboveSlots, quietSlots }) {
  return carbs.map((_, i) => {
    if (!(g[i] < low) || i < aboveSlots) return 0;
    for (let k = i - aboveSlots; k < i; k++) if (!(g[k] >= low)) return 0;
    for (let k = Math.max(0, i - quietSlots); k <= i; k++) if (carbs[k] > 0) return 0;
    return grams;
  });
}

/** Activity in slot `i + k` of the doses x[0..i] (glupred.features.committed). */
function committed (x, kernel, i, k) {
  let s = 0;
  for (let m = 0; m <= i && k + m < kernel.length; m++) s += x[i - m] * kernel[k + m];
  return s;
}

/**
 * Model inputs at the slot of the newest reading. `readings` are
 * { date (ms), sgv (mg/dL), utcOffset? (minutes) } in any order;
 * `treatments` (see grid.js) are needed for models with insulin or carb
 * inputs. Returns { slot (ms), inputs } or { slot, reason } when the
 * glucose history has gaps or insulin delivery is unknown.
 */
export function buildInputs (readings, { model, timeZone = model.fallbackTimeZone, treatments = {} }) {
  const slotMs = model.slotMinutes * MIN;
  const rs = readings
    .filter((r) => Number.isFinite(r.date) && r.sgv >= SGV_MIN && r.sgv <= SGV_MAX)
    .sort((a, b) => a.date - b.date);
  if (!rs.length) return { slot: null, reason: 'no glucose readings' };
  const need = needsOf(model);
  const minute = (t) => Math.floor(t / MIN);
  const slotOf = (t) => Math.floor(minute(t) / model.slotMinutes);
  const last = slotOf(rs[rs.length - 1].date);
  const { n } = need;
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

  for (const days of need.levelDays) {
    let s = 0;
    let c = 0;
    for (let i = n - days * DAY_SLOTS; i < n; i++) {
      if (!Number.isNaN(g[i])) { s += g[i]; c++; }
    }
    inputs[`g_mean_${days}d`] = c >= days * DAY_SLOTS / 2 ? s / c : model.levelFallback;
  }

  // Local time of the slot start.
  const offsetAt = offsets(rs, timeZone);
  const slotMinute = last * model.slotMinutes;
  const hour = ((((slotMinute + offsetAt(slotMinute)) % 1440) + 1440) % 1440) / 60;
  inputs.hour_sin = Math.sin(2 * Math.PI * hour / 24);
  inputs.hour_cos = Math.cos(2 * Math.PI * hour / 24);

  if (need.treatments) {
    // Records up to the end of the slot, as on the training grid.
    const end = slot + slotMs;
    const upTo = (list) => (list || []).filter((r) => r.date < end);
    const T = need.treatmentSlots;
    const grid = treatmentGrid({
      boluses: upTo(treatments.boluses),
      extended: upTo(treatments.extended),
      tempBasals: upTo(treatments.tempBasals),
      carbs: upTo(treatments.carbs),
      profileSwitches: upTo(treatments.profileSwitches),
      profileStores: treatments.profileStores || [],
    }, { firstSlot: last - T + 1, n: T, slotMinutes: model.slotMinutes, offsetAt, duplicates: model.duplicates });
    const known = grid.bolus.some((b, i) => i >= T - model.insulinStaleSlots
      && (b > 0 || Math.abs(grid.basal[i] - grid.profileBasal[i]) > 1e-9));
    if (!known) return { slot, reason: `no insulin records in the last ${model.insulinStaleSlots * model.slotMinutes / 60} h` };
    // Assumed rescue carbs at the first aboveSlots slots of the window are
    // missed; they would act on none of the inputs.
    const rescue = rescueCarbs(g.slice(n - T), grid.carbs, model.rescueCarbs);
    const doses = {
      // Insulin beyond the profile basal, which roughly balances the liver's output.
      ia: grid.bolus.map((b, i) => b + grid.basal[i] - grid.profileBasal[i]),
      ca: grid.carbs.map((c, i) => c + rescue[i]),
    };
    const L = T - 1;
    for (const name of model.inputs) {
      const m = ACTIVITY.exec(name);
      if (!m) continue;
      const [, prefix, when, k] = m;
      const { kernel } = need.kernels[prefix];
      inputs[name] = when === 'past' ? committed(doses[prefix], kernel, L - Number(k), 0) : committed(doses[prefix], kernel, L, Number(k));
    }
    inputs.iob = committed(doses.ia, need.kernels.ia.remaining, L, 0);
    inputs.cob = committed(doses.ca, need.kernels.ca.remaining, L, 0);
    inputs.profile_basal = grid.profileBasal[L] * 12;
  }
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
export function pastPrediction (readings, now, minutes, { model, timeZone, treatments }) {
  const slotMs = model.slotMinutes * MIN;
  const cutoff = now.slot - (minutes / model.slotMinutes - 1) * slotMs;
  const earlier = readings.filter((r) => r.date < cutoff);
  const built = buildInputs(earlier, { model, timeZone, treatments });
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
export function predict (readings, { model, timeZone, treatments, minutes = [15, 30], past = [15, 30] }) {
  const now = buildInputs(readings, { model, timeZone, treatments });
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
    past: past.map((m) => pastPrediction(readings, now, m, { model, timeZone, treatments })).filter(Boolean),
  };
}

/** Minutes of readings before the newest one that buildInputs may use. */
export function historyMinutes (model) {
  return (needsOf(model).n + 1) * model.slotMinutes;
}

// Temp basals and extended boluses that started this long before the
// treatment window can still be running in it.
const RUNNING_MINUTES = 24 * 60;

/** Minutes of treatments before the newest reading that buildInputs may use (0: none). */
export function treatmentMinutes (model) {
  const { treatments, treatmentSlots } = needsOf(model);
  return treatments ? treatmentSlots * model.slotMinutes + RUNNING_MINUTES : 0;
}

// AAPS's "Random BG" source makes readings up, for trying AAPS out; they
// can arrive alongside the real sensor's (public/model.js keeps the same list).
export const SIMULATED_SOURCES = ['Random'];

/** SQL condition for the entries that are glucose readings the model uses. */
export const VALID_SGV = `type = 'sgv' AND sgv BETWEEN ${SGV_MIN} AND ${SGV_MAX} AND date IS NOT NULL AND is_valid IS DISTINCT FROM false`
  + ` AND coalesce(device, '') NOT IN (${SIMULATED_SOURCES.map((d) => `'${d}'`).join(', ')})`;

const reading = (r) => ({
  date: new Date(r.date).getTime(),
  sgv: r.sgv,
  ...(r.utc_offset != null ? { utcOffset: r.utc_offset } : {}),
});

const VALID = 'is_valid IS DISTINCT FROM false';
const schedule = () => `json_agg(json_build_array(coalesce(s.seconds, extract(epoch FROM s.time::time)::int), s.value) ORDER BY s.position)`;

// The treatments buildInputs uses, as modelling/glupred/load.py reads them,
// for from <= date < to ($1, $2); stored profiles before `to` ($1).
const TREATMENT_QUERIES = {
  boluses: `SELECT date, insulin::float8 AS insulin FROM treatments
     WHERE insulin > 0 AND date >= $1 AND date < $2 AND ${VALID}
       AND coalesce(type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED') AND coalesce(event_type, '') <> 'Combo Bolus'
     ORDER BY date`,
  // Extended boluses on top of the basal; those a FAKE_EXTENDED temp basal
  // emulates are part of its rate.
  extended: `SELECT c.date, c.entered_insulin::float8 AS insulin, c.duration::float8 AS duration FROM treatments c
     WHERE c.event_type = 'Combo Bolus' AND c.entered_insulin > 0 AND c.duration > 0
       AND c.date >= $1 AND c.date < $2 AND c.${VALID}
       AND NOT coalesce(c.is_emulating_temp_basal, false)
       AND NOT EXISTS (SELECT 1 FROM treatments f
                        WHERE f.type = 'FAKE_EXTENDED' AND f.extended_emulated->>'identifier' = c.identifier
                          AND f.date BETWEEN c.date - interval '1 day' AND c.date + interval '1 day')
     ORDER BY c.date`,
  tempBasals: `SELECT date, coalesce(duration_in_milliseconds, duration * 60000)::float8 AS duration_ms,
       coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent FROM treatments
     WHERE event_type = 'Temp Basal' AND date >= $1 AND date < $2 AND ${VALID}
     ORDER BY date`,
  carbs: `SELECT date, carbs::float8 AS carbs FROM treatments
     WHERE carbs > 0 AND date >= $1 AND date < $2 AND ${VALID}
     ORDER BY date`,
  // From the last permanent switch before the window: it sets the profile
  // that the later ones go back to.
  profileSwitches: `SELECT t.date, t.profile, coalesce(t.percentage, 100)::float8 AS percentage,
       coalesce(t.timeshift, 0)::float8 AS timeshift, coalesce(t.duration, 0)::float8 AS duration,
       (SELECT ${schedule()} FROM treatment_profile_schedules s
         WHERE s.treatment_identifier = t.identifier AND s.kind = 'basal') AS schedule
     FROM treatments t
     WHERE t.event_type = 'Profile Switch' AND t.date < $2 AND t.${VALID}
       AND t.date >= coalesce((SELECT max(date) FROM treatments WHERE event_type = 'Profile Switch'
                                  AND coalesce(duration, 0) = 0 AND date <= $1 AND ${VALID}), '-infinity')
     ORDER BY t.date`,
  profileStores: `SELECT p.date, p.default_profile, s.name, ${schedule()} AS schedule
     FROM profile p JOIN profile_store_schedules s ON s.profile_identifier = p.identifier
     WHERE s.kind = 'basal' AND p.date IS NOT NULL AND p.date < $1 AND p.${VALID}
     GROUP BY p.identifier, p.date, p.default_profile, s.name
     ORDER BY p.date`,
};

const ms = (d) => new Date(d).getTime();
const TREATMENT_ROWS = {
  boluses: (r) => ({ date: ms(r.date), insulin: r.insulin }),
  extended: (r) => ({ date: ms(r.date), insulin: r.insulin, duration: r.duration }),
  tempBasals: (r) => ({ date: ms(r.date), durationMs: r.duration_ms, rate: r.rate, percent: r.percent }),
  carbs: (r) => ({ date: ms(r.date), carbs: r.carbs }),
  profileSwitches: (r) => ({
    date: ms(r.date), profile: r.profile, percentage: r.percentage, timeshift: r.timeshift, duration: r.duration, schedule: r.schedule,
  }),
  profileStores: (r) => ({ date: ms(r.date), defaultProfile: r.default_profile, name: r.name, schedule: r.schedule }),
};

/** Treatments with from <= date < to (ms), as buildInputs takes them; profiles also from before. */
export async function treatmentsBetween (pool, from, to) {
  const entries = await Promise.all(Object.entries(TREATMENT_QUERIES).map(async ([key, sql]) => {
    const params = key === 'profileStores' ? [new Date(to)] : [new Date(from), new Date(to)];
    const { rows } = await pool.query(sql, params);
    return [key, rows.map(TREATMENT_ROWS[key])];
  }));
  return Object.fromEntries(entries);
}

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
 * Records for a prediction: the newest reading and the readings and
 * treatments before it that buildInputs uses, plus `pastMinutes` more for
 * the predictions made that much earlier. Returns { readings, treatments }.
 */
export async function recentRecords (pool, model, pastMinutes = 30) {
  const newest = await newestReading(pool);
  if (newest == null) return { readings: [], treatments: {} };
  const slotMs = model.slotMinutes * MIN;
  const [readings, treatments] = await Promise.all([
    readingsBetween(pool, newest - (historyMinutes(model) + pastMinutes) * MIN, newest),
    treatmentMinutes(model)
      ? treatmentsBetween(pool, newest - (treatmentMinutes(model) + pastMinutes) * MIN, (Math.floor(newest / slotMs) + 1) * slotMs)
      : {},
  ]);
  return { readings, treatments };
}
