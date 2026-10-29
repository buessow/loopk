// Insulin on board as AAPS computes it: the oref exponential insulin curve,
// bolus IOB, temp basal IOB (net of the profile basal, or of the
// autosens-adjusted basal for determine_basal's array), and the IOB array
// with a zero temp for the 4 hours ahead.
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// - plugins/insulin/.../InsulinOrefBasePlugin.kt (iobCalcForTreatment)
// - core/objects/.../extensions/TemporaryBasalExtension.kt (iobCalc)
// - core/objects/.../extensions/IobTotalExtension.kt (round, combine)
// - plugins/main/.../iobCobCalculator/IobCobCalculatorPlugin.kt
// Boluses are { timestamp, amount, isSMB }; temp basals { timestamp,
// duration (ms), rate, isAbsolute } (rate in U/h or percent).

import { roundTo } from './glucose.js';
import { NORMAL_TARGET_MGDL } from './determinebasal.js';
import { roundHalfEven } from '../predict/grid.js';

const MIN = 60000;
const HOUR = 60 * MIN;

/** Insulin peak (minutes) by AAPS insulin plugin id: 2 rapid, 3 ultra-rapid, 5 Lyumjev. */
export const INSULIN_PEAK = { 2: 75, 3: 55, 5: 45 };

/**
 * The shortest DIA (hours) the insulin plugins use (HardLimits.MIN_DIA,
 * InsulinOrefBasePlugin.dia): a shorter or unset one counts as this.
 */
export const MIN_DIA = 5;

