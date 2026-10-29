// Rebuilds what AAPS passed to determine_basal at a loop run, from loopk's
// readings, treatments and profiles: glucose status, IOB array, meal data,
// autosens, the profile with the settings, the current temp and, for
// AutoISF, its sensitivity and SMB decisions. A Replayer keeps the bucket
// grid, the autosens table and the TDD days between runs, as AAPS does, so
// runs are replayed in time order.
//
// The plugin code this follows (AndroidAPS, AGPL-3.0, commit 423a4502f2):
// plugins/aps/.../openAPSSMB/OpenAPSSMBPlugin.kt and
// plugins/aps/.../openAPSAutoISF/OpenAPSAutoISFPlugin.kt (invoke),
// plugins/source/.../BgQualityCheckPlugin.kt (doubled readings).

import { AutosensStore } from './autosens.js';
import { autoISF, determineVarSmbRatio, iobThreshold, loopSmb } from './autoisf.js';
import { dynIsf } from './dynisf.js';
import { BucketStore, glucoseStatusAutoIsf, glucoseStatusSMB, roundTo } from './glucose.js';
import { IobCalculator, MIN_DIA } from './iob.js';
import { PhoneClock, ProfileTimeline, localOffset } from './profile.js';

const MIN = 60000;
const HOUR = 60 * MIN;
/** AAPS loads 24 h plus the longest DIA (10 h) of readings. */
export const READINGS_HOURS = 34;
// The runs a rebuild needs for the ISF caches: each 5-minute bucket of the
// READINGS_HOURS averages the 24 h of ISFs before it (isfForCarbs).
export const ISF_CACHE_HOURS = READINGS_HOURS + 24;

/**
 * BgQualityCheckPlugin.processBgData: two readings at most 20 s apart among
 * the newest 11 (newest first) put the loop at max IOB 0.
 */
export function doubledReadings (readings) {
  const n = Math.min(readings.length - 2, 10);
  for (let i = 0; i < n; i++) {
    if (Math.abs(readings[i].timestamp - readings[i + 1].timestamp) <= 20 * 1000) return true;
  }
  return false;
}

function lowerBound (list, t, key = (x) => x.timestamp) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The temp target at t: { low, high } in mg/dL, or null. */
export function tempTargetAt (targets, t) {
  const i = lowerBound(targets, t + 1) - 1;
  const tt = i >= 0 ? targets[i] : null;
  return tt && t < tt.timestamp + tt.duration ? tt : null;
}

/**
 * Sets `planned` (ms) on temps: the duration the loop run that set the temp
 * asked for, or 30 minutes for a temp a later one cut short. Recorded
 * durations end at the next temp, while AAPS counts a running temp's
 * remaining minutes from its planned duration.
 */
export function plannedTempDurations (temps, runs) {
  let j = 0;
  for (let i = 0; i < temps.length; i++) {
    const tb = temps[i];
    while (j < runs.length && runs[j].timestamp < tb.timestamp - 2 * MIN) j++;
    let run = null;
    for (let k = j; k < runs.length && runs[k].timestamp <= tb.timestamp + 30 * 1000; k++) {
      if (runs[k].duration > 0 && runs[k].rate != null) run = runs[k];
    }
    const next = temps[i + 1];
    const cut = next && tb.timestamp + tb.duration >= next.timestamp - 10 * 1000;
    if (run) tb.planned = run.duration * MIN;
    else if (cut) tb.planned = 30 * MIN;
  }
}

/**
 * When AAPS knew of a treatment: the upload time if it came more than 5
 * minutes after the treatment's time while the phone was uploading other
 * records promptly (`prompt`: their times, sorted), so it was entered late;
 * otherwise its own time (an upload held back while offline).
 */
export function enteredLate (prompt) {
  return (t, uploaded) => {
    if (!uploaded || uploaded - t <= 5 * MIN) return t;
    const i = lowerBound(prompt, t + 1);
    return i < prompt.length && prompt[i] < uploaded - 2 * MIN ? uploaded : t;
  };
}

/**
 * History (all times in ms, sorted): readings [{ timestamp, value }],
 * boluses, temps, carbs, profiles (effective switches), tempTargets
 * [{ timestamp, duration, low, high }], siteChanges [t], profileSwitches [t]
 * (permanent), runs [{ timestamp, variableSens, glucose }] (for the average
 * ISF AAPS uses for carbs). `timeZone`: the phone's.
 */
