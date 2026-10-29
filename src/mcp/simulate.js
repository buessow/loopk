// The simulator's MCP tools (simulate_run, simulate_period,
// get_loop_settings, get_test_profile, set_test_profile): src/oref's what-if
// results in the agent's unit and time zone, with links to loopk's simulate
// and profiles pages.

import { loadHistory } from '../oref/inputs.js';
import { simulatePeriod } from '../oref/period.js';
import { SimulationError, loadProfileStore, parseChanges, simulateRun } from '../oref/simulate.js';
import { TEST_PROFILE, isMmol, loadTestProfile, saveTestProfile } from '../oref/testprofile.js';
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

// --- the "AI Test" profile (src/oref/testprofile.js) -------------------------

const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;

/** "HH:MM" as seconds from midnight. */
function seconds (text, what) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new SimulationError(`${what}: times are "HH:MM", e.g. "06:30"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/** A profile in loadProfileStore's shape as the tools show it: glucose in `units`. */
export function profileView (p, units) {
  const mmol = isMmol(p.units);
  const g = (v) => glucose(mmol ? v * MGDL_PER_MMOL : v, units);
  const schedule = (list, f = (v) => v) => list.map(([s, v]) => [hm(s), f(v)]);
  return {
    diaHours: p.dia,
    units,
    basalUnitsPerHour: schedule(p.basal),
    isfPerUnit: schedule(p.isf, g),
    carbRatioGramsPerUnit: schedule(p.ic),
    targetLow: schedule(p.targetLow, g),
    targetHigh: schedule(p.targetHigh, g),
  };
}

const profilesLink = (publicUrl) => (publicUrl ? `${publicUrl}/profiles` : null);

/** get_test_profile: the test profile, or that there is none yet. */
export async function testProfile (pool, { units, timeZone, publicUrl }) {
  const p = await loadTestProfile(pool);
  if (!p) return { name: TEST_PROFILE, exists: false, note: `There is no ${TEST_PROFILE} profile yet: set_test_profile creates it from a stored profile.` };
  return {
    name: TEST_PROFILE,
    exists: true,
    basedOn: p.basedOn,
    note: p.note,
    updated: localTime(p.updatedAt, timeZone),
    updatedBy: p.updatedBy,
    ...profileView(p, units),
    link: profilesLink(publicUrl),
  };
}

/**
 * set_test_profile: the test profile from `based_on` (a stored profile; by
 * default the test profile as it is, else the profile switched to last),
 * with the schedules and DIA given replaced. Glucose values in `units`.
 */
export async function setTestProfile (pool, args, { units, timeZone, publicUrl, by }) {
  const current = await loadTestProfile(pool);
  let base = current;
  if (args.based_on || !current) {
    const stored = await loadProfileStore(pool, Date.now());
    base = args.based_on ? stored.find((p) => p.name === args.based_on) : stored[0];
    if (!base) throw new SimulationError(args.based_on ? `No stored profile named ${args.based_on}` : 'No stored profile to start from');
  }
  const mmol = isMmol(base.units);
  // glucose from the agent's unit into the profile's
  const toProfile = (v) => {
    const mgdl = units === 'mmol/L' ? v * MGDL_PER_MMOL : v;
    return mmol ? Math.round(mgdl / MGDL_PER_MMOL * 100) / 100 : Math.round(mgdl * 10) / 10;
  };
  const schedule = (list, what, f = (v) => v) => {
    if (!Array.isArray(list)) throw new SimulationError(`${what} must be a list of ["HH:MM", value]`);
    return list.map((e) => {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[1] !== 'number') throw new SimulationError(`${what} must be a list of ["HH:MM", value]`);
      return [seconds(e[0], what), f(e[1])];
    }).sort((a, b) => a[0] - b[0]);
  };
  const profile = {
    dia: args.dia_hours ?? base.dia,
    units: base.units,
    timezone: base.timezone ?? null,
    basal: args.basal ? schedule(args.basal, 'basal') : base.basal,
    isf: args.isf ? schedule(args.isf, 'isf', toProfile) : base.isf,
    ic: args.carb_ratio ? schedule(args.carb_ratio, 'carb_ratio') : base.ic,
    targetLow: args.target_low ? schedule(args.target_low, 'target_low', toProfile) : base.targetLow,
    targetHigh: args.target_high ? schedule(args.target_high, 'target_high', toProfile) : base.targetHigh,
  };
  const basedOn = args.based_on ?? current?.basedOn ?? base.name ?? null;
  await saveTestProfile(pool, { profile, basedOn, note: args.note ?? current?.note ?? null }, by);
  return testProfile(pool, { units, timeZone, publicUrl });
}
