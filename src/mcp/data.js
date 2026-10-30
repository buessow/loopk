// What the MCP tools (server.js) return: loopk's records and the values
// computed from them, shaped for an agent. Glucose comes in the unit the
// agent asks for (mmol/L or mg/dL); times are ISO 8601 in the person's time
// zone. The database keeps glucose in mg/dL.

import { predict, recentRecords, zoneOffset } from '../predict/index.js';
import { hourlyTotals, COLUMNS } from '../reports/index.js';
import { profileUsage } from '../reports/profiles.js';
import { profileAt } from '../analysis/context.js';
import { algorithmPeriods, uniqueRuns } from '../analysis/guide.js';
import { findMisses, reasonPredictions, runLimits } from '../analysis/misses.js';
import { limitText, missSummary } from '../../public/misses.js';
import { gmiFromMmol } from '../../public/model.js';
import { MAX_DURATION, MIN_DURATION, viewSearch } from '../../public/view.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MGDL_PER_MMOL = 18;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

const ms = (d) => (d == null ? null : new Date(d).getTime());
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Glucose (mg/dL) in `units`: whole mg/dL or mmol/L to one decimal. */
export function glucose (mgdl, units) {
  if (mgdl == null || !Number.isFinite(mgdl)) return null;
  return units === 'mg/dL' ? Math.round(mgdl) : round(mgdl / MGDL_PER_MMOL, 1);
}

/** "2026-10-24T07:19:00+02:00": `t` (ms) in the time zone. */
export function localTime (t, timeZone) {
  if (t == null) return null;
  const offset = zoneOffset(t, timeZone);
  const local = new Date(Math.floor(t / 1000) * 1000 + offset * MIN).toISOString().slice(0, 19);
  const sign = offset < 0 ? '-' : '+';
  const a = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * A link to the glucose page showing [from, to] (ms) with the overlays in
 * `show` (view.js names; none: the reader's own), or null without a public
 * URL. Longer than the page shows at once: its last MAX_DURATION.
 */
export function pageLink (publicUrl, { from, to, show, timeZone }) {
  if (!publicUrl) return null;
  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, to - from));
  const start = to - duration;
  return `${publicUrl}/${viewSearch({ start, duration, show }, { offsetMinutes: zoneOffset(start, timeZone) })}`;
}

/** The person's time zone: TIME_ZONE, else the profile's, else UTC. */
export async function defaultTimeZone (ctx) {
  if (ctx.config?.timeZone) return ctx.config.timeZone;
  const p = await profileAt(ctx.data, Date.now());
  return p?.timezone || 'UTC';
}

// --- glucose, treatments, heart rate -------------------------------------

export async function glucoseReadings (data, { from, to, units, timeZone, publicUrl }) {
  const rows = await data.glucose.between(from, to);
  return {
    units,
    link: pageLink(publicUrl, { from, to, timeZone }),
    columns: ['time', 'glucose', 'trend'],
    readings: rows.map((r) => [localTime(ms(r.date), timeZone), glucose(r.sgv, units), r.direction || null]),
  };
}

// Temp target values are mg/dL; a few clients send mmol/L.
const targetMgdl = (v) => (v == null ? null : v < 30 ? v * MGDL_PER_MMOL : v);

export async function treatmentRecords (data, { from, to, units, timeZone }) {
  const rows = await data.treatments.between(from, to);
  return {
    units,
    treatments: rows.map((t) => {
      const out = { time: localTime(ms(t.date), timeZone), event: t.event_type };
      if (t.insulin > 0) {
        out.insulin = round(t.insulin, 3);
        out.smb = t.type === 'SMB' || t.is_smb === true;
      }
      if (t.carbs > 0) out.carbs = t.carbs;
      if (t.protein > 0) out.protein = t.protein;
      if (t.fat > 0) out.fat = t.fat;
      if (t.event_type === 'Temp Basal') {
        out.rate = round(t.rate, 3);
        if (t.percent != null && t.rate == null) out.percent = t.percent;
      }
      if (t.minutes != null && t.event_type !== 'Meal Bolus' && t.event_type !== 'Correction Bolus') out.minutes = round(t.minutes, 1);
      if (t.target_bottom != null) out.target = [glucose(targetMgdl(t.target_bottom), units), glucose(targetMgdl(t.target_top ?? t.target_bottom), units)];
      if (t.profile) out.profile = t.profile;
      if (t.percentage != null && t.percentage !== 100) out.percentage = t.percentage;
      if (t.timeshift) out.timeshift = t.timeshift;
      if (t.reason) out.reason = t.reason;
      if (t.notes) out.notes = t.notes;
      if (t.entered_by) out.enteredBy = t.entered_by;
      return out;
    }),
  };
}

