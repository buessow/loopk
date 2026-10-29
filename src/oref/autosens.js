// Carbs on board, deviations and autosens: AAPS's oref1 worker, which walks
// the bucketed glucose every 5 minutes, and the Oref1 sensitivity plugin.
// The table of results is kept between runs, as AAPS keeps its
// autosensDataTable, so a run only computes the new 5 minutes.
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// - workflow/.../iob/IobCobOref1Worker.kt, CarbsInPastExtension.kt
// - implementation/.../iob/AutosensDataObject.kt
// - plugins/sensitivity/.../SensitivityOref1Plugin.kt, AbstractSensitivityPlugin.kt
// - plugins/main/.../iobCobCalculator/IobCobCalculatorPlugin.kt (getMealData)
// - core/utils/.../Percentile.kt

import { roundTo } from './glucose.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DEVIATION_TO_BE_EQUAL = 2.0;
const MIN_HOURS = 1.0;
const MIN_HOURS_FULL_AUTOSENS = 4.0;

const roundUpTime = (t) => (t % MIN === 0 ? t : (Math.trunc(t / MIN) + 1) * MIN);

function newAutosensData (time) {
  return {
    time,
    bg: 0.0,
    sens: 0.0,
    deviation: 0.0,
    validDeviation: false,
    activeCarbsList: [],
    this5MinAbsorption: 0.0,
    carbsFromBolus: 0.0,
    cob: 0.0,
    bgi: 0.0,
    delta: 0.0,
    avgDelta: 0.0,
    avgDeviation: 0.0,
    autosensResult: { ratio: 1.0 },
    slopeFromMaxDeviation: 0.0,
    slopeFromMinDeviation: 999.0,
    usedMinCarbsImpact: 0.0,
    failOverToMinAbsorptionRate: false,
    absorbing: false,
    mealCarbs: 0.0,
    mealStartCounter: 999,
    type: '',
    uam: false,
    extraDeviation: [],
  };
}

/** Percentile.percentile: linear interpolation between closest ranks of a sorted array. */
export function percentile (arr, p) {
  if (!arr.length) return 0.0;
  if (p <= 0) return arr[0];
  if (p >= 1) return arr[arr.length - 1];
  const index = arr.length * p;
  const lower = Math.floor(index);
  const upper = lower + 1;
  const weight = index % 1;
  return upper >= arr.length ? arr[lower] : arr[lower] * (1 - weight) + arr[upper] * weight;
}

/**
 * `settings`: { min5mCarbImpact, absorptionCutoff (h), autosensMin,
 * autosensMax }. `ctx` per run: { now, iob (IobCalculator), profiles,
 * isfForCarbs(t), carbs [{ timestamp, amount }] (sorted), siteChanges [t],
 * profileSwitches [t] (permanent switches), hourOf(t), minuteOf(t),
 * detectionStart }.
 */
export class AutosensStore {
  constructor (settings) {
    this.settings = settings;
    this.table = new Map();
    this.keys = []; // sorted
  }

  put (time, data) {
    if (!this.table.has(time)) {
      let i = this.keys.length;
      while (i > 0 && this.keys[i - 1] > time) i--;
      this.keys.splice(i, 0, time);
    }
    this.table.set(time, data);
  }

  /** Drops results older than t (they no longer reach any window). */
  prune (t) {
    let n = 0;
    while (n < this.keys.length && this.keys[n] < t) this.table.delete(this.keys[n++]);
    if (n) this.keys.splice(0, n);
  }

  /** Drops results at or after t, to recalculate them (newHistoryData). */
  dropFrom (t) {
    let n = this.keys.length;
    while (n > 0 && this.keys[n - 1] >= t) this.table.delete(this.keys[--n]);
    this.keys.length = n;
  }

  /** getAutosensDataAtTime: via the newest bucket at or before t. */
  atTime (bucketed, t, now) {
    if (t > now) return null;
    const previous = bucketed.find((b) => b.timestamp <= t);
    return previous ? this.table.get(roundUpTime(previous.timestamp)) ?? null : null;
  }

