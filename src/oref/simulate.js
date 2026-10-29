// What-if for one loop decision (docs/simulator-plan.md, phase 3): rebuild
// the inputs of a recorded run, decide with the settings and profile AAPS
// had, and again with changes, and return both decisions.
//
// Changes ({ settings, profile, algorithm, tempTarget, sensitivityRatio }):
// - settings: { key: value } over the loop settings (settings.js DEFAULTS);
// - profile: { name, percentage, isfFactor, carbRatioFactor, basalFactor,
//   targetMgdl }, applied to the profile in effect as a profile switch would;
//   name switches to another profile of AAPS's profile store (at the
//   percentage recorded, unless percentage is given);
// - algorithm: 'SMB', 'SMB+DynISF' or 'AUTO_ISF';
// - tempTarget: { targetMgdl, minutes } to set one, null to cancel one;
// - sensitivityRatio: the autosens ratio to use instead of AAPS's.

import { runLimits } from '../analysis/misses.js';
import { determineBasal } from './determinebasal.js';
import { MIN_DIA } from './iob.js';
import { MMOLL_TO_MGDL } from './format.js';
import { ISF_CACHE_HOURS, Replayer, loadHistory, loadRuns, plannedTempDurations, tempTargetAt } from './inputs.js';
import { sameAction } from './replay.js';
import { DEFAULTS, POSITIVE_SETTINGS, loadSettings, validSetting } from './settings.js';

const MIN = 60000;
const HOUR = 60 * MIN;
// How far a requested time may be from the run it means.
const RUN_WINDOW = 5 * MIN;

export const ALGORITHMS = ['SMB', 'SMB+DynISF', 'AUTO_ISF'];
const PROFILE_CHANGES = {
  percentage: [10, 500],
  isfFactor: [0.1, 10],
  carbRatioFactor: [0.1, 10],
  basalFactor: [0, 10],
  targetMgdl: [70, 250],
};

export class SimulationError extends Error {
  constructor (message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Checks and normalises changes; throws SimulationError for what doesn't fit. */
export function parseChanges (raw = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new SimulationError('changes must be an object');
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!['settings', 'profile', 'algorithm', 'tempTarget', 'sensitivityRatio'].includes(key)) throw new SimulationError(`Unknown change ${key}`);
  }
  if (raw.settings != null) {
    if (typeof raw.settings !== 'object') throw new SimulationError('settings must be an object');
    out.settings = {};
    for (const [key, value] of Object.entries(raw.settings)) {
      if (!Object.hasOwn(DEFAULTS, key)) throw new SimulationError(`Unknown setting ${key}`);
      if (!validSetting(key, value)) throw new SimulationError(`${key} must be ${DEFAULTS[key] === null ? 'a number or null' : POSITIVE_SETTINGS.has(key) ? 'a number above 0' : `a ${typeof DEFAULTS[key]}`}`);
      out.settings[key] = value;
    }
  }
  if (raw.profile != null) {
    if (typeof raw.profile !== 'object') throw new SimulationError('profile must be an object');
    out.profile = {};
    for (const [key, value] of Object.entries(raw.profile)) {
      if (key === 'name') {
        if (typeof value !== 'string' || !value) throw new SimulationError('profile.name must be the name of a stored profile');
        out.profile.name = value;
        continue;
      }
      const limits = PROFILE_CHANGES[key];
      if (!limits) throw new SimulationError(`Unknown profile change ${key}`);
      if (typeof value !== 'number' || !(value >= limits[0] && value <= limits[1])) throw new SimulationError(`profile.${key} must be a number from ${limits[0]} to ${limits[1]}`);
      out.profile[key] = value;
    }
  }
  if (raw.algorithm != null) {
    if (!ALGORITHMS.includes(raw.algorithm)) throw new SimulationError(`algorithm must be one of ${ALGORITHMS.join(', ')}`);
    out.algorithm = raw.algorithm;
  }
  if (raw.tempTarget === null) out.tempTarget = null;
  else if (raw.tempTarget != null) {
    const { targetMgdl, minutes = 60 } = raw.tempTarget;
    if (typeof targetMgdl !== 'number' || !(targetMgdl >= 72 && targetMgdl <= 300)) throw new SimulationError('tempTarget.targetMgdl must be from 72 to 300 mg/dL');
    if (typeof minutes !== 'number' || !(minutes > 0 && minutes <= 24 * 60)) throw new SimulationError('tempTarget.minutes must be from 1 to 1440');
    out.tempTarget = { targetMgdl, minutes };
  }
  if (raw.sensitivityRatio != null) {
    if (typeof raw.sensitivityRatio !== 'number' || !(raw.sensitivityRatio >= 0.1 && raw.sensitivityRatio <= 5)) throw new SimulationError('sensitivityRatio must be from 0.1 to 5');
    out.sensitivityRatio = raw.sensitivityRatio;
  }
  return out;
}

