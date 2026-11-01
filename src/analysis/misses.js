// Times the loop got it wrong:
// - "low": SMBs in the hours before a low, more than the low leaves room for
//   in the hour before it (for example SMBs for rescue carbs or for the
//   rebound after a low);
// - "high": a high the loop saw coming too late or too mildly: its eventual
//   glucose stayed far below the peak, or a limit held its insulin back.
// Glucose, targets and ISF are in mg/dL as AAPS reports them.

import { uniqueRuns } from './runs.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const ms = (d) => (d == null ? null : new Date(d).getTime());

export const DEFAULTS = {
  low: 70,
  // A low ends once glucose is back above this.
  lowEnd: 80,
  high: 180,
  highEnd: 170,
  // A high counts when it reaches this and lasts at least highMinutes.
  highPeak: 250,
  highMinutes: 30,
  // SMBs this long before a low (minus the last lowGap) count towards it.
  lowLookback: HOUR,
  lowGap: 10 * MIN,
  minSmb: 0.5,
  // A low counts when the SMBs gave at least this much more than it left room for.
  minExcess: 0.5,
  // A high was underestimated when the loop's highest eventual glucose in
  // the hour before it stayed this far below the peak.
  underestimate: 90,
  // A low within this time before marks the episode as a rebound after a low.
  rebound: 3 * HOUR,
};

// Readings run continuously unless they stop for longer than this.
const GAP = 20 * MIN;
// AAPS's glucose quality check (BgQualityCheckPlugin): two readings at most
// 20 s apart among the newest 11 are "doubled values", and max IOB becomes 0.
const DOUBLED = 20000;
const DOUBLED_READINGS = 11;
// Episodes this close to the one before are the same episode.
const MERGE = 30 * MIN;
// What held the loop back, as its reason says (oref0 determine-basal):
// "maxBolus 0.6" an SMB cut to the SMB size limit, "max_iob 10.0" the extra
// insulin cut so IOB stays under max IOB, "maxSafeBasal: 3.4" a temp basal
// cut to the max safe basal, "SMB disabled" no SMBs.
const LIMITS = [
  ['smbSize', /\bmaxBolus:?\s+(\d+(?:\.\d+)?)/],
  ['maxIob', /\bmax_?iob:?\s+(\d+(?:\.\d+)?)/i],
  ['maxBasal', /\bmaxSafeBasal:?\s+(\d+(?:\.\d+)?)/],
  ['smbOff', /SMB disabled|disabling SMB/i],
];

/**
 * Stretches of readings at or beyond a threshold: below `low` until back
 * above `end` (or above `high` until back below `end`), split at gaps in the
 * readings. [{ start, end, extreme, at, readings }]
 */
export function episodes (readings, { below, above, end }) {
  const out = [];
  let cur = null;
  let prev = null;
  for (const r of readings) {
    if (cur && prev && r.date - prev.date > GAP) cur = null;
    const inside = below != null ? r.sgv < below : r.sgv > above;
    const over = below != null ? r.sgv >= end : r.sgv <= end;
    if (!cur && inside) {
      const last = out[out.length - 1];
      if (last && r.date - last.end <= MERGE) cur = last;
      else {
        cur = { start: r.date, end: r.date, extreme: r.sgv, at: r.date, readings: 0 };
        out.push(cur);
      }
    }
    if (cur && over) cur = null;
    if (cur) {
      cur.end = r.date;
      if (inside) cur.readings++;
      if (below != null ? r.sgv < cur.extreme : r.sgv > cur.extreme) {
        cur.extreme = r.sgv;
        cur.at = r.date;
      }
    }
    prev = r;
  }
  return out;
}

const within = (list, a, b) => list.filter((x) => x.date >= a && x.date < b);
const total = (list, key) => list.reduce((s, x) => s + (x[key] || 0), 0);
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * The predictions a run's reason names (minPredBG, minGuardBG, IOBpredBG,
 * COBpredBG, UAMpredBG) in mg/dL. The reason is in the profile's units: it
 * is mmol/L when its "Target" is the run's target_bg (mg/dL) / 18.
 */
