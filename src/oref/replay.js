// The replay check: rebuild the inputs of recorded loop runs, decide with
// the ported algorithm and compare with what AAPS decided. A mismatch is
// put down to the first stage that differs: the inputs (glucose, IOB, COB,
// sensitivity), then the algorithm's result.

import { determineBasal } from './determinebasal.js';
import { ISF_CACHE_HOURS, Replayer, loadHistory, loadRuns, plannedTempDurations } from './inputs.js';
import { loadSettingsTimeline } from './settings.js';

const MIN = 60000;
const HOUR = 60 * MIN;

/** Tolerances for "the same": glucose in mg/dL, insulin in U, rates in U/h. */
export const TOLERANCE = { bg: 0.5, iob: 0.015, cob: 0.5, ratio: 0.005, isf: 0.5, eventualBG: 5, rate: 0.05, smb: 0.05 };

const near = (a, b, tol) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol + 1e-9);

/** What a run did: a temp (rate, duration) or none, and an SMB. */
function action (r) {
  return { rate: r.rate != null && r.duration != null && r.rate >= 0 ? r.rate : null, smb: r.units > 0 ? r.units : 0 };
}

/** Whether two results ({ rate, duration, units }) dose the same: the same temp, or none, and the same SMB. */
export function sameAction (r1, r2) {
  const a = action(r1);
  const b = action(r2);
  return near(a.rate, b.rate, TOLERANCE.rate) && near(a.smb, b.smb, TOLERANCE.smb);
}

/** Compares one replayed run with the recorded one. */
export function compareRun (recorded, rebuilt, result) {
  const input = rebuilt.input;
  const checks = {
    bg: near(input.glucose_status.glucose, recorded.bg, TOLERANCE.bg),
    iob: near(input.iob_data_array[0].iob, recorded.iob, TOLERANCE.iob),
    cob: near(input.meal_data.mealCOB, recorded.cob, TOLERANCE.cob),
    sensitivityRatio: near(result.sensitivityRatio, recorded.sensitivityRatio, TOLERANCE.ratio),
    variableSens: recorded.variableSens == null || near(result.variable_sens, recorded.variableSens, TOLERANCE.isf),
  };
  const same = sameAction(result, recorded);
  const eventual = near(result.eventualBG, recorded.eventualBG, TOLERANCE.eventualBG);
  const stage = ['bg', 'iob', 'cob', 'sensitivityRatio', 'variableSens'].find((k) => !checks[k]) || (same && eventual ? null : 'algorithm');
  return { checks, sameAction: same, eventual, stage };
}

/**
 * Replays the runs in [from, to] (ms). Returns { settings, runs: [{ time,
 * algorithm, recorded, replayed, comparison }], summary }. With
 * `recordedRatio` (the default) each run uses the sensitivity ratio AAPS
 * recorded; otherwise it is rebuilt from autosens or Dynamic ISF's TDDs.
 */
export async function replay (pool, { from, to, warmupHours = 24, excludeDevices = [], settings: overrides = {}, recordedRatio = true }) {
  const [history, runs] = await Promise.all([
    loadHistory(pool, { from: from - warmupHours * HOUR, to, excludeDevices }),
    loadRuns(pool, { from: from - ISF_CACHE_HOURS * HOUR, to }),
  ]);
  const timeline = await loadSettingsTimeline(pool, { from, to, runs: runs.filter((r) => r.timestamp >= from), tempTargets: history.tempTargets });
  // the settings at each run: entered ones where they changed, the overrides on top
  const valuesAt = (t) => ({ ...timeline.at(t).values, ...overrides });
  const settings = { values: valuesAt(to), sources: { ...timeline.last.sources } };
  for (const k of Object.keys(overrides)) settings.sources[k] = 'override';
  plannedTempDurations(history.temps, runs);
  const timeZone = history.timeZone;
  const replayer = new Replayer(history, { timeZone });

  const out = [];
  for (const run of runs) {
    if (run.timestamp < from) {
      replayer.rememberIsf(run.timestamp, run.bg, run.variableSens, run.algorithm);
      continue;
    }
    const dynamicIsf = run.algorithm === 'SMB' && run.dynamicIsf;
    const rebuilt = replayer.inputsAt(run.timestamp, {
      algorithm: run.algorithm, dynamicIsf, settings: valuesAt(run.timestamp), recordedRatio: recordedRatio ? run.sensitivityRatio : null,
    });
    replayer.rememberIsf(run.timestamp, run.bg, run.variableSens, run.algorithm);
    if (rebuilt.error) {
      out.push({ time: run.timestamp, algorithm: run.algorithm, error: rebuilt.error });
      continue;
    }
    let result;
    try {
      result = determineBasal(rebuilt.input, { autoIsf: rebuilt.autoIsf });
    } catch (e) {
      out.push({ time: run.timestamp, algorithm: run.algorithm, error: e.message });
      continue;
    }
    out.push({
      time: run.timestamp,
      algorithm: run.algorithm + (dynamicIsf ? '+DynISF' : ''),
      recorded: pick(run),
      replayed: { ...pick(result), bg: rebuilt.input.glucose_status.glucose, iob: rebuilt.input.iob_data_array[0].iob, cob: rebuilt.input.meal_data.mealCOB, doubled: rebuilt.details.doubled, autosens: rebuilt.input.autosens_data },
      comparison: compareRun(run, rebuilt, result),
    });
  }
  return { settings, runs: out, summary: summarize(out) };
}

function pick (r) {
  return {
    bg: r.bg, iob: r.iob, cob: r.cob, eventualBG: r.eventualBG, insulinReq: r.insulinReq, rate: r.rate, duration: r.duration, units: r.units,
    sensitivityRatio: r.sensitivityRatio, variableSens: r.variableSens ?? r.variable_sens, reason: r.reason,
  };
}

/** Match rates per algorithm, and how mismatches split by stage. */
export function summarize (runs) {
  const groups = new Map();
  for (const r of runs) {
    const g = groups.get(r.algorithm) || { runs: 0, errors: 0, sameAction: 0, eventual: 0, checks: {}, stages: {} };
    g.runs++;
    if (r.error) {
      g.errors++;
      g.stages[`error: ${r.error}`] = (g.stages[`error: ${r.error}`] || 0) + 1;
    } else {
      const c = r.comparison;
      if (c.sameAction) g.sameAction++;
      if (c.eventual) g.eventual++;
      for (const [k, ok] of Object.entries(c.checks)) g.checks[k] = (g.checks[k] || 0) + (ok ? 1 : 0);
      if (c.stage) g.stages[c.stage] = (g.stages[c.stage] || 0) + 1;
    }
    groups.set(r.algorithm, g);
  }
  return Object.fromEntries(groups);
}
