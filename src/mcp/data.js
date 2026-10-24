// What the MCP tools (server.js) return: loopk's records and the values
// computed from them, shaped for an agent. Glucose comes in the unit the
// agent asks for (mmol/L or mg/dL); times are ISO 8601 in the person's time
// zone. The database keeps glucose in mg/dL.

import { VALID_SGV, predict, recentRecords, zoneOffset } from '../predict/index.js';
import { hourlyTotals, COLUMNS } from '../reports/index.js';
import { profileUsage } from '../reports/profiles.js';
import { profileAt } from '../analysis/context.js';
import { algorithmPeriods, uniqueRuns } from '../analysis/prompt.js';
import { findMisses, reasonPredictions, runLimits } from '../analysis/misses.js';
import { limitText, missSummary } from '../../public/misses.js';
import { gmiFromMmol } from '../../public/model.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MGDL_PER_MMOL = 18;
const VALID = 'is_valid IS DISTINCT FROM false';
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

/** The person's time zone: TIME_ZONE, else the profile's, else UTC. */
export async function defaultTimeZone (ctx) {
  if (ctx.config?.timeZone) return ctx.config.timeZone;
  const p = await profileAt(ctx.pool, Date.now());
  return p?.timezone || 'UTC';
}

// --- glucose, treatments, heart rate -------------------------------------

export async function glucoseReadings (pool, { from, to, units, timeZone }) {
  const { rows } = await pool.query(
    `SELECT date, sgv::float8 AS sgv, direction FROM entries WHERE ${VALID_SGV} AND date >= $1 AND date < $2 ORDER BY date`,
    [new Date(from), new Date(to)]);
  return {
    units,
    columns: ['time', 'glucose', 'trend'],
    readings: rows.map((r) => [localTime(ms(r.date), timeZone), glucose(r.sgv, units), r.direction || null]),
  };
}

// Temp target values are mg/dL; a few clients send mmol/L.
const targetMgdl = (v) => (v == null ? null : v < 30 ? v * MGDL_PER_MMOL : v);

