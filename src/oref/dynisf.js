// Dynamic ISF: the total daily doses (TDD) it weighs, the variable ISF,
// and the autosens ratio it uses instead of the Oref1 plugin's.
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// - implementation/.../stats/TddCalculatorImpl.kt
// - plugins/aps/.../openAPSSMB/OpenAPSSMBPlugin.kt (calculateRawDynIsf, invoke)

import { roundTo } from './glucose.js';
import { localOffset } from './profile.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local midnight at or before t in `timeZone`. */
export function midnight (t, timeZone) {
  const offset = localOffset(t, timeZone) * MIN;
  const m = Math.floor((t + offset) / DAY) * DAY - offset;
  // across a DST change the offset at midnight can differ
  const fixed = Math.floor((t + localOffset(m, timeZone) * MIN) / DAY) * DAY - localOffset(m, timeZone) * MIN;
  return fixed <= t ? fixed : m;
}

/**
 * TDD over [start, end]: boluses (all but priming) and the delivered basal
 * every 5 minutes; null when a profile is missing or nothing was delivered.
 * `history`: { boluses, carbs, iob (IobCalculator) }.
 */
export function tddInterval (history, start, end) {
  const startAligned = start - (start % (5 * MIN));
  const endAligned = end - (end % (5 * MIN));
  const tdd = { bolusAmount: 0, basalAmount: 0, totalAmount: 0, carbs: 0 };
  let tbrFound = false;
  for (const b of history.boluses) if (b.timestamp >= start && b.timestamp <= end) tdd.bolusAmount += b.amount;
  for (const c of history.carbs) if (c.timestamp >= start && c.timestamp <= end) tdd.carbs += c.amount;
  for (let t = startAligned; t < endAligned; t += 5 * MIN) {
    const basal = history.iob.basalAt(t);
    if (!basal) return null;
    if (basal.running) tbrFound = true;
    tdd.basalAmount += basal.rate / 60.0 * 5.0;
  }
  tdd.totalAmount = tdd.bolusAmount + tdd.basalAmount;
  return tdd.bolusAmount > 0 || tdd.basalAmount > 0 || tbrFound ? tdd : null;
}

/**
 * TddCalculator.calculate(days) + averageTDD: the average of the last
 * `days` whole days before `now`; null if a day is missing. Days are cached
 * in `cache` (a Map), as AAPS stores them.
 */
export function averageTdd (history, now, days, timeZone, cache) {
  let day = midnight(now, timeZone);
  const list = [];
  for (let k = 0; k < days; k++) {
    day = midnight(day - HOUR, timeZone);
    let tdd = cache.get(day);
    if (tdd === undefined) {
      tdd = tddInterval(history, day, midnight(day + 27 * HOUR, timeZone));
      cache.set(day, tdd);
    }
    if (!tdd) return null;
    list.push(tdd);
  }
  const avg = { bolusAmount: 0, basalAmount: 0, totalAmount: 0, carbs: 0 };
  let allDaysHaveCarbs = true;
  for (const t of list) {
    for (const k of Object.keys(avg)) avg[k] += t[k] / list.length;
    if (t.carbs === 0) allDaysHaveCarbs = false;
  }
  return { data: avg, allDaysHaveCarbs };
}

/** The insulin divisor by insulin peak (minutes). */
export const insulinDivisor = (peak) => (peak > 65 ? 55 : peak > 50 ? 65 : 75);

/**
 * calculateRawDynIsf and the TDD-based autosens ratio at `now`.
 * `settings`: { adjustmentFactor (%), adjustSensitivity }; `multiplier`: the
 * profile percentage / 100. Returns null when a TDD part is missing (AAPS
 * then falls back to plain SMB).
 */
export function dynIsf (history, { now, glucose, peak, timeZone, multiplier, settings, cache }) {
  const tdd1D = averageTdd(history, now, 1, timeZone, cache);
  const tdd7D = averageTdd(history, now, 7, timeZone, cache);
  const last24 = tddInterval(history, now - 24 * HOUR, now);
  const last4 = tddInterval(history, now - 4 * HOUR, now);
  const last8to4 = tddInterval(history, now - 8 * HOUR, now - 4 * HOUR);
  if (!tdd1D || !tdd7D || !last24 || !last4 || !last8to4) return null;
  const divisor = insulinDivisor(peak);
  const tddWeightedFromLast8H = ((1.4 * last4.totalAmount) + (0.6 * last8to4.totalAmount)) * 3;
  const tdd = ((tddWeightedFromLast8H * 0.33) + (tdd7D.data.totalAmount * 0.34) + (tdd1D.data.totalAmount * 0.33)) * settings.adjustmentFactor / 100.0 * multiplier;
  const variableSensitivity = roundTo(1800 / (tdd * Math.log((glucose / divisor) + 1)), 0.1);
  const tddRatio = settings.adjustSensitivity ? last24.totalAmount / tdd7D.data.totalAmount : 1.0;
  const carbsRatio = settings.adjustSensitivity && last24.carbs !== 0 && tdd7D.data.carbs !== 0 && tdd7D.allDaysHaveCarbs
    ? ((last24.carbs / tdd7D.data.carbs - 1.0) * 0.6) + 1.0
    : 1.0;
  return {
    tdd, variableSensitivity, insulinDivisor: divisor,
    tdd1D: tdd1D.data.totalAmount, tdd7D: tdd7D.data.totalAmount, tddLast24H: last24.totalAmount,
    autosensRatio: tddRatio / carbsRatio,
  };
}