  /** getLastAutosensData: the newest result, if not older than 11 minutes. */
  last (now) {
    if (!this.keys.length) return null;
    const data = this.table.get(this.keys[this.keys.length - 1]);
    return data.time < now - 11 * MIN ? null : data;
  }

  carbsBetween (carbs, from, to) {
    return carbs.filter((c) => c.timestamp >= from && c.timestamp <= to);
  }

  /** IobCobOref1Worker over the bucketed data (newest first) at ctx.now. */
  update (bucketed, ctx) {
    if (!bucketed || bucketed.length < 3) return;
    const { now } = ctx;
    const s = this.settings;
    let previous = this.table.get(roundUpTime(bucketed[bucketed.length - 3].timestamp)) ?? null;
    for (let i = bucketed.length - 4; i >= 0; i--) {
      const bgTime = roundUpTime(bucketed[i].timestamp);
      if (bgTime > roundUpTime(now)) continue;
      const existing = this.table.get(bgTime);
      if (existing) {
        previous = existing;
        continue;
      }
      const profile = ctx.profiles.at(bgTime);
      if (!profile) continue;
      const ad = newAutosensData(bgTime);
      ad.activeCarbsList = previous ? previous.activeCarbsList.map((c) => ({ ...c })) : [];
      const bg = bucketed[i].value;
      if (bg < 39 || bucketed[i + 3].value < 39) continue;
      ad.bg = bg;
      const delta = bg - bucketed[i + 1].value;
      const avgDelta = (bg - bucketed[i + 3].value) / 3;
      const sens = ctx.isfForCarbs(bgTime, profile);
      const iob = ctx.iob.atTime(bgTime, now);
      const bgi = -iob.activity * sens * 5;
      const deviation = delta - bgi;
      const avgDeviation = Math.round((avgDelta - bgi) * 1000) / 1000.0;
      let slopeFromMaxDeviation = 0.0;
      let slopeFromMinDeviation = 999.0;

      if (i < bucketed.length - 16) { // we need 1h of data to calculate minDeviationSlope
        let maxDeviation = 0.0;
        let minDeviation = 999.0;
        const hourAgoData = this.atTime(bucketed, bgTime + 10 * 1000 - HOUR, now);
        if (hourAgoData != null) {
          const initialIndex = this.keys.indexOf(hourAgoData.time);
          for (let past = 1; past < 12; past++) {
            const key = this.keys[initialIndex + past];
            if (key == null) throw new Error(`autosens: no data ${past} steps after ${new Date(hourAgoData.time).toISOString()}`);
            const a = this.table.get(key);
            const deviationSlope = (a.avgDeviation - avgDeviation) / (a.time - bgTime) * 1000 * 60 * 5;
            if (a.avgDeviation > maxDeviation) {
              slopeFromMaxDeviation = Math.min(0.0, deviationSlope);
              maxDeviation = a.avgDeviation;
            }
            if (a.avgDeviation < minDeviation) {
              slopeFromMinDeviation = Math.max(0.0, deviationSlope);
              minDeviation = a.avgDeviation;
            }
          }
        }
      }
      // exclusive start (+1 ms), as AAPS since issue #4596
      for (const c of this.carbsBetween(ctx.carbs, bgTime - 5 * MIN + 1, bgTime)) {
        ad.carbsFromBolus += c.amount;
        if (c.amount > 0) ad.activeCarbsList.push({ time: c.timestamp, carbs: c.amount, min5minCarbImpact: s.min5mCarbImpact, remaining: c.amount });
      }

      // if we are absorbing carbs
      if (previous != null && previous.cob > 0) {
        const totalMinCarbsImpact = s.min5mCarbImpact;
        const ci = Math.max(deviation, totalMinCarbsImpact);
        if (ci !== deviation) ad.failOverToMinAbsorptionRate = true;
        ad.this5MinAbsorption = ci * profile.getIc(bgTime) / sens;
        ad.cob = Math.max(previous.cob - ad.this5MinAbsorption, 0.0);
        ad.mealCarbs = previous.mealCarbs;
        deductAbsorbedCarbs(ad);
        ad.usedMinCarbsImpact = totalMinCarbsImpact;
        ad.absorbing = previous.absorbing;
        ad.mealStartCounter = previous.mealStartCounter;
        ad.type = previous.type;
        ad.uam = previous.uam;
      }
      removeOldCarbs(ad, bgTime, s.absorptionCutoff);
      ad.cob = Math.max(ad.cob + ad.carbsFromBolus, 0.0);
      ad.mealCarbs += ad.carbsFromBolus;
      ad.deviation = deviation;
      ad.bgi = bgi;
      ad.sens = sens;
      ad.delta = delta;
      ad.avgDelta = avgDelta;
      ad.avgDeviation = avgDeviation;
      ad.slopeFromMaxDeviation = slopeFromMaxDeviation;
      ad.slopeFromMinDeviation = slopeFromMinDeviation;

      // If mealCOB is zero but all deviations since hitting COB=0 are positive, exclude from autosens
      if (ad.cob > 0 || ad.absorbing || ad.mealCarbs > 0) {
        ad.absorbing = deviation > 0;
        // stop excluding positive deviations as soon as mealCOB=0 if meal has been absorbing for >5h
        if (ad.mealStartCounter > 60 && ad.cob < 0.5) ad.absorbing = false;
        if (!ad.absorbing && ad.cob < 0.5) ad.mealCarbs = 0.0;
        if (ad.type !== 'csf') ad.mealStartCounter = 0;
        ad.mealStartCounter++;
        ad.type = 'csf';
      } else {
        const currentBasal = profile.getBasal(bgTime);
        // always exclude the first 45m after each carb entry
        if (iob.iob > 2 * currentBasal || ad.uam || ad.mealStartCounter < 9) {
          ad.mealStartCounter++;
          ad.uam = deviation > 0;
          ad.type = 'uam';
        } else {
          ad.type = 'non-meal';
        }
      }
      // Exclude meal-related deviations (carb absorption) from autosens
      if (ad.type === 'non-meal') ad.validDeviation = true;
      void DEVIATION_TO_BE_EQUAL; // only labels the deviation in AAPS's log

      // add one neutral deviation every 2 hours to help decay over long exclusion periods
      if (ctx.minuteOf(bgTime) <= 4 && ctx.hourOf(bgTime) % 2 === 0) ad.extraDeviation.push(0.0);
      previous = ad;
      if (bgTime < now) this.put(bgTime, ad);
      // left for later when the caller has its ratio (a replay with AAPS's)
      ad.autosensResult = ctx.needRatio === false ? null : this.detectSensitivity(bucketed, ctx, bgTime);
    }
  }