export async function treatmentRecords (pool, { from, to, units, timeZone }) {
  const { rows } = await pool.query(
    `SELECT date, event_type, type, is_smb, insulin::float8 AS insulin, carbs::float8 AS carbs,
       protein::float8 AS protein, fat::float8 AS fat,
       coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes,
       coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent,
       target_bottom::float8 AS target_bottom, target_top::float8 AS target_top,
       profile, percentage::float8 AS percentage, timeshift::float8 AS timeshift, reason, notes, entered_by
     FROM treatments
     WHERE date >= $1 AND date < $2 AND ${VALID} AND coalesce(type, '') <> 'PRIMING'
     ORDER BY date`,
    [new Date(from), new Date(to)]);
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

export async function heartRate (pool, { from, to, timeZone }) {
  const { rows } = await pool.query(
    `SELECT date, beats_per_minute::float8 AS bpm FROM heartrate
     WHERE date >= $1 AND date < $2 AND ${VALID} AND beats_per_minute BETWEEN 25 AND 250 ORDER BY date`,
    [new Date(from), new Date(to)]);
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

export async function statistics (pool, { from, to, units, timeZone, groupBy = 'none' }) {
  const totals = await hourlyTotals(pool, { from, to, timeZone });
  const out = {
    from: localTime(totals.from, timeZone),
    to: localTime(totals.to, timeZone),
    units,
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
export async function profile (pool, { at, units, timeZone }) {
  const p = await profileAt(pool, at);
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
export async function profiles (pool, { from, to, timeZone }) {
  const u = await profileUsage(pool, { from, to, timeZone });
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

export async function misses (pool, { from, to, units, timeZone, kind = 'all' }) {
  const found = (await findMisses(pool, { from, to })).filter((m) => kind === 'all' || m.kind === kind);
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
          : { dosedFor: glucose(m.dosedFor, units), missingUnits: m.missing, limits: (m.limits || []).map((l) => ({ ...l, text: limitText(l) })) }),
        expected,
      };
    }),
  };
}

// --- the loop's runs (algorithm internals) ----------------------------------

const RUNS = `SELECT identifier, date,
     coalesce(enacted_bg, suggested_bg)::float8 AS bg,
     coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg,
     coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
     coalesce(enacted_insulin_req, suggested_insulin_req)::float8 AS insulin_req,
     coalesce(enacted_carbs_req, suggested_carbs_req)::float8 AS carbs_req,
     coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob,
     iob_basaliob::float8 AS basal_iob,
     coalesce(enacted_cob, suggested_cob)::float8 AS cob,
     coalesce(enacted_sensitivity_ratio, suggested_sensitivity_ratio)::float8 AS sensitivity_ratio,
     coalesce(enacted_variable_sens, suggested_variable_sens)::float8 AS isf,
     coalesce(enacted_rate, suggested_rate)::float8 AS rate,
     coalesce(enacted_duration, suggested_duration)::float8 AS duration,
     coalesce(enacted_units, suggested_units)::float8 AS smb,
     enacted_smb::float8 AS smb_given,
     coalesce(enacted_algorithm, suggested_algorithm) AS algorithm,
     coalesce(enacted_running_dynamic_isf, suggested_running_dynamic_isf) AS dynamic_isf,
     (enacted_reason IS NOT NULL OR enacted_bg IS NOT NULL) AS enacted,
     coalesce(enacted_reason, suggested_reason) AS reason,
     CASE WHEN $3 THEN coalesce(enacted_console_error, suggested_console_error) END AS console_error,
     CASE WHEN $3 THEN coalesce(enacted_console_log, suggested_console_log) END AS console_log
   FROM devicestatus
   WHERE date >= $1 AND date < $2 AND ${VALID}
     AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL OR suggested_reason IS NOT NULL)
   ORDER BY date`;

const CONFIGURATION = `SELECT date, configuration_aps AS aps, configuration_sensitivity AS sensitivity,
     configuration_insulin AS insulin, configuration_version AS version,
     aps_configuration AS aps_settings, sensitivity_configuration AS sensitivity_settings,
     insulin_configuration AS insulin_settings, safety_configuration AS safety_settings
   FROM devicestatus
   WHERE date <= $1 AND ${VALID} AND configuration_aps IS NOT NULL
   ORDER BY date DESC NULLS LAST LIMIT 1`;

// The predicted curves of a run, enacted ones before suggested ones.
const CURVES = `SELECT devicestatus_identifier AS id, source, curve, "values"
   FROM devicestatus_predictions WHERE devicestatus_identifier = ANY($1)
   ORDER BY CASE source WHEN 'enacted' THEN 0 ELSE 1 END`;

const positive = (v) => (v != null && v >= 0 ? v : null);

export async function loopRuns (pool, { from, to, units, timeZone, curves = false, console: withConsole = false }) {
  const [{ rows }, { rows: [config] }] = await Promise.all([
    pool.query(RUNS, [new Date(from), new Date(to), withConsole]),
    pool.query(CONFIGURATION, [new Date(to)]),
  ]);
  const runs = uniqueRuns(rows.map((r) => ({ ...r, date: ms(r.date) })));
  const predicted = new Map();
  if (curves && runs.length) {
    const { rows: list } = await pool.query(CURVES, [runs.map((r) => r.identifier)]);
    for (const c of list) {
      const run = predicted.get(c.id) || {};
      if (!run[c.curve]) run[c.curve] = c.values.map((v) => glucose(v, units));
      predicted.set(c.id, run);
    }
  }
  return {
    units,
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
  const { pool } = ctx;
  const [{ rows: readings }, { rows: [run] }, { rows: [temp] }, { rows: [target] }, { rows: [hr] }, p, stats, sport, forecast] = await Promise.all([
    pool.query(`SELECT date, sgv::float8 AS sgv, direction FROM entries WHERE ${VALID_SGV} AND date <= $1 ORDER BY date DESC NULLS LAST LIMIT 2`, [new Date(now)]),
    pool.query(`SELECT date, coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob, coalesce(enacted_cob, suggested_cob)::float8 AS cob,
        coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg, coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
        coalesce(enacted_algorithm, suggested_algorithm) AS algorithm, coalesce(enacted_reason, suggested_reason) AS reason
      FROM devicestatus WHERE date <= $1 AND ${VALID} AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL) ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(now)]),
    pool.query(`SELECT date, coalesce(absolute, rate)::float8 AS rate, coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes
      FROM treatments WHERE event_type = 'Temp Basal' AND date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(now)]),
    pool.query(`SELECT date, target_bottom::float8 AS bottom, target_top::float8 AS top, reason,
        coalesce(duration_in_milliseconds / 60000.0, duration)::float8 AS minutes
      FROM treatments WHERE event_type = 'Temporary Target' AND date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(now)]),
    pool.query(`SELECT date, beats_per_minute::float8 AS bpm FROM heartrate WHERE date <= $1 AND ${VALID} ORDER BY date DESC NULLS LAST LIMIT 1`, [new Date(now)]),
    profile(pool, { at: now, units, timeZone }),
    statistics(pool, { from: now - DAY, to: now, units, timeZone }),
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
  const { readings, treatments } = await recentRecords(ctx.pool, row.model);
  const p = predict(readings, { model: row.model, treatments });
  if (!p.available) return { available: false, reason: p.reason };
  return {
    model: p.model,
    predictions: p.predictions.map((x) => ({ minutes: x.minutes, time: localTime(x.date, timeZone), glucose: glucose(x.sgv, units), low10: glucose(x.low, units), high90: glucose(x.high, units) })),
    lowProbability30: p.lowProbability30,
    lowWarning: p.lowWarning,
  };
}
