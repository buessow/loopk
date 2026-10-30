// A period dosed with changed settings (docs/simulator-plan.md, phase 4).
// At each recorded loop run, the ported algorithm decides on the simulated
// state, and its SMBs and temp basals replace AAPS's; carbs, manual
// boluses, profile switches and temp targets stay as they were. Glucose is
// the actual glucose minus the effect of the insulin difference:
//
//   simulated BG(t) = actual BG(t) − Σ k × ISF(d) × (u − IOB of u left at t)
//
// over each difference u in delivered insulin (SMBs, and basal in 5-minute
// parts) at time d, with ISF the profile's at 100% at d and k the body's
// share of it. Everything the loop can't see comes from reality, so the
// error grows only with the insulin difference. The simulation starts again
// from the real state every 6 hours, as that model drifts over days, and
// runs at three values of k for a band.

import { episodes, loopMisses } from '../analysis/misses.js';
import { determineBasal } from './determinebasal.js';
import { roundTo } from './glucose.js';
import { ISF_CACHE_HOURS, Replayer, loadHistory, loadRuns, plannedTempDurations } from './inputs.js';
import { IobCalculator, iobCalc } from './iob.js';
import { ProfileTimeline } from './profile.js';
import { loadSettingsTimeline } from './settings.js';
import { ALGORITHMS, algorithmOptions, historyWithChanges, runAlgorithm, withStoredProfile } from './simulate.js';

const MIN = 60000;
const HOUR = 60 * MIN;
export const MAX_PERIOD = 14 * 24 * HOUR;
export const WINDOW = 6 * HOUR;
// The body's share of the profile ISF, from loopk's ISF check on clean stretches, and the band.
export const K_DEFAULT = 0.45;
const K_BAND = 0.15;
const BASAL_STEP = 0.05; // Omnipod Dash
const SENSOR = [39, 401];
const RANGES = [['veryLow', -Infinity, 54], ['low', 54, 70], ['target', 70, 180], ['high', 180, 250], ['veryHigh', 250, Infinity]];

const clip = (v) => Math.min(SENSOR[1], Math.max(SENSOR[0], v));

