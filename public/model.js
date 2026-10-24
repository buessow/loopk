// Turns Nightscout documents into the series the glucose log draws.
// Pure functions, no DOM: shared by the page and the tests.

export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const MGDL_PER_MMOL = 18;

/**
 * Glucose Management Indicator (GMI) as a percentage, calculated from mean
 * CGM glucose in mmol/L. GMI is an estimate, not a laboratory HbA1c value.
 * Bergenstal et al. 2018: 3.31 + 0.02392 × mean glucose in mg/dL.
 */
export function gmiFromMmol (meanMmol) {
  return typeof meanMmol === 'number' && Number.isFinite(meanMmol)
    ? 3.31 + 0.02392 * meanMmol * MGDL_PER_MMOL
    : null;
}

/**
 * Percentage of valid glucose readings in the standard five CGM ranges,
 * using mmol/L: very low <3.0, low 3.0–3.8, target 3.9–10.0, high
 * 10.1–13.9, and very high >13.9. Readings may be numbers or { v } points.
 */
export function timeInRanges (readings) {
  const values = readings
    .map((reading) => typeof reading === 'number' ? reading : reading?.v)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const percentage = (predicate) => values.length ? Math.round(values.filter(predicate).length / values.length * 100) : null;
  return {
    veryLow: percentage((value) => value < 3),
    low: percentage((value) => value >= 3 && value < 3.9),
    inRange: percentage((value) => value >= 3.9 && value <= 10),
    high: percentage((value) => value > 10 && value <= 13.9),
    veryHigh: percentage((value) => value > 13.9),
  };
}

