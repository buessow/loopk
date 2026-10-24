// What the AAPS loop decided at each run, from its device-status records
// (openaps.suggested / openaps.enacted): the algorithm, the values it
// decided on and what it set. AAPS reports glucose, targets, ISF and its
// predicted curves in mg/dL; they are kept here in mmol/L. The reason text
// is in the profile's units and is kept as AAPS wrote it.

import { MGDL_PER_MMOL, docTime } from './model.js';

const MIN = 60000;
// The predicted curves AAPS reports, one value per 5 minutes from the run.
export const CURVES = ['IOB', 'ZT', 'UAM', 'COB'];

function num (v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
const mmol = (v) => (num(v) == null ? null : num(v) / MGDL_PER_MMOL);
// AAPS writes -1 for "no temp basal".
const positive = (v) => (num(v) != null && num(v) >= 0 ? num(v) : null);

/**
 * The values before the ";" of a reason ("COB: 44.8, Dev: 2.1, ...,
 * minPredBG 10.1, minGuardBG 4.5") as [[name, value]], and the decision
 * after it.
 */
export function splitReason (reason) {
  const text = String(reason || '').trim();
  const i = text.indexOf(';');
  const head = i < 0 ? text : text.slice(0, i);
  const values = [];
  for (const part of head.split(',')) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?):?\s+(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (m) values.push([m[1], Number(m[2])]);
  }
  return { values, decision: i < 0 ? (values.length ? '' : text) : text.slice(i + 1).trim() };
}

/**
 * One entry per loop run, ascending: { t, algorithm, dynamicIsf, bg,
 * eventual, target, isf (mmol/L per U), sensitivityRatio, iob, cob,
 * insulinReq, enacted, rate, duration, smb, smbGiven, reason, pred }.
 * Runs uploaded twice (same reason within a minute) are kept once.
 */
export function loopRuns (devicestatus) {
  const runs = [];
  for (const d of devicestatus) {
    const s = d.openaps?.suggested;
    const e = d.openaps?.enacted;
    const r = e?.bg != null || e?.reason ? e : s;
    const t = docTime(d);
    if (!r || t == null || (r.bg == null && !r.reason)) continue;
    const pred = {};
    for (const c of CURVES) {
      const list = r.predBGs?.[c] ?? s?.predBGs?.[c];
      if (Array.isArray(list) && list.length) pred[c] = list.map(mmol);
    }
    runs.push({
      t,
      algorithm: r.algorithm ?? s?.algorithm ?? null,
      dynamicIsf: r.runningDynamicIsf ?? s?.runningDynamicIsf ?? null,
      bg: mmol(r.bg),
      eventual: mmol(r.eventualBG),
      target: mmol(r.targetBG),
      isf: mmol(r.variable_sens),
      sensitivityRatio: num(r.sensitivityRatio),
      iob: num(r.IOB ?? d.openaps?.iob?.iob),
      cob: num(r.COB),
      insulinReq: num(r.insulinReq),
      enacted: r === e,
      rate: positive(r.rate),
      duration: positive(r.duration),
      smb: num(r.units),
      smbGiven: r === e ? num(e.smb) : null,
      reason: r.reason || '',
      pred,
    });
  }
  runs.sort((a, b) => a.t - b.t);
  return runs.filter((r, i) => {
    const next = runs[i + 1];
    return !(next && next.t - r.t < MIN && next.reason === r.reason && (next.enacted || !r.enacted));
  });
}

/** "SMB", "SMB + DynISF", "AUTO_ISF": the algorithm a run reported. */
export function algorithmName (run) {
  if (!run.algorithm) return run.dynamicIsf ? 'DynISF' : 'unknown';
  return run.algorithm === 'SMB' && run.dynamicIsf ? 'SMB + DynISF' : run.algorithm;
}

/**
 * Periods of the same algorithm: [{ from, to, name }]; a period ends where
 * the runs stop for longer than `gap` (ms).
 */
export function algorithmPeriods (runs, gap = 15 * MIN) {
  const out = [];
  for (const r of runs) {
    const name = algorithmName(r);
    const last = out[out.length - 1];
    if (last && last.name === name && r.t - last.to <= gap) last.to = r.t + 5 * MIN;
    else {
      if (last && r.t - last.to <= gap) last.to = r.t;
      out.push({ from: r.t, to: r.t + 5 * MIN, name });
    }
  }
  return out;
}

/** The predicted curve `name` of a run as points { t, v } (mmol/L), 5 minutes apart. */
export function curvePoints (run, name) {
  return (run.pred[name] || []).map((v, i) => ({ t: run.t + i * 5 * MIN, v })).filter((p) => p.v != null);
}