/** Sorted index after the last record with timestamp <= t. */
function upperBound (list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The delivered basal rate (U/h) at t: the temp running, or the profile's. */
function basalRateAt (iob, t) {
  return iob.basalAt(t)?.rate ?? 0;
}

/** The ISF at 100% (mg/dL per U) of the profile in effect at t. */
function isf100 (profiles, t) {
  const p = profiles.at(t);
  return p ? p.getIsfMgdl(t) * (p.percentage ?? 100) / 100 : null;
}

/**
 * One window [w0, w1): the runs in it, decided on the simulated state.
 * `actual`: the history; `changed`: it with the changes. Returns the
 * simulated readings, doses and runs.
 */
function simulateWindow (ctx, { w0, w1, k }) {
  const { actual, changed, runs, settingsAt, timeZone, changes, peak, dia } = ctx;
  const algorithmChange = changes.algorithm;
  // The simulated history: as it was before w0, the loop's doses from w0 on simulated.
  const boluses = changed.boluses.filter((b) => b.timestamp < w0 || !b.isSMB);
  // the temp running at w0 runs on as planned, until a simulated decision ends it
  const temps = changed.temps.filter((t) => t.timestamp < w0)
    .map((t) => (t.timestamp + t.duration >= w0 && t.planned > t.duration ? { ...t, duration: t.planned } : t));
  const readings = actual.readings.map((r) => ({ ...r }));
  const sim = { ...changed, boluses, temps, readings };
  const actualIob = new IobCalculator({ boluses: actual.boluses, temps: actual.temps, profiles: ctx.actualProfiles, peak });
  const actualSmbs = actual.boluses.filter((b) => b.isSMB && b.timestamp >= w0 && b.timestamp < w1);
  const simSmbs = [];
  const simTemps = [];
  const out = [];

  // Insulin differences, sim − actual: [t, units, k × ISF at t]
  const diffs = [];
  for (const b of actualSmbs) diffs.push([b.timestamp, -b.amount, k * (isf100(ctx.actualProfiles, b.timestamp) ?? 0)]);
  let basalDoneTo = w0; // basal differences counted up to here
  let readingsDone = 0; // readings[i] for i < readingsDone have their simulated value
  while (readingsDone < readings.length && readings[readingsDone].timestamp < w0) readingsDone++;
  const effectAt = (t) => {
    let e = 0;
    for (const [d, u, f] of diffs) if (d < t) e += f * (u - iobCalc(u, d, t, dia, peak).iobContrib);
    return e;
  };

  let replayer = null;
  for (const run of runs) {
    if (run.timestamp < w0 || run.timestamp >= w1) continue;
    const now = run.timestamp;
    if (!replayer) {
      replayer = new Replayer(sim, { timeZone });
      replayer.isfCaches = ctx.isfCachesAt(w0);
    }
    // basal differences up to now, in 5-minute parts, with the temps as they run now
    const simIob = replayer.iob;
    for (; basalDoneTo + 5 * MIN <= now; basalDoneTo += 5 * MIN) {
      const mid = basalDoneTo + 2.5 * MIN;
      const simRate = simIob ? basalRateAt(simIob, mid) : basalRateAt(new IobCalculator({ boluses: [], temps, profiles: new ProfileTimeline(changed.profiles), peak }), mid);
      const u = (simRate - basalRateAt(actualIob, mid)) * 5 / 60;
      if (Math.abs(u) > 1e-9) diffs.push([mid, u, k * (isf100(ctx.actualProfiles, mid) ?? 0)]);
    }
    // simulated glucose up to the readings this run sees
    for (; readingsDone < readings.length && readings[readingsDone].timestamp <= now + 2 * MIN; readingsDone++) {
      const r = readings[readingsDone];
      r.value = clip(Math.round(actual.readings[readingsDone].value - effectAt(r.timestamp)));
    }

    const algorithm = algorithmChange || runAlgorithm(run);
    const ratio = changes.sensitivityRatio ?? (algorithm === runAlgorithm(run) ? run.sensitivityRatio : null);
    const rebuilt = replayer.inputsAt(now, { ...algorithmOptions(algorithm), settings: settingsAt(now), recordedRatio: ratio });
    if (rebuilt.error) {
      out.push({ time: now, error: rebuilt.error });
      continue;
    }
    const result = determineBasal(rebuilt.input, { autoIsf: rebuilt.autoIsf });
    replayer.rememberIsf(now, rebuilt.input.glucose_status.glucose, result.variable_sens, algorithmOptions(algorithm).algorithm);
    // COB left after the carbs dropped out of the meal window makes AAPS's
    // predictions NaN (mealCOB / carbs); the run then sets nothing
    if (Number.isNaN(result.rate) || Number.isNaN(result.units)) {
      out.push({ time: now, error: 'no valid decision' });
      continue;
    }
    // the pump: the SMB, and the temp until the next decision or its end
    const iob = replayer.iob;
    if (result.units > 0) {
      const bolus = { timestamp: now + 1000, amount: result.units, isSMB: true };
      boluses.splice(upperBound(boluses, bolus.timestamp), 0, bolus);
      iob.addBolus(bolus);
      simSmbs.push(bolus);
      diffs.push([bolus.timestamp, bolus.amount, k * (isf100(ctx.actualProfiles, bolus.timestamp) ?? 0)]);
    }
    if (result.rate != null && result.duration != null) {
      const tb = { timestamp: now, duration: result.duration * MIN, planned: result.duration * MIN, rate: Math.max(0, roundTo(result.rate, BASAL_STEP)), isAbsolute: true };
      iob.startTemp(tb);
      temps.length = 0;
      temps.push(...iob.temps);
      if (tb.duration > 0) simTemps.push(tb);
    }
    out.push({
      time: now,
      bg: rebuilt.input.glucose_status.glucose,
      eventualBG: result.eventualBG ?? null,
      targetBG: result.targetBG ?? null,
      insulinReq: result.insulinReq ?? null,
      smb: result.units > 0 ? result.units : 0,
      rate: result.rate ?? null,
      duration: result.duration ?? null,
      iob: rebuilt.input.iob_data_array[0].iob,
      cob: rebuilt.input.meal_data.mealCOB,
      isf: result.variable_sens ?? null,
      reason: result.reason,
    });
  }
  // the rest of the window's readings, with the last temp running on
  const lastIob = replayer?.iob;
  for (; basalDoneTo + 5 * MIN <= w1; basalDoneTo += 5 * MIN) {
    const mid = basalDoneTo + 2.5 * MIN;
    if (!lastIob) break;
    const u = (basalRateAt(lastIob, mid) - basalRateAt(actualIob, mid)) * 5 / 60;
    if (Math.abs(u) > 1e-9) diffs.push([mid, u, k * (isf100(ctx.actualProfiles, mid) ?? 0)]);
  }
  for (; readingsDone < readings.length && readings[readingsDone].timestamp < w1; readingsDone++) {
    const r = readings[readingsDone];
    r.value = clip(Math.round(actual.readings[readingsDone].value - effectAt(r.timestamp)));
  }
  const inWindow = readings.filter((r) => r.timestamp >= w0 && r.timestamp < w1);
  // delivered basal of the simulation, as segments
  const basal = [];
  if (lastIob) {
    for (let t = w0; t < w1; t += 5 * MIN) basal.push([t, basalRateAt(lastIob, t + 2.5 * MIN)]);
  }
  return { readings: inWindow, smbs: simSmbs, temps: simTemps, basal, runs: out };
}

/** Time in the five ranges (% of readings), lows, highs and the mean, of readings [{ timestamp, value }]. */
export function glucoseStats (readings) {
  const n = readings.length;
  const ranges = Object.fromEntries(RANGES.map(([name, lo, hi]) => [name, n ? 100 * readings.filter((r) => r.value >= lo && r.value < hi).length / n : null]));
  const asEntries = readings.map((r) => ({ date: r.timestamp, sgv: r.value }));
  const minutesBelow = (v) => readings.filter((r) => r.value < v).length * 5;
  return {
    readings: n,
    mean: n ? readings.reduce((s, r) => s + r.value, 0) / n : null,
    ranges,
    lows70: episodes(asEntries, { below: 70, end: 80 }).length,
    lows54: episodes(asEntries, { below: 54, end: 70 }).length,
    minutesBelow70: minutesBelow(70),
    minutesBelow54: minutesBelow(54),
    highs250: episodes(asEntries, { above: 250, end: 230 }).length,
    minutesAbove250: readings.filter((r) => r.value > 250).length * 5,
  };
}

/** Insulin (U) delivered in [from, to): boluses (SMBs separately) and basal from the rate at each minute. */
function insulinStats (boluses, rateAt, from, to) {
  const inRange = boluses.filter((b) => b.timestamp >= from && b.timestamp < to);
  const smbs = inRange.filter((b) => b.isSMB);
  let basal = 0;
  for (let t = from; t < to; t += 5 * MIN) basal += rateAt(t + 2.5 * MIN) * 5 / 60;
  const sum = (list) => list.reduce((s, b) => s + b.amount, 0);
  return {
    total: sum(inRange) + basal,
    basal,
    bolus: sum(inRange) - sum(smbs),
    smb: sum(smbs),
    smbCount: smbs.length,
    largestSmb: smbs.reduce((m, b) => Math.max(m, b.amount), 0),
  };
}

/**
 * Simulates [from, to] (ms) with `changes` (simulate.js parseChanges) at
 * body ISF share `k`. Returns { from, to, k, windows, actual, simulated
 * (results at k, with low and high for the band), series, misses }.
 */
export async function simulatePeriod (data, { from, to, changes = {}, k = K_DEFAULT }) {
  const [history, allRuns] = await Promise.all([
    loadHistory(data, { from: from - 24 * HOUR, to }),
    loadRuns(data, { from: from - (ISF_CACHE_HOURS + 1) * HOUR, to }),
  ]);
  plannedTempDurations(history.temps, allRuns);
  const runs = allRuns;
  const settingsRuns = runs.filter((r) => r.timestamp >= Math.max(from - 24 * HOUR, to - 7 * 24 * HOUR));
  const timeline = await loadSettingsTimeline(data, { from, to, runs: settingsRuns, tempTargets: history.tempTargets });
  const settings = timeline.last;
  // the settings at each run (entered ones change over time), the changes on top
  const settingsAt = (t) => ({ ...timeline.at(t).values, ...changes.settings });
  const values = settingsAt(to);
  const timeZone = history.timeZone;
  const changed = historyWithChanges(history, await withStoredProfile(data, changes, from), from, to);
  const unsupported = runs.filter((r) => r.timestamp >= from && !ALGORITHMS.includes(runAlgorithm(r)));
  if (unsupported.length === runs.filter((r) => r.timestamp >= from).length) {
    return { from, to, k, error: 'No loop runs in that period that the simulator can decide' };
  }

  const ctx = {
    actual: history,
    changed,
    runs: runs.filter((r) => ALGORITHMS.includes(runAlgorithm(r))),
    settingsAt,
    timeZone,
    changes,
    peak: values.insulinPeak,
    dia: history.profiles.at(-1)?.dia ?? 5,
    actualProfiles: new ProfileTimeline(history.profiles),
    // the 30-minute ISF caches as AAPS had them at t
    isfCachesAt: (t) => {
      const r = new Replayer(history, { timeZone });
      for (const run of runs) if (run.timestamp < t && run.timestamp >= t - ISF_CACHE_HOURS * HOUR) r.rememberIsf(run.timestamp, run.bg, run.variableSens, run.algorithm);
      return r.isfCaches;
    },
  };

  const ks = [Math.max(0.05, k - K_BAND), k, k + K_BAND].map((x) => Math.round(x * 100) / 100);
  const results = ks.map((kk) => {
    const windows = [];
    for (let w0 = from; w0 < to; w0 += WINDOW) windows.push(simulateWindow(ctx, { w0, w1: Math.min(to, w0 + WINDOW), k: kk }));
    return windows;
  });
  const [low, mid, high] = results;
  const simReadings = mid.flatMap((w) => w.readings);
  const lowReadings = low.flatMap((w) => w.readings);
  const highReadings = high.flatMap((w) => w.readings);
  const actualReadings = history.readings.filter((r) => r.timestamp >= from && r.timestamp < to);
  const simBoluses = [
    ...history.boluses.filter((b) => !b.isSMB && b.timestamp >= from && b.timestamp < to),
    ...mid.flatMap((w) => w.smbs),
  ].sort((a, b) => a.timestamp - b.timestamp);
  const simBasal = mid.flatMap((w) => w.basal);
  const simRateAt = (t) => {
    let lo = 0;
    let hi = simBasal.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (simBasal[m][0] <= t) lo = m + 1;
      else hi = m;
    }
    return lo > 0 ? simBasal[lo - 1][1] : 0;
  };
  const actualIob = new IobCalculator({ boluses: history.boluses, temps: history.temps, profiles: ctx.actualProfiles, peak: ctx.peak });
  const actualRateAt = (t) => basalRateAt(actualIob, t);

  const stats = (readings, boluses, rateAt) => ({ ...glucoseStats(readings), insulin: insulinStats(boluses, rateAt, from, to) });
  const actualStats = stats(actualReadings, history.boluses, actualRateAt);
  const simStats = stats(simReadings, simBoluses, simRateAt);
  const band = (list) => glucoseStats(list);

  // the loop's misses, actual and simulated
  const runsForMisses = (list) => list.filter((r) => !r.error).map((r) => ({
    date: r.time ?? r.timestamp, bg: r.bg, eventual_bg: r.eventualBG, target_bg: r.targetBG, insulin_req: r.insulinReq, iob: r.iob, cob: r.cob, isf: r.isf ?? r.variableSens, reason: Array.isArray(r.reason) ? r.reason.join('') : r.reason,
  }));
  const treatments = (boluses) => [
    ...boluses.map((b) => ({ date: b.timestamp, insulin: b.amount, smb: b.isSMB })),
    ...history.carbs.filter((c) => c.timestamp >= from - HOUR && c.timestamp < to).map((c) => ({ date: c.timestamp, carbs: c.amount })),
  ].sort((a, b) => a.date - b.date);
  const entries = (list) => list.map((r) => ({ date: r.timestamp, sgv: r.value }));
  const readingTimes = history.readings.map((r) => r.timestamp);
  const recordedRuns = runs.filter((r) => r.timestamp >= from && r.timestamp < to).map((r) => ({ ...r, time: r.timestamp }));
  const actualMisses = loopMisses({ readings: entries(actualReadings), treatments: treatments(history.boluses.filter((b) => b.timestamp >= from - HOUR && b.timestamp < to)), runs: runsForMisses(recordedRuns), readingTimes });
  const simMisses = loopMisses({ readings: entries(simReadings), treatments: treatments(simBoluses), runs: runsForMisses(mid.flatMap((w) => w.runs)), readingTimes });
  const key = (m) => `${m.kind}@${Math.round(m.start / (30 * MIN))}`;
  const actualKeys = new Set(actualMisses.map(key));
  const simKeys = new Set(simMisses.map(key));
  const missSummary = (m) => ({ kind: m.kind, start: m.start, end: m.end, glucose: m.glucose });

  return {
    from,
    to,
    k,
    ks,
    windowHours: WINDOW / HOUR,
    settings: { values: settings.values, sources: settings.sources, changed: changes.settings || {} },
    changes,
    actual: actualStats,
    simulated: { ...simStats, low: band(lowReadings), high: band(highReadings) },
    misses: {
      actual: actualMisses.length,
      simulated: simMisses.length,
      gone: actualMisses.filter((m) => !simKeys.has(key(m))).map(missSummary),
      new: simMisses.filter((m) => !actualKeys.has(key(m))).map(missSummary),
      // all of them, each saying whether the other side has it too
      actualList: actualMisses.map((m) => ({ ...missSummary(m), both: simKeys.has(key(m)) })),
      simulatedList: simMisses.map((m) => ({ ...missSummary(m), both: actualKeys.has(key(m)) })),
    },
    errors: mid.flatMap((w) => w.runs.filter((r) => r.error)).length,
    series: {
      // [t, actual, simulated at k, at the low k, at the high k] (mg/dL)
      glucose: actualReadings.map((r, i) => [r.timestamp, r.value, simReadings[i]?.value ?? null, lowReadings[i]?.value ?? null, highReadings[i]?.value ?? null]),
      actualSmbs: history.boluses.filter((b) => b.isSMB && b.timestamp >= from && b.timestamp < to).map((b) => [b.timestamp, b.amount]),
      simulatedSmbs: mid.flatMap((w) => w.smbs).map((b) => [b.timestamp, b.amount]),
      boluses: history.boluses.filter((b) => !b.isSMB && b.timestamp >= from && b.timestamp < to).map((b) => [b.timestamp, b.amount]),
      carbs: history.carbs.filter((c) => c.timestamp >= from && c.timestamp < to).map((c) => [c.timestamp, c.amount]),
      actualBasal: simBasal.map(([t]) => [t, actualRateAt(t + 2.5 * MIN)]),
      simulatedBasal: simBasal,
      windows: mid.map((w, i) => from + i * WINDOW),
      // the simulated loop's decision at each run (mg/dL, U, U/h)
      runs: mid.flatMap((w) => w.runs).filter((r) => !r.error).map((r) => ({
        t: r.time, bg: r.bg, eventual: r.eventualBG, target: r.targetBG, insulinReq: r.insulinReq, smb: r.smb, rate: r.rate, duration: r.duration, iob: r.iob, cob: r.cob, isf: r.isf, reason: r.reason,
      })),
    },
  };
}