/** Direction after display rounding: up, down, flat, or null when unavailable. */
export function trendDirection (current, previous, decimals = 0) {
  if (![current, previous].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const scale = 10 ** decimals;
  const difference = Math.round(current * scale) - Math.round(previous * scale);
  return difference > 0 ? 'up' : difference < 0 ? 'down' : 'flat';
}

const BOLUS_TYPES = new Set(['NORMAL', 'SMB', undefined, null, '']);

function num (v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function docTime (doc) {
  if (typeof doc.date === 'number') return doc.date;
  if (typeof doc.mills === 'number') return doc.mills;
  const t = Date.parse(doc.created_at || doc.dateString || '');
  return Number.isNaN(t) ? null : t;
}

/** Glucose readings (sgv, mg/dL) as { t, v } in mmol/L, ascending. */
// AAPS's "Random BG" source makes readings up, for trying AAPS out; they
// can arrive alongside the real sensor's (src/predict/index.js, SIMULATED_SOURCES).
const SIMULATED_SOURCES = ['Random'];

export function glucoseSeries (entries) {
  return entries
    .filter((e) => (e.type || 'sgv') === 'sgv' && num(e.sgv) > 0 && !SIMULATED_SOURCES.includes(e.device))
    .map((e) => ({ t: docTime(e), v: num(e.sgv) / MGDL_PER_MMOL, direction: e.direction }))
    .filter((p) => p.t != null)
    .sort((a, b) => a.t - b.t);
}

export function heartRateSeries (docs) {
  return docs
    .map((d) => ({ t: docTime(d), v: num(d.beatsPerMinute ?? d.bpm ?? d.heartRate) }))
    .filter((p) => p.t != null && p.v > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Recorded predictions (GET /api/prediction/history) as one series per lead
 * time, at the time predicted for: { 15: [{ t, v (mmol/L), madeAt }], 30: [...] }.
 */
export function forecastSeries (docs = []) {
  const out = {};
  for (const d of docs) {
    const v = num(d.sgv);
    if (typeof d.date !== 'number' || v == null) continue;
    (out[d.minutes] ||= []).push({ t: d.date, v: v / MGDL_PER_MMOL, madeAt: d.madeAt });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t - b.t);
  return out;
}

/** Carbs on board (g) reported by AAPS / Loop device-status records. */
export function cobSeries (docs) {
  return docs
    .map((d) => ({
      t: docTime(d),
      v: num(d.openaps?.suggested?.COB ?? d.openaps?.enacted?.COB ?? d.loop?.cob?.cob),
    }))
    .filter((p) => p.t != null && p.v != null && p.v >= 0)
    .sort((a, b) => a.t - b.t);
}

function bgCheckMmol (d) {
  const g = num(d.glucose);
  if (g == null) return null;
  const units = String(d.units || '').toLowerCase();
  if (units.startsWith('mmol')) return g;
  if (units.startsWith('mg')) return g / MGDL_PER_MMOL;
  return g > 35 ? g / MGDL_PER_MMOL : g; // unit-less: guess from magnitude
}

/** Bolus, carb and finger-stick events: { t, type: 'bolus'|'carbs'|'bg', v }. */
export function eventSeries (treatments) {
  const events = [];
  for (const d of treatments) {
    const t = docTime(d);
    if (t == null) continue;
    const insulin = num(d.insulin);
    if (insulin > 0 && BOLUS_TYPES.has(d.type)) events.push({ t, type: 'bolus', v: Math.round(insulin * 100) / 100, smb: d.type === 'SMB' || !!d.isSMB });
    const carbs = num(d.carbs);
    if (carbs > 0) events.push({ t, type: 'carbs', v: Math.round(carbs) });
    if (d.eventType === 'BG Check') {
      const v = bgCheckMmol(d);
      if (v) events.push({ t, type: 'bg', v });
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

// --- basal ---------------------------------------------------------------

function parseProfileJson (p) {
  if (!p) return null;
  if (typeof p === 'string') {
    try {
      return JSON.parse(p);
    } catch {
      return null;
    }
  }
  return p;
}

/** Normalizes a profile basal schedule to [{ s: secondsFromMidnight, v }]. */
export function basalSchedule (profile) {
  const basal = profile?.basal;
  if (!Array.isArray(basal) || !basal.length) return null;
  return basal
    .map((b) => {
      let s = num(b.timeAsSeconds);
      if (s == null && typeof b.time === 'string') {
        const [h, m] = b.time.split(':').map(Number);
        s = h * 3600 + (m || 0) * 60;
      }
      return { s: s ?? 0, v: num(b.value) ?? 0 };
    })
    .sort((a, b) => a.s - b.s);
}

function scheduleRate (schedule, t, timeshiftH = 0) {
  const d = new Date(t + timeshiftH * HOUR);
  const s = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let rate = schedule[0].v;
  for (const b of schedule) if (s >= b.s) rate = b.v;
  return rate;
}

/** Profile in effect over time: [{ t, schedule, pct, shift }] ascending. */
export function profileTimeline (profileDoc, switches) {
  const timeline = [];
  const store = profileDoc?.store || {};
  const defaultName = profileDoc?.defaultProfile;
  const def = basalSchedule(store[defaultName]) || basalSchedule(Object.values(store)[0]);
  if (def) timeline.push({ t: -Infinity, schedule: def, pct: 100, shift: 0 });
  for (const d of switches) {
    const t = docTime(d);
    if (t == null) continue;
    if (d.eventType === 'Effective Profile Switch') {
      const sched = basalSchedule(parseProfileJson(d.profileJson));
      if (sched) timeline.push({ t, schedule: sched, pct: 100, shift: 0 });
    } else if (d.eventType === 'Profile Switch') {
      const sched = basalSchedule(parseProfileJson(d.profileJson)) || basalSchedule(store[d.profile]) || def;
      if (sched) timeline.push({ t, schedule: sched, pct: num(d.percentage) ?? 100, shift: num(d.timeshift) ?? 0 });
    }
  }
  return timeline.sort((a, b) => a.t - b.t);
}

function profileRateAt (timeline, t) {
  let p = null;
  for (const x of timeline) if (x.t <= t) p = x;
  if (!p) return null;
  return scheduleRate(p.schedule, t, p.shift) * p.pct / 100;
}

/** Temp basals with their effective end (a newer temp basal replaces an older one). */
export function tempBasals (treatments) {
  const tbs = treatments
    .filter((d) => d.eventType === 'Temp Basal')
    .map((d) => {
      const t = docTime(d);
      const ms = num(d.durationInMilliseconds) ?? (num(d.duration) ?? 0) * MIN;
      return { t, end: t + ms, absolute: num(d.absolute) ?? num(d.rate), percent: num(d.percent) };
    })
    .filter((x) => x.t != null)
    .sort((a, b) => a.t - b.t);
  for (let i = 0; i < tbs.length - 1; i++) tbs[i].end = Math.min(tbs[i].end, tbs[i + 1].t);
  return tbs.filter((x) => x.end > x.t);
}

/**
 * Delivered vs. profile basal as step segments { t0, t1, rate, prof } over [start, end).
 */
export function basalSegments ({ start, end, timeline, temps }) {
  if (!timeline.length) return [];
  const cuts = new Set([start, end]);
  for (const x of timeline) if (x.t > start && x.t < end) cuts.add(x.t);
  for (const tb of temps) {
    if (tb.t > start && tb.t < end) cuts.add(tb.t);
    if (tb.end > start && tb.end < end) cuts.add(tb.end);
  }
  // Profile schedule boundaries, for every day in the window.
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  for (let d = day.getTime(); d < end; d += 24 * HOUR) {
    for (const x of timeline) {
      for (const b of x.schedule) {
        const c = d + b.s * 1000 - x.shift * HOUR;
        if (c > start && c < end) cuts.add(c);
      }
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const segs = [];
  // Temp basals are sorted and do not overlap: walk them alongside the cuts.
  let k = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i];
    const t1 = sorted[i + 1];
    const mid = (t0 + t1) / 2;
    const prof = profileRateAt(timeline, mid);
    if (prof == null) continue;
    while (k < temps.length && temps[k].end <= mid) k++;
    const tb = k < temps.length && temps[k].t <= mid ? temps[k] : null;
    let rate = prof;
    if (tb) rate = tb.absolute != null ? tb.absolute : tb.percent != null ? prof * (1 + tb.percent / 100) : prof;
    const last = segs[segs.length - 1];
    if (last && last.t1 === t0 && last.rate === rate && last.prof === prof) last.t1 = t1;
    else segs.push({ t0, t1, rate, prof });
  }
  return segs;
}

/**
 * Delivered insulin per day over a trailing whole-day expansion of [start, end).
 * Basal comes from the delivered basal segments; bolus comes from treatment
 * events, so a basal-insulin treatment is never counted twice.
 */
export function insulinPerDay ({ start, end, basal, events }) {
  const days = Math.ceil(Math.max(0, end - start) / DAY);
  if (!days) return null;
  const from = end - days * DAY;
  const basalUnits = basal.reduce((total, segment) => {
    const t0 = Math.max(from, segment.t0);
    const t1 = Math.min(end, segment.t1);
    return total + (t1 > t0 ? segment.rate * (t1 - t0) / HOUR : 0);
  }, 0);
  const bolusUnits = events.reduce((total, event) => (
    event.type === 'bolus' && event.t >= from && event.t < end ? total + event.v : total
  ), 0);
  const total = basalUnits + bolusUnits;
  return { from, days, basalUnits, bolusUnits, total, perDay: total / days };
}

// --- loop status ---------------------------------------------------------

/** IOB / COB from the newest device status (AAPS/OpenAPS or Loop format). */
export function onBoard (devicestatus, now = Date.now()) {
  const ds = devicestatus.reduce((latest, d) => {
    if (!(d.openaps || d.loop)) return latest;
    return !latest || (docTime(d) ?? -Infinity) > (docTime(latest) ?? -Infinity) ? d : latest;
  }, null);
  if (!ds) return { iob: null, cob: null };
  const age = now - (docTime(ds) ?? 0);
  if (age > 30 * MIN) return { iob: null, cob: null };
  const oa = ds.openaps;
  if (oa) {
    const iobObj = Array.isArray(oa.iob) ? oa.iob[0] : oa.iob;
    return {
      iob: num(iobObj?.iob),
      cob: num(oa.suggested?.COB ?? oa.enacted?.COB),
    };
  }
  return { iob: num(ds.loop?.iob?.iob), cob: num(ds.loop?.cob?.cob) };
}

/** Assembles everything the page draws for [start, now] (default: the last `hours`). */
export function buildModel ({ entries, treatments, heartrate, devicestatus, predictions, profile, switchesBefore = [], now = Date.now(), hours = 24, start = now - hours * HOUR }) {
  const end = now;
  const g = glucoseSeries(entries).filter((p) => p.t >= start - 6 * HOUR);
  const hr = heartRateSeries(heartrate);
  const events = eventSeries(treatments).filter((e) => e.t >= start && e.t <= end);
  const switches = [...switchesBefore, ...treatments.filter((d) => /Profile Switch$/.test(d.eventType || ''))];
  const timeline = profileTimeline(profile, switches);
  const basal = basalSegments({ start, end, timeline, temps: tempBasals(treatments) });
  return { start, end, g, hr, forecast: forecastSeries(predictions), cobSeries: cobSeries(devicestatus), events, basal, ...onBoard(devicestatus, now) };
}