const scale = (schedule, f) => schedule.map(([s, v]) => [s, v * f]);

const SCHEDULE_KIND = { basal: 'basal', carbratio: 'ic', sens: 'isf', target_low: 'targetLow', target_high: 'targetHigh' };
const complete = (p) => p.basal && p.ic && p.isf && p.targetLow && p.targetHigh;

/**
 * The profiles one can switch to at `at` (ms), newest used first: each
 * profile AAPS switched to in the year before (from its latest switch,
 * taken back to 100%), then those only in AAPS's uploaded profile store.
 * [{ name, dia, units, basal, ic, isf, targetLow, targetHigh }], schedules
 * [[seconds, value]] in the profile's units, at 100%.
 */
export async function loadProfileStore (pool, at) {
  const [switched, stored] = await Promise.all([
    pool.query(`WITH latest AS (
        SELECT DISTINCT ON (t.original_profile_name) t.identifier, t.original_profile_name AS name, t.date,
          coalesce(t.original_percentage, 100)::float8 AS percentage
        FROM treatments t
        WHERE t.event_type = 'Note' AND t.original_profile_name IS NOT NULL AND t.is_valid IS DISTINCT FROM false
          AND t.date <= $1 AND t.date > $1::timestamptz - interval '365 days'
        ORDER BY t.original_profile_name, t.date DESC)
      SELECT l.name, l.date, l.percentage, p.dia::float8 AS dia, p.units, s.kind,
        coalesce(s.seconds, extract(epoch FROM s.time::time)::int) AS seconds, s.value::float8 AS value
      FROM latest l JOIN treatment_profiles p ON p.treatment_identifier = l.identifier
        JOIN treatment_profile_schedules s ON s.treatment_identifier = l.identifier
      ORDER BY l.date DESC, s.kind, s.position`, [new Date(at)]),
    pool.query(`WITH latest AS (
        SELECT DISTINCT ON (s.name) s.profile_identifier, s.name, s.dia, s.units, p.date
        FROM profile p JOIN profile_stores s ON s.profile_identifier = p.identifier
        WHERE p.date <= $1 AND p.is_valid IS DISTINCT FROM false
        ORDER BY s.name, p.date DESC)
      SELECT l.name, l.dia::float8 AS dia, l.units, c.kind,
        coalesce(c.seconds, extract(epoch FROM c.time::time)::int) AS seconds, c.value::float8 AS value
      FROM latest l JOIN profile_store_schedules c ON c.profile_identifier = l.profile_identifier AND c.name = l.name
      ORDER BY l.date DESC, l.name, c.kind, c.position`, [new Date(at)]),
  ]);
  const byName = new Map();
  for (const r of switched.rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, dia: r.dia, units: r.units, percentage: r.percentage });
    const p = byName.get(r.name);
    // a switch's schedules have its percentage applied: back to 100%
    const f = r.kind === 'basal' ? 100 / r.percentage : r.kind === 'carbratio' || r.kind === 'sens' ? r.percentage / 100 : 1;
    (p[SCHEDULE_KIND[r.kind]] ||= []).push([Number(r.seconds), r.value * f]);
  }
  const fromStore = new Map();
  for (const r of stored.rows) {
    if (byName.has(r.name)) continue;
    if (!fromStore.has(r.name)) fromStore.set(r.name, { name: r.name, dia: r.dia, units: r.units });
    (fromStore.get(r.name)[SCHEDULE_KIND[r.kind]] ||= []).push([Number(r.seconds), r.value]);
  }
  return [...byName.values(), ...fromStore.values()].filter(complete).map(({ percentage, ...p }) => p);
}