export class Replayer {
  constructor (history, { timeZone } = {}) {
    this.history = history;
    this.timeZone = timeZone;
    this.profiles = new ProfileTimeline(history.profiles);
    this.autosens = null;
    this.tddCache = new Map();
    this.isfCaches = new Map();
    this.algorithm = null;
    this.knownCarbs = new Set();
    this.iob = null;
  }

  /**
   * Records a run's variable ISF in AAPS's 30-minute cache
   * (getAverageIsfMgdl). Each APS plugin keeps its own cache, so the
   * values of one algorithm don't reach another after a switch.
   */
  rememberIsf (t, glucose, sens, algorithm) {
    if (!(sens > 0)) return;
    if (!this.isfCaches.has(algorithm)) this.isfCaches.set(algorithm, new Map());
    this.isfCaches.get(algorithm).set(t - (t % (30 * MIN)) + Math.trunc(glucose), sens);
  }

  averageIsf (t, algorithm) {
    let sum = 0;
    let count = 0;
    for (const [key, value] of this.isfCaches.get(algorithm) || []) {
      if (key >= t - 24 * HOUR && key <= t) {
        sum += value;
        count++;
      }
    }
    return count ? sum / count : null;
  }

  /**
   * The inputs at `now` for `algorithm` ('SMB' or 'AUTO_ISF'), with
   * `dynamicIsf` for SMB, and the settings ({ values } of inferSettings).
   * Returns { input, autoIsf, profile, details } or { error }.
   */
  inputsAt (now, { algorithm, dynamicIsf = false, settings, maxIobOverride = null, recordedRatio = null }) {
    const s = settings;
    const h = this.history;
    const autoIsfAlgo = algorithm === 'AUTO_ISF';
    const profile = this.profiles.at(now);
    if (!profile) return { error: 'no profile' };
    if (!this.iob || this.iob.settingsKey !== `${s.insulinPeak}/${s.snoozeDivisor}`) {
      this.iob = new IobCalculator({ boluses: h.boluses, temps: h.temps, profiles: this.profiles, peak: s.insulinPeak, snoozeDivisor: s.snoozeDivisor });
      this.iob.settingsKey = `${s.insulinPeak}/${s.snoozeDivisor}`;
    }
    // a switch of the APS plugin recalculates the autosens table
    if (this.algorithm !== algorithm) {
      this.algorithm = algorithm;
      this.autosens = null;
    }
    if (!this.autosens) {
      this.autosens = new AutosensStore({ min5mCarbImpact: s.min5mCarbImpact, absorptionCutoff: s.absorptionCutoff, autosensMin: s.autosensMin, autosensMax: s.autosensMax });
    }

    // glucose: the readings AAPS had, newest first
    const from = lowerBound(h.readings, now - READINGS_HOURS * HOUR);
    const to = lowerBound(h.readings, now + 2 * MIN + 1);
    const bgReadings = h.readings.slice(from, to).reverse();
    // AAPS's worker swaps in a copy of its store that drops the reference
    // time (AutosensDataStoreObject.clone), so each bucketing anchors the
    // grid on the newest reading
    const bucketed = new BucketStore().bucket(bgReadings);
    if (!bucketed || !bucketed.length) return { error: 'no glucose' };
    if (bucketed[0].timestamp < now - 7 * MIN) return { error: 'glucose too old' };
    const glucoseStatus = autoIsfAlgo ? glucoseStatusAutoIsf(bucketed) : glucoseStatusSMB(bucketed);

    // the carbs AAPS knew of; one entered back-dated recalculates from its time
    const carbs = h.carbs.filter((c) => (c.knownAt ?? c.timestamp) <= now);
    for (const c of carbs) {
      if (c.knownAt > c.timestamp && !this.knownCarbs.has(c)) this.autosens.dropFrom(c.timestamp);
      this.knownCarbs.add(c);
    }

    // COB and autosens, for the 5-minute steps not done yet
    const hourOf = (t) => Math.floor(((t + localOffset(t, this.timeZone) * MIN) % (24 * HOUR) + 24 * HOUR) % (24 * HOUR) / HOUR);
    const minuteOf = (t) => new Date(t + localOffset(t, this.timeZone) * MIN).getUTCMinutes();
    const ctx = {
      now,
      iob: this.iob,
      profiles: this.profiles,
      carbs,
      siteChanges: h.siteChanges,
      profileSwitches: h.profileSwitches,
      hourOf,
      minuteOf,
      detectionStart: now - (24 + profile.dia) * HOUR,
      isfForCarbs: (t, p) => ((autoIsfAlgo || dynamicIsf) ? this.averageIsf(t, algorithm) : null) ?? p.getIsfMgdl(t),
      needRatio: recordedRatio == null && !(!autoIsfAlgo && dynamicIsf),
    };
    this.autosens.update(bucketed, ctx);
    this.autosens.prune(now - 36 * HOUR);

    // targets
    let minBg = roundTo(profile.getTargetLowMgdl(now), 0.1);
    let maxBg = roundTo(profile.getTargetHighMgdl(now), 0.1);
    let targetBg = profile.getTargetMgdl(now);
    const tt = tempTargetAt(h.tempTargets, now);
    const isTempTarget = tt != null;
    if (tt) {
      minBg = tt.low;
      maxBg = tt.high;
      targetBg = (tt.low + tt.high) / 2;
    }

    // autosens, or Dynamic ISF's TDD ratio
    const multiplier = (profile.percentage ?? 100) / 100;
    let dyn = null;
    let autosensResult = { ratio: 1.0 };
    if (!autoIsfAlgo && dynamicIsf) {
      dyn = dynIsf({ boluses: h.boluses, carbs, iob: this.iob }, {
        now, glucose: glucoseStatus.glucose, peak: s.insulinPeak, timeZone: this.timeZone, multiplier,
        settings: { adjustmentFactor: s.dynIsfAdjustmentFactor, adjustSensitivity: s.dynIsfAdjustSensitivity }, cache: this.tddCache,
      });
    }
    if (recordedRatio != null) {
      autosensResult = { ratio: recordedRatio };
    } else if (dyn) {
      autosensResult = { ratio: dyn.autosensRatio };
    } else if (s.autosens) {
      const last = this.autosens.last(now);
      if (!last) return { error: 'no autosens data' };
      last.autosensResult ??= this.autosens.detectSensitivity(bucketed, ctx, last.time);
      autosensResult = last.autosensResult;
    }

    const halfBasalTarget = s.half_basal_exercise_target;
    const iobArray = this.iob.arrayForSMB(now, {
      ratio: autosensResult.ratio, exerciseMode: s.exercise_mode, halfBasalExerciseTarget: halfBasalTarget, isTempTarget, targetMgdl: profile.getTargetMgdl(now),
    });
    const lastBolus = h.boluses[lowerBound(h.boluses, now + 1) - 1];
    const mealData = this.autosens.mealData(ctx, lastBolus ? lastBolus.timestamp : 0);
    const currenttemp = this.iob.currentTemp(now, profile);

    const doubled = doubledReadings(bgReadings);
    const maxIob = maxIobOverride ?? (doubled ? 0 : s.max_iob);
    const currentBasal = roundTo(profile.getBasal(now), s.bolus_increment); // the pump's base basal rate
    const outUnits = profile.toMgdl === 1 ? 'mg/dl' : 'mmol/L';
    const oapsProfile = {
      max_iob: maxIob,
      max_daily_basal: profile.getMaxDailyBasal(),
      max_basal: s.max_basal,
      min_bg: minBg,
      max_bg: maxBg,
      target_bg: targetBg,
      carb_ratio: profile.getIc(now),
      sens: profile.getIsfMgdl(now),
      max_daily_safety_multiplier: s.max_daily_safety_multiplier,
      current_basal_safety_multiplier: s.current_basal_safety_multiplier,
      lgsThreshold: s.lgsThreshold,
      high_temptarget_raises_sensitivity: autoIsfAlgo ? s.exercise_mode || s.highTemptargetRaisesSensitivity : false,
      low_temptarget_lowers_sensitivity: autoIsfAlgo ? s.lowTemptargetLowersSensitivity : false,
      sensitivity_raises_target: s.sensitivity_raises_target,
      resistance_lowers_target: s.resistance_lowers_target,
      adv_target_adjustments: s.adv_target_adjustments,
      exercise_mode: s.exercise_mode,
      half_basal_exercise_target: halfBasalTarget,
      maxCOB: s.maxCOB,
      skip_neutral_temps: s.skip_neutral_temps,
      remainingCarbsCap: s.remainingCarbsCap,
      enableUAM: s.enableUAM,
      A52_risk_enable: s.A52_risk_enable,
      SMBInterval: s.SMBInterval,
      enableSMB_with_COB: s.enableSMB_with_COB,
      enableSMB_with_temptarget: s.enableSMB_with_temptarget,
      allowSMB_with_high_temptarget: s.allowSMB_with_high_temptarget,
      enableSMB_always: s.enableSMB_always,
      enableSMB_after_carbs: s.enableSMB_after_carbs,
      maxSMBBasalMinutes: s.maxSMBBasalMinutes,
      maxUAMSMBBasalMinutes: s.maxUAMSMBBasalMinutes,
      bolus_increment: s.bolus_increment,
      carbsReqThreshold: s.carbsReqThreshold,
      current_basal: currentBasal,
      temptargetSet: isTempTarget,
      autosens_max: s.autosensMax,
      out_units: outUnits,
      variable_sens: dyn ? dyn.variableSensitivity : 0.0,
      insulinDivisor: dyn ? dyn.insulinDivisor : 0,
      TDD: dyn ? dyn.tdd : 0.0,
    };
    const input = {
      glucose_status: glucoseStatus,
      currenttemp,
      iob_data_array: iobArray,
      profile: oapsProfile,
      autosens_data: autosensResult,
      meal_data: mealData,
      microBolusAllowed: true,
      currentTime: now,
      flatBGsDetected: false,
      dynIsfMode: !!dyn,
      minuteOf: (t) => minuteOf(t),
    };

    if (autoIsfAlgo) {
      const consoleError = [];
      const consoleLog = [];
      const autoIsfSettings = {
        ...s,
        halfBasalTarget,
        autosensMax: s.autosensMax,
      };
      // autoISF() uses the profile ISF and the profile's (or temp) target
      const autoTarget = tt ? (tt.low + tt.high) / 2 : profile.getTargetMgdl(now);
      oapsProfile.variable_sens = autoISF({
        sens: profile.getIsfMgdl(now), glucose_status: glucoseStatus, target_bg: autoTarget, isTempTarget,
        autosensRatio: autosensResult.ratio, units: outUnits, settings: autoIsfSettings, consoleError,
      });
      oapsProfile.lgsThreshold = null;
      Object.assign(oapsProfile, {
        autoISF_version: '3.0.1',
        enable_autoISF: s.autoIsfWeights,
        smb_delivery_ratio: s.smb_delivery_ratio,
        smb_max_range_extension: s.smb_max_range_extension,
        iob_threshold_percent: s.iob_threshold_percent,
        profile_percentage: profile.percentage ?? 100,
      });
      const th = iobThreshold({ maxIob, target_bg: (minBg + maxBg) / 2, isTempTarget, profile_percentage: profile.percentage ?? 100, settings: autoIsfSettings });
      const loopWantedSmb = loopSmb({ microBolusAllowed: true, profile: oapsProfile, iob_data_iob: iobArray[0].iob, useIobTh: th.use_iobTH, iobThEffective: th.iobThEffective, settings: autoIsfSettings, consoleLog });
      const smbRatio = determineVarSmbRatio({ bg: Math.trunc(glucoseStatus.glucose), target_bg: (minBg + maxBg) / 2, loop_wanted_smb: loopWantedSmb, settings: autoIsfSettings, consoleLog });
      Object.assign(input, {
        autoIsfMode: true,
        loop_wanted_smb: loopWantedSmb,
        profile_percentage: profile.percentage ?? 100,
        smb_ratio: smbRatio,
        smb_max_range_extension: s.smb_max_range_extension,
        iob_threshold_percent: s.iob_threshold_percent,
        auto_isf_consoleError: consoleError,
        auto_isf_consoleLog: consoleLog,
      });
    }
    return {
      input,
      autoIsf: autoIsfAlgo,
      profile,
      details: { doubled, bucketedCount: bucketed.length, cob: mealData.mealCOB, autosensRatio: autosensResult.ratio, dyn },
    };
  }
}