  /** SensitivityOref1Plugin.detectSensitivity over [ctx.detectionStart, toTime]. */
  detectSensitivity (bucketed, ctx, toTime) {
    const s = this.settings;
    const profile = ctx.profiles.at(ctx.now);
    if (!profile || this.keys.length < 4) return { ratio: 1.0 };
    const current = this.atTime(bucketed, toTime, ctx.now);
    if (!current) return { ratio: 1.0 };
    const fromTime = ctx.detectionStart;
    const deviationsHour = [[], []];
    const deviationCategory = [96.0, 288.0];
    const hoursDetection = [8.0, 24.0];
    const fiveMinBack = (list, time) => list.some((t) => t <= time && t > time - 5 * MIN);
    for (const key of this.keys) {
      const ad = this.table.get(key);
      if (ad.time < fromTime || ad.time > toTime) continue;
      for (let h = 0; h < 2; h++) {
        const deviations = deviationsHour[h];
        // reset deviations after site change or a profile switch
        if (fiveMinBack(ctx.siteChanges, ad.time) || fiveMinBack(ctx.profileSwitches, ad.time)) deviations.length = 0;
        let deviation = ad.deviation;
        // set positive deviations to zero if bg < 80
        if (ad.bg < 80 && deviation > 0) deviation = 0.0;
        if (ad.validDeviation && ad.time > toTime - hoursDetection[h] * HOUR) deviations.push(deviation);
        deviations.push(...ad.extraDeviation);
        if (deviations.length > deviationCategory[h]) deviations.shift();
      }
    }
    // when we have less than 8h/24 worth of deviation data, add up to 90m of zero deviations
    for (let h = 0; h < 2; h++) {
      const deviations = deviationsHour[h];
      if (deviations.length < deviationCategory[h]) {
        const pad = Math.round((1 - deviations.length / deviationCategory[h]) * 18);
        for (let k = 0; k < pad; k++) deviations.push(0.0);
      }
    }
    const sens = current.sens;
    const ratios = deviationsHour.map((list) => {
      const sorted = list.slice().sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.50);
      let basalOff = 0.0;
      if (p50 < 0) basalOff = p50 * (60.0 / 5) / sens; // sensitive
      else if (p50 > 0) basalOff = p50 * (60.0 / 5) / sens; // resistant
      return 1 + basalOff / profile.getMaxDailyBasal();
    });
    // use the 24 hour ratio, or the 8 hour one when it is lower
    const key = ratios[0] < ratios[1] ? 0 : 1;
    return {
      ...fillResult(ratios[key], current.cob, deviationsHour[key].length, s.autosensMin, s.autosensMax),
      hours: key === 0 ? 8 : 24,
      rawRatios: ratios,
      deviations: deviationsHour.map((d) => d.length),
    };
  }

  /** getMealDataWithWaitingForCalculationFinish at ctx.now. */
  mealData (ctx, lastBolusTime) {
    const result = { carbs: 0.0, mealCOB: 0.0, slopeFromMaxDeviation: 0.0, slopeFromMinDeviation: 999.0, lastBolusTime, lastCarbTime: 0, usedMinCarbsImpact: 0.0 };
    const absorptionTimeAgo = ctx.now - Math.trunc(this.settings.absorptionCutoff * HOUR);
    for (const c of this.carbsBetween(ctx.carbs, absorptionTimeAgo + 1, ctx.now)) {
      if (c.amount !== 0) {
        result.carbs += c.amount;
        if (c.timestamp > result.lastCarbTime) result.lastCarbTime = c.timestamp;
      }
    }
    const ad = this.last(ctx.now);
    if (ad) {
      result.mealCOB = ad.cob;
      result.slopeFromMinDeviation = ad.slopeFromMinDeviation;
      result.slopeFromMaxDeviation = ad.slopeFromMaxDeviation;
      result.usedMinCarbsImpact = ad.usedMinCarbsImpact;
    }
    return result;
  }
}