/** Changes with a profile name resolved to that stored profile (`profile.store`). */
export async function withStoredProfile (pool, changes, at) {
  const name = changes.profile?.name;
  if (!name) return changes;
  const store = (await loadProfileStore(pool, at)).find((p) => p.name === name);
  if (!store) throw new SimulationError(`No stored profile named ${name}`);
  return { ...changes, profile: { ...changes.profile, store } };
}

const isMmol = (units) => /^mmol/i.test(units || '');

/**
 * An effective profile switch with `change` applied: another stored
 * profile replaces the schedules (`store`), the percentage replaces the
 * switch's (basal × p, ISF and carb ratio ÷ p, as AAPS does), the factors
 * multiply on top, and targetMgdl sets the whole day's target.
 */
export function changedProfile (eps, change = {}) {
  const p = { ...eps };
  if (change.store) {
    const s = change.store;
    const pct = change.percentage ?? eps.percentage ?? 100;
    // the stored profile's glucose values in the switch's units
    const g = isMmol(s.units) === isMmol(eps.units) ? 1 : isMmol(s.units) ? MMOLL_TO_MGDL : 1 / MMOLL_TO_MGDL;
    p.name = s.name;
    p.basal = scale(s.basal, pct / 100);
    p.isf = scale(s.isf, g * 100 / pct);
    p.ic = scale(s.ic, 100 / pct);
    p.targetLow = scale(s.targetLow, g);
    p.targetHigh = scale(s.targetHigh, g);
    if (s.dia > 0) p.dia = Math.max(s.dia, MIN_DIA);
    p.percentage = pct;
  } else if (change.percentage != null) {
    const f = change.percentage / (eps.percentage ?? 100);
    p.basal = scale(p.basal, f);
    p.isf = scale(p.isf, 1 / f);
    p.ic = scale(p.ic, 1 / f);
    p.percentage = change.percentage;
  }
  if (change.isfFactor != null) p.isf = scale(p.isf, change.isfFactor);
  if (change.carbRatioFactor != null) p.ic = scale(p.ic, change.carbRatioFactor);
  if (change.basalFactor != null) p.basal = scale(p.basal, change.basalFactor);
  if (change.targetMgdl != null) {
    const toMgdl = isMmol(eps.units) ? MMOLL_TO_MGDL : 1;
    p.targetLow = [[0, change.targetMgdl / toMgdl]];
    p.targetHigh = [[0, change.targetMgdl / toMgdl]];
  }
  return p;
}

/**
 * The history with `changes` from `at` (ms) to `until`: profile changes as
 * a switch at `at` and on every switch after it, a temp target set or
 * cancelled at `at`.
 */
export function historyWithChanges (history, changes, at, until = at) {
  const h = { ...history };
  if (changes.profile) {
    const before = history.profiles.filter((p) => p.date < at);
    const active = before[before.length - 1];
    const later = history.profiles.filter((p) => p.date >= at).map((p) => changedProfile(p, changes.profile));
    h.profiles = [...before, ...(active ? [{ ...changedProfile(active, changes.profile), date: at }] : []), ...later];
  }
  if (changes.tempTarget !== undefined) {
    // targets running at `at` end there; with a cancel, so do the later ones until `until`
    const kept = history.tempTargets
      .filter((t) => changes.tempTarget !== null || t.timestamp < at || t.timestamp > until)
      .map((t) => (t.timestamp < at && t.timestamp + t.duration > at ? { ...t, duration: at - t.timestamp } : t))
      .filter((t) => t.duration > 0);
    if (changes.tempTarget) {
      const { targetMgdl, minutes } = changes.tempTarget;
      kept.push({ timestamp: at, duration: minutes * MIN, low: targetMgdl, high: targetMgdl });
    }
    h.tempTargets = kept.sort((a, b) => a.timestamp - b.timestamp);
  }
  return h;
}

/** A decision for the API: glucose in mg/dL, insulin in U, rates in U/h. */
export function decisionSummary (result, rebuilt, algorithm) {
  const input = rebuilt.input;
  const iob = input.iob_data_array[0].iob;
  const cob = input.meal_data.mealCOB;
  return {
    algorithm,
    bg: input.glucose_status.glucose,
    eventualBG: result.eventualBG ?? null,
    targetBG: result.targetBG ?? null,
    insulinReq: result.insulinReq ?? null,
    smb: result.units > 0 ? result.units : 0,
    rate: result.rate ?? null,
    duration: result.duration ?? null,
    sensitivityRatio: result.sensitivityRatio ?? null,
    variableSens: result.variable_sens ?? null,
    iob,
    cob,
    predBGs: result.predBGs || {},
    reason: result.reason || '',
    limits: runLimits({ reason: result.reason, iob, cob, doubled: rebuilt.details.doubled }),
  };
}