export function reasonPredictions (run) {
  const text = run?.reason || '';
  const value = (name) => {
    const m = new RegExp(`\\b${name}:?\\s+(-?\\d+(?:\\.\\d+)?)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const target = value('Target');
  const mmol = target != null && run.target_bg != null
    ? Math.abs(target * 18 - run.target_bg) < Math.abs(target - run.target_bg)
    : run.bg != null && /\bminPredBG\s+-?\d+\.\d/.test(text) && value('minPredBG') < 40 && run.bg > 60;
  const out = {};
  for (const name of ['minPredBG', 'minGuardBG', 'IOBpredBG', 'COBpredBG', 'UAMpredBG']) {
    const v = value(name);
    out[name] = v == null ? null : round(mmol ? v * 18 : v, 0);
  }
  return out;
}

const expectation = (run) => run && {
  at: run.date,
  bg: run.bg,
  eventual: run.eventual_bg,
  target: run.target_bg,
  isf: run.isf,
  iob: run.iob,
  cob: run.cob,
  insulinReq: run.insulin_req,
  ...reasonPredictions(run),
  reason: run.reason,
};

// The glucose a run doses for: oref sizes insulinReq on the lower of
// minPredBG and the eventual glucose.
const dosedFor = (run) => {
  const values = [reasonPredictions(run).minPredBG, run.eventual_bg].filter((v) => v != null);
  return values.length ? Math.min(...values) : null;
};
const missed = (run, actual) => {
  const guard = reasonPredictions(run).minGuardBG;
  return guard == null ? null : round(guard - actual, 0);
};
const median = (values) => {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

/**
 * Whether AAPS saw doubled values at `t`: two of the newest 11 readings up
 * to then at most 20 s apart. `times` are all reading times (ms), sorted.
 */
export function doubledAt (times, t) {
  let hi = times.length;
  for (let lo = 0; lo < hi;) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = hi - 1; i > 0 && i > hi - DOUBLED_READINGS; i--) {
    if (times[i] - times[i - 1] <= DOUBLED) return true;
  }
  return false;
}

/**
 * The limits a run hit: [{ kind, value }]. The SMB size limit is AAPS's
 * "Max minutes of basal to limit SMB to" of the basal, or the one "for UAM"
 * once IOB is more than the carbs on board need (kind 'uamSmbSize'). Max
 * IOB 0 while AAPS saw doubled readings (run.doubled) is kind 'duplicates'.
 */
export function runLimits (run) {
  const text = run?.reason || '';
  const out = [];
  for (const [kind, pattern] of LIMITS) {
    const m = pattern.exec(text);
    if (!m) continue;
    let k = kind;
    if (kind === 'smbSize') {
      const cr = /\bCR:?\s+(\d+(?:\.\d+)?)/.exec(text);
      const mealInsulin = cr && Number(cr[1]) > 0 ? (run.cob || 0) / Number(cr[1]) : 0;
      if (run.iob > 0 && run.iob > mealInsulin) k = 'uamSmbSize';
    }
    if (kind === 'maxIob' && Number(m[1]) === 0 && run.doubled) k = 'duplicates';
    out.push({ kind: k, value: m[1] != null ? Number(m[1]) : null });
  }
  return out;
}

/** The limits of `runs` together: [{ kind, runs, value (the largest) }], most runs first. */
function limitsOf (runs) {
  const by = new Map();
  for (const r of runs) {
    for (const { kind, value } of runLimits(r)) {
      const l = by.get(kind) || { kind, runs: 0, value: null };
      l.runs++;
      if (value != null && (l.value == null || value > l.value)) l.value = value;
      by.set(kind, l);
    }
  }
  return [...by.values()].sort((a, b) => b.runs - a.runs);
}

const LIMIT_FLAGS = { smbSize: 'SMBs capped', uamSmbSize: 'SMBs capped', maxIob: 'max IOB reached', maxBasal: 'max basal reached', smbOff: 'SMBs off', duplicates: 'duplicate readings' };

const nearest = (runs, t, max = 6 * MIN) => {
  let best = null;
  for (const r of runs) if (Math.abs(r.date - t) <= max && (!best || Math.abs(r.date - t) < Math.abs(best.date - t))) best = r;
  return best;
};

/**
 * The loop's misses in { readings, treatments, runs } (dates in ms, glucose
 * in mg/dL), newest first. Each has kind 'low' or 'high', start, end, the
 * extreme glucose and when, the insulin the loop and the person gave, what
 * the loop expected (from its run at the deciding moment) and an estimate
 * of the insulin too much (low) or too little (high). `readingTimes` are
 * all reading times AAPS had (default: the readings'), for its
 * doubled-values check; a high only listed because duplicates held the loop
 * back has `causedByDuplicates`.
 */
export function loopMisses ({ readings, treatments, runs, readingTimes }, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const smbs = treatments.filter((t) => t.smb && t.insulin > 0);
  const boluses = treatments.filter((t) => !t.smb && t.insulin > 0);
  const carbs = treatments.filter((t) => t.carbs > 0);
  const times = readingTimes || readings.map((r) => r.date);
  runs = uniqueRuns(runs).map((r) => (/\bmax_?iob:?\s+0(\.0+)?\b/i.test(r.reason || '') ? { ...r, doubled: doubledAt(times, r.date) } : r));
  const out = [];

  const lows = episodes(readings, { below: o.low, end: o.lowEnd }).filter((e) => e.readings >= 2);
  const lowestNear = (t) => Math.min(...within(readings, t - 30 * MIN, t + 5 * MIN).map((r) => r.sgv));
  for (const [i, e] of lows.entries()) {
    const from = e.start - o.lowLookback;
    const to = e.start - o.lowGap;
    const given = within(smbs, from, to);
    const smb = total(given, 'insulin');
    if (smb < o.minSmb) continue;
    // The run that gave the largest SMB: what the loop expected then.
    const largest = given.reduce((a, b) => (b.insulin > a.insulin ? b : a));
    const run = nearest(runs, largest.date);
    const target = run?.target_bg ?? null;
    const isf = run?.isf ?? null;
    // Insulin that took glucose from the target down to the low, at most what the SMBs gave.
    const excess = target != null && isf > 0 ? Math.min(smb, Math.max(0, (target - e.extreme) / isf)) : smb;
    if (excess < o.minExcess) continue;
    // Carbs eaten up to 30 minutes before the SMBs they led to.
    const eaten = within(carbs, from - 30 * MIN, e.start);
    // Carbs eaten at or near a low without a bolus of their own.
    const rescue = eaten.filter((c) => lowestNear(c.date) <= o.lowEnd &&
      !within(boluses, c.date - 15 * MIN, c.date + 15 * MIN).length);
    const flags = [];
    const previous = lows[i - 1];
    if (previous && e.start - previous.end <= o.rebound) flags.push('after a low');
    const afterRescue = rescue.length ? total(within(given, Math.max(from, rescue[0].date), to), 'insulin') : 0;
    if (afterRescue >= o.minSmb) flags.push('SMBs after rescue carbs');
    if (!eaten.length) flags.push('no carbs logged');
    out.push({
      kind: 'low',
      start: e.start,
      end: e.end,
      glucose: e.extreme,
      at: e.at,
      from,
      smb: round(smb),
      smbs: given.length,
      smbAfterRescue: rescue.length ? round(afterRescue) : null,
      bolus: round(total(within(boluses, from, to), 'insulin')),
      carbs: total(eaten, 'carbs'),
      rescueCarbs: total(rescue, 'carbs'),
      expected: expectation(run),
      // How far the low went below the lowest glucose the loop allowed for.
      missedBy: run ? missed(run, e.extreme) : null,
      excess: round(excess),
      flags,
    });
  }

  const highs = episodes(readings, { above: o.high, end: o.highEnd })
    .filter((e) => e.extreme >= o.highPeak && e.end - e.start >= o.highMinutes * MIN);
  for (const e of highs) {
    const before = within(runs, e.start - HOUR, e.start + 5 * MIN);
    if (!before.length) continue;
    // What the loop dosed for in the hour before, typically.
    const expected = median(before.map(dosedFor));
    const run = before.reduce((a, b) => (Math.abs(dosedFor(b) - expected) < Math.abs(dosedFor(a) - expected) ? b : a));
    const limited = within(runs, e.start - HOUR, e.at).filter((r) => runLimits(r).length);
    const limits = limitsOf(limited);
    const underestimated = expected != null && e.extreme - expected >= o.underestimate;
    if (!underestimated && !limited.length) continue;
    const from = e.start - HOUR;
    const smb = total(within(smbs, from, e.at), 'insulin');
    const bolus = total(within(boluses, from - HOUR, e.at), 'insulin');
    const isf = run.isf ?? null;
    const flags = [];
    // Listed only because doubled readings set max IOB to 0.
    const causedByDuplicates = !underestimated && limits.every((l) => l.kind === 'duplicates');
    if (causedByDuplicates) flags.push('caused by duplicate readings');
    if (underestimated) flags.push('underestimated');
    for (const flag of new Set(limits.map((l) => LIMIT_FLAGS[l.kind]))) if (!causedByDuplicates) flags.push(flag);
    const early = within(carbs, e.start - 3 * HOUR, e.start - 15 * MIN);
    const late = within(carbs, e.start - 15 * MIN, e.at);
    if (late.length) flags.push('carbs logged late');
    else if (!early.length) flags.push('no carbs logged');
    if (bolus > 0) flags.push('own bolus');
    out.push({
      kind: 'high',
      start: e.start,
      end: e.end,
      glucose: e.extreme,
      at: e.at,
      from,
      smb: round(smb),
      smbs: within(smbs, from, e.at).length,
      bolus: round(bolus),
      carbs: total([...early, ...late], 'carbs'),
      expected: expectation(run),
      dosedFor: expected,
      limitedRuns: limited.length,
      limits,
      // The insulin the loop would have asked for had it expected the peak.
      missing: expected != null && isf > 0 ? round(Math.max(0, (e.extreme - expected) / isf)) : null,
      causedByDuplicates,
      flags,
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

/** loopMisses over [from, to) (ms), with records from before `from` the lookback needs. */
export async function findMisses (data, { from, to }, options = {}) {
  const start = from - DEFAULTS.lowLookback - HOUR;
  const [readings, treatments, runs, readingTimes] = await Promise.all([
    data.glucose.between(start, to),
    data.treatments.forMisses(start, to),
    data.loop.forMisses(start, to),
    data.glucose.allTimes(start, to),
  ]);
  const dated = (rows) => rows.map((r) => ({ ...r, date: ms(r.date) }));
  return loopMisses({ readings: readings.map((r) => ({ date: ms(r.date), sgv: r.sgv })), treatments: dated(treatments), runs: dated(runs), readingTimes }, options)
    .filter((m) => m.start >= from);
}