/** iobCalcForTreatment: { iobContrib, activityContrib } of `amount` given at `timestamp`. */
export function iobCalc (amount, timestamp, time, dia, peak) {
  if (amount === 0) return { iobContrib: 0, activityContrib: 0 };
  const t = (time - timestamp) / 1000.0 / 60.0;
  const td = dia * 60;
  const tp = peak;
  if (!(t < td)) return { iobContrib: 0, activityContrib: 0 };
  const tau = tp * (1 - tp / td) / (1 - 2 * tp / td);
  const a = 2 * tau / td;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  return {
    activityContrib: amount * (s / tau ** 2) * t * (1 - t / td) * Math.exp(-t / tau),
    iobContrib: amount * (1 - s * (1 - a) * ((t ** 2 / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1)),
  };
}

function iobTotal (time) {
  return { time, iob: 0, activity: 0, bolussnooze: 0, basaliob: 0, netbasalinsulin: 0, hightempinsulin: 0, lastBolusTime: 0, netInsulin: 0, iobWithZeroTemp: null };
}

function plus (a, b) {
  a.iob += b.iob;
  a.activity += b.activity;
  a.bolussnooze += b.bolussnooze;
  a.basaliob += b.basaliob;
  a.netbasalinsulin += b.netbasalinsulin;
  a.hightempinsulin += b.hightempinsulin;
  a.netInsulin += b.netInsulin;
  return a;
}

function roundIob (x) {
  x.iob = roundTo(x.iob, 0.001);
  x.activity = roundTo(x.activity, 0.0001);
  x.bolussnooze = roundTo(x.bolussnooze, 0.0001);
  x.basaliob = roundTo(x.basaliob, 0.001);
  x.netbasalinsulin = roundTo(x.netbasalinsulin, 0.001);
  x.hightempinsulin = roundTo(x.hightempinsulin, 0.001);
  x.netInsulin = roundTo(x.netInsulin, 0.001);
  return x;
}

function combine (bolusIOB, basalIob) {
  const r = iobTotal(bolusIOB.time);
  r.iob = bolusIOB.iob + basalIob.basaliob;
  r.activity = bolusIOB.activity + basalIob.activity;
  r.bolussnooze = bolusIOB.bolussnooze;
  r.basaliob = bolusIOB.basaliob + basalIob.basaliob;
  r.netbasalinsulin = bolusIOB.netbasalinsulin + basalIob.netbasalinsulin;
  r.hightempinsulin = basalIob.hightempinsulin + bolusIOB.hightempinsulin;
  r.netInsulin = basalIob.netInsulin + bolusIOB.netInsulin;
  r.lastBolusTime = bolusIOB.lastBolusTime;
  r.iobWithZeroTemp = basalIob.iobWithZeroTemp;
  return r;
}

const tempEnd = (tb) => tb.timestamp + tb.duration;

/**
 * TB.iobCalc. `sensitivity` (optional): { ratio, exerciseMode,
 * halfBasalExerciseTarget, isTempTarget, targetMgdl } for the variant that
 * counts temps against the autosens-adjusted basal.
 */
export function tempBasalIob (tb, time, profile, peak, sensitivity = null) {
  const result = iobTotal(time);
  const realDuration = Math.round((Math.min(time, tempEnd(tb)) - tb.timestamp) / 60.0 / 1000);
  let netBasalAmount = 0.0;
  let sensitivityRatio = 1;
  if (sensitivity) {
    sensitivityRatio = sensitivity.ratio;
    const normalTarget = NORMAL_TARGET_MGDL;
    if (sensitivity.exerciseMode && sensitivity.isTempTarget && sensitivity.targetMgdl >= normalTarget + 5) {
      const c = sensitivity.halfBasalExerciseTarget - normalTarget;
      sensitivityRatio = c / (c + sensitivity.targetMgdl - normalTarget);
    }
  }
  if (realDuration > 0) {
    const dia = profile.dia;
    const diaAgo = time - dia * 60 * 60 * 1000;
    const aboutFiveMinIntervals = Math.ceil(realDuration / 5.0);
    const tempBolusSpacing = realDuration / aboutFiveMinIntervals;
    for (let j = 0; j < aboutFiveMinIntervals; j++) {
      // find middle of the interval
      const calcDate = Math.trunc(tb.timestamp + j * tempBolusSpacing * 60 * 1000 + 0.5 * tempBolusSpacing * 60 * 1000);
      let netBasalRate;
      if (sensitivity) {
        const basalRate = profile.getBasal(calcDate) * sensitivityRatio;
        netBasalRate = tb.isAbsolute ? tb.rate - basalRate : tb.rate / 100.0 * profile.getBasal(calcDate) - basalRate;
      } else {
        const basalRate = profile.getBasal(calcDate);
        netBasalRate = tb.isAbsolute ? tb.rate - basalRate : (tb.rate - 100) / 100.0 * basalRate;
      }
      if (calcDate > diaAgo && calcDate <= time) {
        const tempBolusSize = netBasalRate * tempBolusSpacing / 60.0;
        netBasalAmount += tempBolusSize;
        const aIOB = iobCalc(tempBolusSize, calcDate, time, dia, peak);
        result.basaliob += aIOB.iobContrib;
        result.activity += aIOB.activityContrib;
        result.netbasalinsulin += tempBolusSize;
        if (tempBolusSize > 0) result.hightempinsulin += tempBolusSize;
      }
    }
  }
  result.netInsulin = netBasalAmount;
  return result;
}

/** Sorted index of the first record with timestamp >= t. */
function lowerBound (list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * IOB from a fixed treatment history, as IobCobCalculatorPlugin computes
 * it. `profiles.at(t)` gives the profile at a time; `peak` the insulin peak
 * (minutes); `snoozeDivisor` the bolus snooze divisor (AAPS default 2).
 */
export class IobCalculator {
  constructor ({ boluses, temps, profiles, peak, snoozeDivisor = 2 }) {
    this.boluses = boluses.slice().sort((a, b) => a.timestamp - b.timestamp);
    this.temps = temps.slice().sort((a, b) => a.timestamp - b.timestamp);
    this.profiles = profiles;
    this.peak = peak;
    this.snoozeDivisor = snoozeDivisor;
    this.cache = new Map();
  }

  /** Adds a bolus at or after the newest one (a simulated SMB). */
  addBolus (bolus) {
    this.boluses.splice(lowerBound(this.boluses, bolus.timestamp + 1), 0, bolus);
  }

  /**
   * Starts a temp basal (a simulated one) at its timestamp, after all
   * others: it ends the one running then, and a duration of 0 only ends it
   * (a cancel).
   */
  startTemp (tb) {
    const last = this.temps[this.temps.length - 1];
    if (last && tempEnd(last) > tb.timestamp) {
      const cut = tb.timestamp - last.timestamp;
      if (cut > 0) this.temps[this.temps.length - 1] = { ...last, duration: cut, planned: undefined };
      else this.temps.pop();
    }
    if (tb.duration > 0) this.temps.push(tb);
  }

  /** The temp basals as AAPS saw them at `now`: a running one is cut at now. */
  tempsAt (from, to, now) {
    const out = [];
    for (let i = lowerBound(this.temps, from); i < this.temps.length && this.temps[i].timestamp <= to; i++) {
      const t = this.temps[i];
      if (t.timestamp > now) break;
      out.push(tempEnd(t) > now ? { ...t, duration: now - t.timestamp } : t);
    }
    return out;
  }

  /** calculateIobFromBolusToTime: `now` is when the loop runs, `dia` the current profile's. */
  bolusIob (toTime, now, dia) {
    const total = iobTotal(toTime);
    for (let i = lowerBound(this.boluses, toTime - dia * HOUR); i < this.boluses.length; i++) {
      const t = this.boluses[i];
      if (t.timestamp >= toTime || t.timestamp > now) break;
      const tIOB = iobCalc(t.amount, t.timestamp, toTime, dia, this.peak);
      total.iob += tIOB.iobContrib;
      total.activity += tIOB.activityContrib;
      if (t.amount > 0 && t.timestamp > total.lastBolusTime) total.lastBolusTime = t.timestamp;
      if (!t.isSMB) {
        const snoozeTime = t.timestamp + Math.trunc((toTime - t.timestamp) * this.snoozeDivisor);
        total.bolussnooze += iobCalc(t.amount, t.timestamp, snoozeTime, dia, this.peak).iobContrib;
      }
    }
    return total;
  }

  basalIob (toTime, now, dia, sensitivity) {
    const total = iobTotal(toTime);
    for (const t of this.tempsAt(toTime - dia * HOUR, toTime, now)) {
      const profile = this.profiles.at(t.timestamp);
      if (!profile) continue;
      plus(total, tempBasalIob(t, toTime, profile, this.peak, sensitivity));
    }
    return total;
  }

  /**
   * calculateFromTreatmentsAndTemps(toTime, profile), as the COB and
   * autosens worker uses it for past times (cached like AAPS's iobTable).
   */
  atTime (toTime, now) {
    const time = toTime % MIN === 0 ? toTime : (Math.trunc(toTime / MIN) + 1) * MIN; // roundUpTime
    const cached = this.cache.get(time);
    if (cached && time < now) return cached;
    const profile = this.profiles.at(now);
    const dia = profile.dia;
    const bolusIob = roundIob(this.bolusIob(time, now, dia));
    const basalIob = roundIob(this.basalIob(time, now, dia, null));
    const withZeroTemp = { ...basalIob };
    const zero = { timestamp: now + MIN, duration: 240 * MIN, rate: 0, isAbsolute: true };
    if (zero.timestamp < time) plus(withZeroTemp, tempBasalIob(zero, time, this.profiles.at(time) || profile, this.peak));
    basalIob.iobWithZeroTemp = roundIob(combine(bolusIob, withZeroTemp));
    const total = roundIob(combine(bolusIob, basalIob));
    if (time < now) this.cache.set(time, total);
    return total;
  }

  /**
   * calculateIobArrayForSMB: 48 values, every 5 minutes from `now`, with
   * temps counted against the basal times `sensitivity.ratio`.
   */
  arrayForSMB (now, sensitivity) {
    const dia = this.profiles.at(now).dia;
    const out = [];
    for (let i = 0; i < 48; i++) {
      const time = now + i * 5 * MIN;
      const bolusIob = roundIob(this.bolusIob(time, now, dia));
      const basalIob = roundIob(this.basalIob(time, now, dia, sensitivity));
      const withZeroTemp = { ...basalIob };
      const zero = { timestamp: now + MIN, duration: 240 * MIN, rate: 0, isAbsolute: true };
      if (zero.timestamp < time) {
        const profile = this.profiles.at(zero.timestamp);
        if (profile) plus(withZeroTemp, tempBasalIob(zero, time, profile, this.peak, sensitivity));
      }
      basalIob.iobWithZeroTemp = roundIob(combine(bolusIob, withZeroTemp));
      out.push(roundIob(combine(bolusIob, basalIob)));
    }
    return out;
  }

  /** The temp basal running at `now`: CurrentTemp { duration (min left), rate (U/h) }. */
  currentTemp (now, profile) {
    const i = lowerBound(this.temps, now + 1) - 1;
    const tb = i >= 0 ? this.temps[i] : null;
    if (!tb || tempEnd(tb) <= now) return { duration: 0, rate: 0.0, minutesrunning: null };
    // the planned end: a temp that a later one cut short ran on as planned until then
    const plannedEnd = tb.timestamp + Math.max(tb.planned ?? 0, tb.duration);
    return {
      duration: Math.max(roundHalfEven((plannedEnd - now) / 1000.0 / 60), 0), // kotlin.math.round
      rate: tb.isAbsolute ? tb.rate : profile.getBasal(now) * tb.rate / 100,
      minutesrunning: Math.round((Math.min(now, tempEnd(tb)) - tb.timestamp) / 60.0 / 1000),
    };
  }

  /** The delivered basal rate at t (getBasalData): the temp, or the profile rate. */
  basalAt (t) {
    const profile = this.profiles.at(t);
    if (!profile) return null;
    const i = lowerBound(this.temps, t + 1) - 1;
    const tb = i >= 0 ? this.temps[i] : null;
    if (tb && t < tempEnd(tb)) return { running: true, rate: tb.isAbsolute ? tb.rate : profile.getBasal(t) * tb.rate / 100 };
    return { running: false, rate: profile.getBasal(t) };
  }
}
