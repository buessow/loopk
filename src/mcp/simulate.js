// The simulator's MCP tools (simulate_run, simulate_period,
// get_loop_settings): src/oref's what-if results in the agent's unit and
// time zone, with links to loopk's simulate page.

import { loadHistory } from '../oref/inputs.js';
import { simulatePeriod } from '../oref/period.js';
import { SimulationError, parseChanges, simulateRun } from '../oref/simulate.js';
import { DEFAULTS, loadSettings } from '../oref/settings.js';
import { glucose, localTime } from './data.js';

const HOUR = 3600000;
const MGDL_PER_MMOL = 18;
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** A link to the simulate page (public/simulate-model.js viewQuery), or null without a public URL. */
export function simulateLink (publicUrl, view) {
  if (!publicUrl) return null;
  return view.run != null
    ? `${publicUrl}/simulate?run=${Math.round(view.run)}`
    : `${publicUrl}/simulate?from=${Math.round(view.from)}&to=${Math.round(view.to)}`;
}

/**
 * The tools' changes ({ settings, profile: { ..., target }, algorithm,
 * tempTarget: { target, minutes } | null, sensitivityRatio }, glucose in
 * `units`) as parseChanges takes them (mg/dL).
 */
export function toolChanges (raw = {}, units = 'mmol/L') {
  const mgdl = (v) => (typeof v === 'number' && units === 'mmol/L' ? Math.round(v * MGDL_PER_MMOL) : v);
  const out = { ...raw };
  if (raw.profile) {
    const { target, ...rest } = raw.profile;
    out.profile = { ...rest, ...(target != null ? { targetMgdl: mgdl(target) } : {}) };
  }
  if (raw.tempTarget) out.tempTarget = { targetMgdl: mgdl(raw.tempTarget.target), minutes: raw.tempTarget.minutes ?? 60 };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return parseChanges(out);
}

function decision (d, units) {
  const g = (v) => glucose(v, units);
  return {
    algorithm: d.algorithm,
    bg: g(d.bg),
    eventualBG: g(d.eventualBG),
    targetBG: d.targetBG === undefined ? undefined : g(d.targetBG),
    insulinReq: round(d.insulinReq),
    smb: round(d.smb),
    tempBasal: d.rate == null ? null : { rate: round(d.rate), minutes: d.duration },
    sensitivityRatio: round(d.sensitivityRatio),
    isf: d.variableSens == null ? undefined : g(d.variableSens),
    iob: d.iob === undefined ? undefined : round(d.iob),
    cob: d.cob === undefined ? undefined : round(d.cob, 0),
    // where each predicted curve ends
    predictionEnds: d.predBGs ? Object.fromEntries(Object.entries(d.predBGs).map(([k, v]) => [k, g(v.at(-1))])) : undefined,
    limits: d.limits,
    reason: d.reason,
  };
}

/** simulate_run: one recorded decision again with changes. */
export async function run (pool, { time, changes, units, timeZone, publicUrl }) {
  const r = await simulateRun(pool, { time, changes: toolChanges(changes, units) });
  return {
    units,
    time: localTime(r.time, timeZone),
    link: simulateLink(publicUrl, { run: r.time }),
    reproduces: r.reproduces,
    changes: changes || {},
    settingsChanged: r.settings.changed,
    recorded: decision(r.recorded, units),
    unchanged: decision(r.baseline, units),
    changed: decision(r.changed, units),
  };
}

function stats (s, units) {
  return {
    meanGlucose: glucose(s.mean, units),
    timeInRanges: Object.fromEntries(Object.entries(s.ranges).map(([k, v]) => [k, round(v, 1)])),
    lowsBelow70: s.lows70,
    lowsBelow54: s.lows54,
    minutesBelow70: s.minutesBelow70,
    highsAbove250: s.highs250,
    insulin: s.insulin && Object.fromEntries(Object.entries(s.insulin).map(([k, v]) => [k, round(v)])),
  };
}

/** simulate_period: a period dosed with changes, glucose estimated. */
export async function period (pool, { from, to, changes, k, units, timeZone, publicUrl }) {
  const r = await simulatePeriod(pool, { from, to, changes: toolChanges(changes, units), k });
  if (r.error) throw new SimulationError(r.error, 422);
  const miss = (m) => ({ kind: m.kind, start: localTime(m.start, timeZone), end: localTime(m.end, timeZone), glucose: glucose(m.glucose, units) });
  return {
    units,
    from: localTime(r.from, timeZone),
    to: localTime(r.to, timeZone),
    link: simulateLink(publicUrl, { from: r.from, to: r.to }),
    bodyIsfShare: r.k,
    band: r.ks.filter((x) => x !== r.k),
    restartsEveryHours: r.windowHours,
    changes: changes || {},
    settingsChanged: r.settings.changed,
    actual: stats(r.actual, units),
    simulated: stats(r.simulated, units),
    bandLow: stats(r.simulated.low, units),
    bandHigh: stats(r.simulated.high, units),
    misses: { actual: r.misses.actual, simulated: r.misses.simulated, gone: r.misses.gone.map(miss), new: r.misses.new.map(miss) },
    runsNotDecided: r.errors,
  };
}

/**
 * get_loop_settings: the AAPS settings at a time, where each came from, and
 * AAPS's defaults; as the algorithm takes them (glucose in mg/dL).
 */
export async function settings (pool, { at, timeZone }) {
  const history = await loadHistory(pool, { from: at - HOUR, to: at });
  const s = await loadSettings(pool, { to: at, tempTargets: history.tempTargets });
  return { at: localTime(at, timeZone), values: s.values, sources: s.sources, defaults: DEFAULTS };
}