// --- loading from the database --------------------------------------------

const VALID = 'is_valid IS DISTINCT FROM false';
const ms = (d) => (d == null ? null : new Date(d).getTime());

/**
 * The history for replaying runs in [from, to]: readings from 34 h and
 * treatments from 8 days before (TDD and DIA). `excludeDevices`: reading
 * sources to leave out.
 */
export async function loadHistory (pool, { from, to, excludeDevices = [] }) {
  const start = new Date(from - 8 * 24 * HOUR);
  const end = new Date(to + 2 * MIN);
  const q = (sql, params = [start, end]) => pool.query(sql, params).then((r) => r.rows);
  const [readings, boluses, temps, carbs, eps, schedules, targets, events] = await Promise.all([
    q(`SELECT date, sgv::float8 AS sgv, device FROM entries
        WHERE type = 'sgv' AND sgv IS NOT NULL AND date >= $1 AND date <= $2 AND ${VALID}
          AND NOT (coalesce(device, '') = ANY($3))
        ORDER BY date`, [new Date(from - (READINGS_HOURS + 1) * HOUR), end, excludeDevices]),
    q(`SELECT date, insulin::float8 AS insulin, (type = 'SMB' OR coalesce(is_smb, false)) AS smb FROM treatments
        WHERE insulin > 0 AND date >= $1 AND date <= $2 AND ${VALID}
          AND coalesce(type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED') AND coalesce(event_type, '') <> 'Combo Bolus'
        ORDER BY date`),
    q(`SELECT date, coalesce(duration_in_milliseconds, duration * 60000)::float8 AS duration_ms,
          coalesce(absolute, rate)::float8 AS rate, percent::float8 AS percent, srv_created, utc_offset FROM treatments
        WHERE event_type = 'Temp Basal' AND date >= $1 AND date <= $2 AND ${VALID}
        ORDER BY date`),
    q(`SELECT date, carbs::float8 AS carbs, srv_created FROM treatments
        WHERE carbs > 0 AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
    q(`SELECT t.identifier, t.date, t.original_profile_name AS name, coalesce(t.original_percentage, 100)::float8 AS percentage, p.dia::float8 AS dia, p.units, p.timezone
        FROM treatments t JOIN treatment_profiles p ON p.treatment_identifier = t.identifier
        WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND t.${VALID}
          AND t.date <= $2 AND t.date >= coalesce((SELECT max(date) FROM treatments
            WHERE event_type = 'Note' AND original_profile_name IS NOT NULL AND date <= $1 AND ${VALID}), '-infinity')
        ORDER BY t.date`),
    q(`SELECT s.treatment_identifier AS id, s.kind, coalesce(s.seconds, extract(epoch FROM s.time::time)::int) AS seconds, s.value::float8 AS value
        FROM treatment_profile_schedules s JOIN treatments t ON t.identifier = s.treatment_identifier
        WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND t.date <= $2
          AND t.date >= coalesce((SELECT max(date) FROM treatments
            WHERE event_type = 'Note' AND original_profile_name IS NOT NULL AND date <= $1 AND is_valid IS DISTINCT FROM false), '-infinity')
        ORDER BY s.treatment_identifier, s.kind, s.position`),
    q(`SELECT date, coalesce(duration, 0)::float8 AS duration, target_bottom::float8 AS low, target_top::float8 AS high, units
        FROM treatments WHERE event_type = 'Temporary Target' AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
    q(`SELECT date, event_type, coalesce(duration, 0)::float8 AS duration FROM treatments
        WHERE event_type IN ('Site Change', 'Profile Switch') AND date >= $1 AND date <= $2 AND ${VALID} ORDER BY date`),
  ]);

  const byId = new Map();
  for (const r of schedules) {
    if (!byId.has(r.id)) byId.set(r.id, {});
    const k = byId.get(r.id);
    (k[r.kind] ||= []).push([Number(r.seconds), r.value]);
  }
  // the phone's local time, from the offsets on its temp basals; else the profile's time zone
  const phoneClock = new PhoneClock(temps.map((r) => ({ timestamp: ms(r.date), offset: r.utc_offset })));
  const clock = phoneClock.empty ? null : phoneClock;
  const profiles = eps.map((p) => {
    const k = byId.get(p.identifier) || {};
    return {
      // switches before April 2026 were uploaded with a DIA of -1 ms (unset)
      date: ms(p.date), name: p.name, dia: Math.max(p.dia ?? MIN_DIA, MIN_DIA), units: p.units, timeZone: clock || p.timezone, percentage: p.percentage,
      basal: k.basal, ic: k.carbratio, isf: k.sens, targetLow: k.target_low, targetHigh: k.target_high,
    };
  }).filter((p) => p.basal && p.ic && p.isf && p.targetLow && p.targetHigh);

  // one reading per time, as AAPS keeps them
  const seen = new Set();
  const readingList = [];
  for (const r of readings) {
    const t = ms(r.date);
    if (seen.has(t)) continue;
    seen.add(t);
    readingList.push({ timestamp: t, value: r.sgv, device: r.device });
  }
  // the same bolus stored twice (pump sync and upload)
  const bolusList = [];
  for (const b of boluses) {
    const t = ms(b.date);
    const prev = bolusList[bolusList.length - 1];
    if (prev && prev.timestamp === t && prev.amount === b.insulin) continue;
    bolusList.push({ timestamp: t, amount: b.insulin, isSMB: b.smb });
  }
  // a temp basal ends at its duration or at the next one
  const tempList = [];
  temps.forEach((r, i) => {
    const t = ms(r.date);
    let duration = r.duration_ms || 0;
    const next = temps[i + 1] ? ms(temps[i + 1].date) : Infinity;
    duration = Math.min(duration, next - t);
    if (!(duration > 0)) return;
    if (r.rate != null) tempList.push({ timestamp: t, duration, rate: r.rate, isAbsolute: true });
    else if (r.percent != null) tempList.push({ timestamp: t, duration, rate: r.percent + 100, isAbsolute: false });
  });
  const tempTargets = [];
  targets.forEach((r, i) => {
    const t = ms(r.date);
    const next = targets[i + 1] ? ms(targets[i + 1].date) : Infinity;
    const duration = Math.min(r.duration * MIN, next - t);
    const factor = r.units && r.units.toLowerCase().startsWith('mmol') ? 18 : 1;
    if (duration > 0 && r.low != null) tempTargets.push({ timestamp: t, duration, low: r.low * factor, high: (r.high ?? r.low) * factor });
  });
  const knownAt = enteredLate(temps.filter((r) => r.srv_created && ms(r.srv_created) - ms(r.date) < 2 * MIN).map((r) => ms(r.date)));
  return {
    readings: readingList,
    boluses: bolusList,
    temps: tempList,
    carbs: carbs.map((c) => ({ timestamp: ms(c.date), amount: c.carbs, knownAt: knownAt(ms(c.date), c.srv_created && ms(c.srv_created)) })),
    profiles,
    tempTargets,
    siteChanges: events.filter((e) => e.event_type === 'Site Change').map((e) => ms(e.date)),
    profileSwitches: events.filter((e) => e.event_type === 'Profile Switch' && !(e.duration > 0)).map((e) => ms(e.date)),
    // the phone's local time (PhoneClock), or the profile's time zone name
    timeZone: clock || eps.at(-1)?.timezone || 'UTC',
  };
}

/** The recorded loop runs in [from, to], one per run time, oldest first. */
export async function loadRuns (pool, { from, to }) {
  const { rows } = await pool.query(`SELECT DISTINCT ON (suggested_deliver_at) date, suggested_deliver_at AS deliver_at,
      suggested_algorithm AS algorithm, suggested_running_dynamic_isf AS dynamic_isf,
      suggested_bg::float8 AS bg, suggested_eventual_bg::float8 AS eventual_bg, suggested_target_bg::float8 AS target_bg,
      suggested_insulin_req::float8 AS insulin_req, suggested_carbs_req::float8 AS carbs_req,
      suggested_cob::float8 AS cob, suggested_iob::float8 AS iob, suggested_rate::float8 AS rate,
      suggested_duration::float8 AS duration, suggested_units::float8 AS units,
      suggested_sensitivity_ratio::float8 AS sensitivity_ratio, suggested_variable_sens::float8 AS variable_sens,
      suggested_tick AS tick, suggested_reason AS reason,
      coalesce(suggested_console_error, '{}') AS console_error, coalesce(suggested_console_log, '{}') AS console_log,
      configuration_version AS version
    FROM devicestatus
    WHERE date >= $1 AND date <= $2 AND ${VALID} AND suggested_bg IS NOT NULL AND suggested_deliver_at IS NOT NULL
    ORDER BY suggested_deliver_at, date`, [new Date(from), new Date(to)]);
  return rows.map((r) => ({
    timestamp: Date.parse(r.deliver_at),
    algorithm: r.algorithm,
    dynamicIsf: r.dynamic_isf,
    bg: r.bg,
    eventualBG: r.eventual_bg,
    targetBG: r.target_bg,
    insulinReq: r.insulin_req,
    carbsReq: r.carbs_req,
    cob: r.cob,
    iob: r.iob,
    rate: r.rate,
    duration: r.duration,
    units: r.units,
    sensitivityRatio: r.sensitivity_ratio,
    variableSens: r.variable_sens,
    tick: r.tick,
    reason: r.reason,
    console: [...r.console_error, ...r.console_log],
  })).sort((a, b) => a.timestamp - b.timestamp);
}