/** The algorithm of a recorded run as ALGORITHMS names it. */
export const runAlgorithm = (run) => (run.algorithm === 'SMB' && run.dynamicIsf ? 'SMB+DynISF' : run.algorithm);

/** inputsAt options for an ALGORITHMS name. */
export const algorithmOptions = (name) => ({ algorithm: name === 'SMB+DynISF' ? 'SMB' : name, dynamicIsf: name === 'SMB+DynISF' });

/**
 * Decides at `time` (ms) as recorded and with `changes` (parseChanges).
 * Returns { time, recorded, baseline, changed, settings, reproduces }.
 */
export async function simulateRun (pool, { time, changes = {} }) {
  const runs = await loadRuns(pool, { from: time - (ISF_CACHE_HOURS + 1) * HOUR, to: time + RUN_WINDOW });
  let run = null;
  for (const r of runs) if (Math.abs(r.timestamp - time) <= RUN_WINDOW && (!run || Math.abs(r.timestamp - time) < Math.abs(run.timestamp - time))) run = r;
  if (!run) throw new SimulationError('No loop run within 5 minutes of that time', 404);
  if (!ALGORITHMS.includes(runAlgorithm(run))) throw new SimulationError(`The run's algorithm ${run.algorithm} can't be simulated`, 422);
  const before = runs.filter((r) => r.timestamp <= run.timestamp);
  const history = await loadHistory(pool, { from: run.timestamp - 24 * HOUR, to: run.timestamp });
  plannedTempDurations(history.temps, before);
  const settings = await loadSettings(pool, { to: run.timestamp, runs: before.filter((r) => r.timestamp > run.timestamp - 24 * HOUR), tempTargets: history.tempTargets });
  const timeZone = history.timeZone;

  const decide = (hist, { algorithm, values, ratio }) => {
    const replayer = new Replayer(hist, { timeZone });
    for (const r of before) if (r !== run) replayer.rememberIsf(r.timestamp, r.bg, r.variableSens, r.algorithm);
    const rebuilt = replayer.inputsAt(run.timestamp, { ...algorithmOptions(algorithm), settings: values, recordedRatio: ratio });
    if (rebuilt.error) throw new SimulationError(`The inputs of that run can't be rebuilt: ${rebuilt.error}`, 422);
    return decisionSummary(determineBasal(rebuilt.input, { autoIsf: rebuilt.autoIsf }), rebuilt, algorithm);
  };

  const algorithm = runAlgorithm(run);
  const baseline = decide(history, { algorithm, values: settings.values, ratio: run.sensitivityRatio });
  const changedAlgorithm = changes.algorithm || algorithm;
  // AAPS's ratio belongs to its algorithm: another one rebuilds its own
  const ratio = changes.sensitivityRatio ?? (changedAlgorithm === algorithm ? run.sensitivityRatio : null);
  const values = { ...settings.values, ...changes.settings };
  const resolved = await withStoredProfile(pool, changes, run.timestamp);
  const changed = decide(historyWithChanges(history, resolved, run.timestamp - 1), { algorithm: changedAlgorithm, values, ratio });
  return {
    time: run.timestamp,
    changes,
    settings: { values: settings.values, sources: settings.sources, changed: changes.settings || {} },
    recorded: {
      algorithm,
      bg: run.bg,
      eventualBG: run.eventualBG,
      insulinReq: run.insulinReq,
      smb: run.units > 0 ? run.units : 0,
      rate: run.rate,
      duration: run.duration,
      sensitivityRatio: run.sensitivityRatio,
      reason: Array.isArray(run.reason) ? run.reason.join('') : run.reason,
    },
    reproduces: sameAction({ rate: baseline.rate, duration: baseline.duration, units: baseline.smb }, run),
    baseline,
    changed,
    tempTarget: tempTargetAt(history.tempTargets, run.timestamp),
  };
}
