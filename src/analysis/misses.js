// Times the loop got it wrong:
// - "low": SMBs in the hours before a low, more than the low leaves room for
//   in the hour before it (for example SMBs for rescue carbs or for the
//   rebound after a low);
// - "high": a high the loop saw coming too late or too mildly: its eventual
//   glucose stayed far below the peak, or a limit held its insulin back.
// Glucose, targets and ISF are in mg/dL as AAPS reports them.

import { VALID_SGV } from '../predict/index.js';
import { uniqueRuns } from './prompt.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const VALID = 'is_valid IS DISTINCT FROM false';
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
// Episodes this close to the one before are the same episode.
const MERGE = 30 * MIN;
// The loop wanted more than it gave: an SMB capped at maxBolus, IOB at maxIOB, SMB off.
const LIMIT = /maxBolus|maxIOB|SMB disabled|disabling SMB/i;

const READINGS = `SELECT date, sgv::float8 AS sgv FROM entries
   WHERE ${VALID_SGV} AND date >= $1 AND date < $2 ORDER BY date`;
const TREATMENTS = `SELECT date, insulin::float8 AS insulin, carbs::float8 AS carbs,
     coalesce(type = 'SMB' OR is_smb, false) AS smb
   FROM treatments
   WHERE date >= $1 AND date < $2 AND ${VALID} AND (insulin > 0 OR carbs > 0)
     AND coalesce(type, '') <> 'PRIMING'
   ORDER BY date`;
const RUNS = `SELECT date,
     coalesce(enacted_bg, suggested_bg)::float8 AS bg,
     coalesce(enacted_eventual_bg, suggested_eventual_bg)::float8 AS eventual_bg,
     coalesce(enacted_target_bg, suggested_target_bg)::float8 AS target_bg,
     coalesce(enacted_insulin_req, suggested_insulin_req)::float8 AS insulin_req,
     coalesce(enacted_iob, suggested_iob, iob_iob)::float8 AS iob,
     coalesce(enacted_cob, suggested_cob)::float8 AS cob,
     coalesce(enacted_variable_sens, suggested_variable_sens)::float8 AS isf,
     coalesce(enacted_reason, suggested_reason) AS reason
   FROM devicestatus
   WHERE date >= $1 AND date < $2 AND ${VALID}
     AND (suggested_bg IS NOT NULL OR enacted_bg IS NOT NULL)
   ORDER BY date`;

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
 * of the insulin too much (low) or too little (high).
 */
export function loopMisses ({ readings, treatments, runs }, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const smbs = treatments.filter((t) => t.smb && t.insulin > 0);
  const boluses = treatments.filter((t) => !t.smb && t.insulin > 0);
  const carbs = treatments.filter((t) => t.carbs > 0);
  runs = uniqueRuns(runs);
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
    const limited = within(runs, e.start - HOUR, e.at).filter((r) => LIMIT.test(r.reason || ''));
    const underestimated = expected != null && e.extreme - expected >= o.underestimate;
    if (!underestimated && !limited.length) continue;
    const from = e.start - HOUR;
    const smb = total(within(smbs, from, e.at), 'insulin');
    const bolus = total(within(boluses, from - HOUR, e.at), 'insulin');
    const isf = run.isf ?? null;
    const flags = [];
    if (underestimated) flags.push('underestimated');
    if (limited.length) flags.push('held back by a limit');
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
      limit: limited[0]?.reason ?? null,
      // The insulin the loop would have asked for had it expected the peak.
      missing: expected != null && isf > 0 ? round(Math.max(0, (e.extreme - expected) / isf)) : null,
      flags,
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

/** loopMisses over [from, to) (ms), with records from before `from` the lookback needs. */
export async function findMisses (pool, { from, to }, options = {}) {
  const start = new Date(from - DEFAULTS.lowLookback - HOUR);
  const end = new Date(to);
  const [readings, treatments, runs] = await Promise.all([
    pool.query(READINGS, [start, end]),
    pool.query(TREATMENTS, [start, end]),
    pool.query(RUNS, [start, end]),
  ]);
  const dated = (rows) => rows.map((r) => ({ ...r, date: ms(r.date) }));
  return loopMisses({ readings: dated(readings.rows), treatments: dated(treatments.rows), runs: dated(runs.rows) }, options)
    .filter((m) => m.start >= from);
}