function deductAbsorbedCarbs (ad) {
  let ac = ad.this5MinAbsorption;
  for (let i = 0; i < ad.activeCarbsList.length && ac > 0; i++) {
    const c = ad.activeCarbsList[i];
    if (c.remaining > 0) {
      const sub = Math.min(ac, c.remaining);
      c.remaining -= sub;
      ac -= sub;
    }
  }
}

function removeOldCarbs (ad, toTime, maxAbsorptionHours) {
  ad.activeCarbsList = ad.activeCarbsList.filter((c) => {
    if (c.time + maxAbsorptionHours * 60 * 60 * 1000 < toTime) {
      if (c.remaining > 0) ad.cob -= c.remaining;
      return false;
    }
    return true;
  });
}

/** AbstractSensitivityPlugin.fillResult: limits and phases in the ratio by the amount of data. */
export function fillResult (ratioParam, carbsAbsorbed, deviationsArraySize, ratioMin, ratioMax) {
  let ratio = Math.min(Math.max(ratioParam, ratioMin), ratioMax);
  const autosensContrib = (Math.min(Math.max(MIN_HOURS, deviationsArraySize / 12.0), MIN_HOURS_FULL_AUTOSENS) - MIN_HOURS) /
    (MIN_HOURS_FULL_AUTOSENS - MIN_HOURS);
  ratio = autosensContrib * (ratio - 1) + 1;
  return { ratio: roundTo(ratio, 0.01), carbsAbsorbed: roundTo(carbsAbsorbed, 0.01) };
}