export async function heartRate (data, { from, to, timeZone }) {
  const rows = await data.heartrate.between(from, to);
  return { columns: ['time', 'bpm'], readings: rows.map((r) => [localTime(ms(r.date), timeZone), r.bpm]) };
}

// --- statistics ----------------------------------------------------------

/**
 * Glucose, insulin, carb and heart-rate statistics of a set of hourly rows
 * (src/reports/index.js): the values loopk's page shows, and more.
 */
export function summarize (rows, units) {
  const sum = (c) => rows.reduce((s, r) => s + r[COL[c]], 0);
  const n = sum('readings');
  const hours = rows.length;
  const days = hours / 24;
  const mean = n ? sum('sgvSum') / n : null;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sum('sgvSquares') - n * mean * mean) / (n - 1))) : null;
  const pct = (c) => (n ? round(sum(c) / n * 100, 1) : null);
  const bolus = sum('bolus');
  const basal = sum('basal');
  const hr = sum('hrCount');
  return {
    hours,
    readings: n,
    // A CGM reading every 5 minutes is 100 %.
    coveragePercent: hours ? Math.min(100, round(n / (hours * 12) * 100, 1)) : null,
    meanGlucose: glucose(mean, units),
    sdGlucose: units === 'mg/dL' ? round(sd, 0) : round(sd == null ? null : sd / MGDL_PER_MMOL, 2),
    cvPercent: mean ? round(sd / mean * 100, 1) : null,
    gmiPercent: mean ? round(gmiFromMmol(mean / MGDL_PER_MMOL), 1) : null,
    timeInRangesPercent: {
      veryLow: pct('veryLow'),
      low: pct('low'),
      target: pct('target'),
      high: pct('high'),
      veryHigh: pct('veryHigh'),
    },
    insulin: {
      totalUnits: round(bolus + basal, 1),
      bolusUnits: round(bolus, 1),
      basalUnits: round(basal, 1),
      profileBasalUnits: round(sum('profileBasal'), 1),
      totalPerDay: days ? round((bolus + basal) / days, 1) : null,
      bolusPerDay: days ? round(bolus / days, 1) : null,
      basalPerDay: days ? round(basal / days, 1) : null,
    },
    carbs: { totalGrams: round(sum('carbs'), 0), perDay: days ? round(sum('carbs') / days, 0) : null },
    heartRate: { readings: hr, meanBpm: hr ? round(sum('hrSum') / hr, 0) : null },
  };
}

export const RANGES = {
  'mmol/L': { veryLow: '< 3.0', low: '3.0–3.8', target: '3.9–10.0', high: '10.1–13.9', veryHigh: '> 13.9' },
  'mg/dL': { veryLow: '< 54', low: '54–69', target: '70–180', high: '181–250', veryHigh: '> 250' },
};

export async function statistics (data, { from, to, units, timeZone, publicUrl, groupBy = 'none' }) {
  const totals = await hourlyTotals(data, { from, to, timeZone });
  const out = {
    from: localTime(totals.from, timeZone),
    to: localTime(totals.to, timeZone),
    units,
    link: pageLink(publicUrl, { from: totals.from, to: totals.to, timeZone }),
    ranges: RANGES[units],
    ...summarize(totals.rows, units),
  };
  if (groupBy === 'day' || groupBy === 'hour_of_day') {
    const groups = new Map();
    for (const row of totals.rows) {
      const local = row[COL.hour] * HOUR + row[COL.offset] * MIN;
      const key = groupBy === 'day' ? new Date(local).toISOString().slice(0, 10) : new Date(local).getUTCHours();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const keys = [...groups.keys()].sort((a, b) => (a < b ? -1 : 1));
    out[groupBy === 'day' ? 'days' : 'hoursOfDay'] = keys.map((k) => ({ [groupBy === 'day' ? 'date' : 'hour']: k, ...summarize(groups.get(k), units) }));
  }
  return out;
}

// --- profile ---------------------------------------------------------------

/** The profile in effect at `at`, with ISF and targets in `units`. */
export async function profile (data, { at, units, timeZone }) {
  const p = await profileAt(data, at);
  if (!p) return { available: false };
  const s = p.schedules || {};
  const mmolProfile = /mmol/i.test(p.units || '');
  const g = (v) => glucose(mmolProfile ? v * MGDL_PER_MMOL : v, units);
  const schedule = (list, f = (v) => v) => (list || []).map(([seconds, v]) => [hm(seconds), f(v)]);
  return {
    name: p.name,
    source: p.source,
    since: localTime(p.date, timeZone),
    percentage: p.percentage ?? 100,
    timeshiftHours: p.timeshift ?? 0,
    note: 'Schedules are the profile as stored, before the percentage and time shift of the switch.',
    timeZone: p.timezone,
    diaHours: p.dia,
    units,
    basalUnitsPerHour: schedule(s.basal),
    isfPerUnit: schedule(s.sens, g),
    carbRatioGramsPerUnit: schedule(s.carbratio),
    targetLow: schedule(s.target_low, g),
    targetHigh: schedule(s.target_high, g),
  };
}

const hm = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
const mean = (s) => (s?.n ? s.sum / s.n : null);
const sd = (s) => (s?.n > 1 ? Math.sqrt(Math.max(0, (s.sumSq - s.sum * s.sum / s.n) / (s.n - 1))) : null);

/** Basal profiles in use (src/reports/profiles.js), as means per hour of day instead of sums. */
export async function profiles (data, { from, to, timeZone }) {
  const u = await profileUsage(data, { from, to, timeZone });
  return {
    from: localTime(u.from, timeZone),
    to: localTime(u.to, timeZone),
    hours: round(u.minutes / 60, 1),
    notes: [
      'One entry per profile name and basal schedule version; percentages lists the time and insulin under each profile percentage.',
      'unitsPerDay is over whole local days under that profile and percentage; byHourOfDay rows are [hour, mean basal U/h, mean bolus incl. SMB U/h, mean autosens/dynamic sensitivity ratio] over whole local hours.',
    ],
    profiles: u.profiles.map((p) => ({
      name: p.name,
      basalUnitsPerHour: p.schedule.map(([seconds, rate]) => [hm(seconds), rate]),
      firstSeen: localTime(p.firstSeen, timeZone),
      lastSeen: localTime(p.lastSeen, timeZone),
      current: p.current,
      percentages: p.pcts.map((x) => ({
        percentage: x.pct,
        hours: round(x.minutes / 60, 1),
        basalUnits: round(x.basal, 1),
        bolusUnits: round(x.bolus, 1),
        meanSensitivityRatio: x.sensitivity?.minutes ? round(x.sensitivity.sum / x.sensitivity.minutes, 2) : null,
        unitsPerDay: x.days.n ? { days: x.days.n, mean: round(mean(x.days), 1), sd: round(sd(x.days), 1) } : null,
        byHourOfDay: x.hours.map((h, i) => [i, round(mean(h.basal), 3), round(mean(h.bolus), 3), round(mean(h.ratio), 2)]).filter((row) => row[1] != null || row[2] != null),
      })),
    })),
  };
}

// --- misses ------------------------------------------------------------------

const MISS_GLUCOSE = ['bg', 'eventual', 'target', 'minPredBG', 'minGuardBG', 'IOBpredBG', 'COBpredBG', 'UAMpredBG'];

// The overlays a link to a miss or loop runs turns on.
const LOOP_VIEW = ['basal', 'loop'];

export async function misses (data, { from, to, units, timeZone, publicUrl, kind = 'all' }) {
  const found = (await findMisses(data, { from, to })).filter((m) => kind === 'all' || m.kind === kind);
  const text = (v) => `${glucose(v, units)} ${units}`;
  return {
    units,
    misses: found.map((m) => {
      const e = m.expected;
      const expected = e && Object.fromEntries(Object.entries(e).map(([k, v]) => {
        if (k === 'at') return ['time', localTime(v, timeZone)];
        if (k === 'isf') return ['isfPerUnit', glucose(v, units)];
        if (k === 'iob' || k === 'insulinReq') return [k, round(v, 2)];
        if (k === 'cob') return [k, round(v, 0)];
        return [k, MISS_GLUCOSE.includes(k) ? glucose(v, units) : v];
      }));
      return {
        kind: m.kind,
        summary: missSummary(m, text),
        // As the page's list selects it: from what led to it to 30 minutes after.
        link: pageLink(publicUrl, { from: m.from, to: m.end + 30 * MIN, show: LOOP_VIEW, timeZone }),
        start: localTime(m.start, timeZone),
        end: localTime(m.end, timeZone),
        glucose: glucose(m.glucose, units),
        lowestOrHighestAt: localTime(m.at, timeZone),
        lookedFrom: localTime(m.from, timeZone),
        flags: m.flags,
        smbUnits: m.smb,
        smbCount: m.smbs,
        ownBolusUnits: m.bolus,
        carbs: m.carbs,
        ...(m.kind === 'low'
          ? { excessUnits: m.excess, missedBy: glucose(m.missedBy, units), rescueCarbs: m.rescueCarbs, smbAfterRescueUnits: m.smbAfterRescue }
          : { dosedFor: glucose(m.dosedFor, units), missingUnits: m.missing, causedByDuplicates: m.causedByDuplicates, limits: (m.limits || []).map((l) => ({ ...l, text: limitText(l) })) }),
        expected,
      };
    }),
  };
}

// --- the loop's runs (algorithm internals) ----------------------------------

const positive = (v) => (v != null && v >= 0 ? v : null);

export async function loopRuns (data, { from, to, units, timeZone, publicUrl, curves = false, console: withConsole = false }) {
  const [rows, config] = await Promise.all([
    data.loop.runs(from, to, withConsole),
    data.loop.configuration(to),
  ]);
  const runs = uniqueRuns(rows.map((r) => ({ ...r, date: ms(r.date) })));
  const predicted = new Map();
  if (curves && runs.length) {
    const list = await data.loop.curves(runs.map((r) => r.identifier));
    for (const c of list) {
      const run = predicted.get(c.id) || {};
      if (!run[c.curve]) run[c.curve] = c.values.map((v) => glucose(v, units));
      predicted.set(c.id, run);
    }
  }
  return {
    units,
    link: pageLink(publicUrl, { from, to, show: LOOP_VIEW, timeZone }),
    notes: [
      'bg, eventual, target, isfPerUnit and the predictions are in the requested units; reason is as AAPS wrote it, in the profile units.',
      'insulinReq is the extra insulin the run wanted on top of IOB; smb is the SMB it decided, smbGiven what the pump confirmed.',
      'temp is the temp basal it set or suggested (null: keep the running one); set is true when the run was enacted.',
      'predictionCurves hold one value per 5 minutes from the run (IOB, ZT, COB, UAM), as AAPS computed them.',
    ],
    configuration: config ? {
      time: localTime(ms(config.date), timeZone),
      aps: config.aps,
      sensitivityPlugin: config.sensitivity,
      insulinPlugin: config.insulin,
      aapsVersion: config.version,
      apsSettings: config.aps_settings,
      sensitivitySettings: config.sensitivity_settings,
      insulinSettings: config.insulin_settings,
      safetySettings: config.safety_settings,
    } : null,
    algorithmPeriods: algorithmPeriods(runs).map((p) => ({ from: localTime(p.from, timeZone), to: localTime(p.to, timeZone), algorithm: p.algorithm, dynamicIsf: p.dynamicIsf })),
    runs: runs.map((r) => {
      const p = reasonPredictions(r);
      const out = {
        time: localTime(r.date, timeZone),
        algorithm: r.algorithm,
        dynamicIsf: r.dynamic_isf,
        bg: glucose(r.bg, units),
        eventual: glucose(r.eventual_bg, units),
        target: glucose(r.target_bg, units),
        isfPerUnit: glucose(r.isf, units),
        sensitivityRatio: r.sensitivity_ratio,
        iob: round(r.iob, 2),
        basalIob: round(r.basal_iob, 2),
        cob: round(r.cob, 0),
        insulinReq: round(r.insulin_req, 2),
        carbsReq: r.carbs_req || null,
        minPredBG: glucose(p.minPredBG, units),
        minGuardBG: glucose(p.minGuardBG, units),
        predictedEnd: { IOB: glucose(p.IOBpredBG, units), COB: glucose(p.COBpredBG, units), UAM: glucose(p.UAMpredBG, units) },
        temp: positive(r.rate) != null ? { rate: r.rate, minutes: positive(r.duration) } : null,
        smb: r.smb || null,
        smbGiven: r.smb_given ?? null,
        set: r.enacted,
        limits: runLimits(r),
        reason: r.reason,
      };
      if (curves) out.predictionCurves = predicted.get(r.identifier) || {};
      if (withConsole) out.console = [...(r.console_error || []), ...(r.console_log || [])];
      return out;
    }),
  };
}

// --- now ---------------------------------------------------------------------

/** What the page's tiles show, and the state of the loop, now. */
export async function status (ctx, { units, timeZone, now = Date.now() }) {
  const { data } = ctx;
  const [readings, run, temp, target, hr, p, stats, sport, forecast] = await Promise.all([
    data.glucose.latest(now, 2),
    data.loop.latest(now),
    data.treatments.latestTempBasal(now),
    data.treatments.latestTempTarget(now),
    data.heartrate.latest(now),
    profile(data, { at: now, units, timeZone }),
    statistics(data, { from: now - DAY, to: now, units, timeZone }),
    ctx.sport?.state(now).catch(() => null),
    loopkForecast(ctx, units, timeZone).catch(() => null),
  ]);
  const [last, previous] = readings;
  const age = (d) => (d ? round((now - ms(d)) / MIN, 0) : null);
  const tempEnd = temp && ms(temp.date) + (temp.minutes || 0) * MIN;
  const targetEnd = target && ms(target.date) + (target.minutes || 0) * MIN;
  return {
    time: localTime(now, timeZone),
    units,
    glucose: last ? {
      value: glucose(last.sgv, units),
      time: localTime(ms(last.date), timeZone),
      minutesAgo: age(last.date),
      trend: last.direction || null,
      delta: previous && ms(last.date) - ms(previous.date) <= 15 * MIN ? glucose(last.sgv - previous.sgv, units) : null,
    } : null,
    loop: run ? {
      time: localTime(ms(run.date), timeZone),
      minutesAgo: age(run.date),
      algorithm: run.algorithm,
      iob: round(run.iob, 2),
      cob: round(run.cob, 0),
      eventual: glucose(run.eventual_bg, units),
      target: glucose(run.target_bg, units),
      reason: run.reason,
    } : null,
    tempBasal: temp && tempEnd > now && temp.minutes > 0
      ? { rate: temp.rate, since: localTime(ms(temp.date), timeZone), until: localTime(tempEnd, timeZone) }
      : null,
    tempTarget: target && target.minutes > 0 && targetEnd > now
      ? { target: [glucose(targetMgdl(target.bottom), units), glucose(targetMgdl(target.top ?? target.bottom), units)], reason: target.reason, until: localTime(targetEnd, timeZone) }
      : null,
    profile: p.available === false ? null : { name: p.name, percentage: p.percentage, since: p.since },
    sportMode: sport && sport.configured ? { active: sport.active, until: sport.active ? localTime(sport.until, timeZone) : null, percentage: sport.percentage, target: glucose(sport.target, units) } : null,
    heartRate: hr ? { bpm: hr.bpm, time: localTime(ms(hr.date), timeZone), minutesAgo: age(hr.date) } : null,
    loopkForecast: forecast,
    last24Hours: stats,
  };
}

/** loopk's own glucose forecast (a model uploaded on the Access page), or null. */
async function loopkForecast (ctx, units, timeZone) {
  const row = await ctx.models?.current();
  if (!row) return null;
  const { readings, treatments } = await recentRecords(ctx.data, row.model);
  const p = predict(readings, { model: row.model, treatments });
  if (!p.available) return { available: false, reason: p.reason };
  return {
    model: p.model,
    predictions: p.predictions.map((x) => ({ minutes: x.minutes, time: localTime(x.date, timeZone), glucose: glucose(x.sgv, units), low10: glucose(x.low, units), high90: glucose(x.high, units) })),
    lowProbability30: p.lowProbability30,
    lowWarning: p.lowWarning,
  };
}
