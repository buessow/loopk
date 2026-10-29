// The glucose chart of the glucose page as SVG: basal, carbs on board,
// boluses and carbs, glucose and heart rate in lanes, with the loop's runs
// as an overlay. The simulate page draws the same chart with a simulated
// overlay (`sim`). Everything it draws comes from an options object:
//
//   data         the model (model.js buildModel) with `loop` (loopruns.js)
//   W            width in px
//   t0, t1       the time shown (ms)
//   units        'mmol/L' or 'mg/dL'
//   style        glucose as 'boxes', 'sticks', 'dots' or 'line'
//   showProfile, showForecast, showLoop   the overlays
//   withDay      the hover names the day
//   runLink      the hover offers a click to simulate a loop run
//   annotations  Claude's marks, for the hover
//   sim          { g: [{ t, v }], band: [{ t, lo, hi }], basal: [{ t0, t1, rate }],
//                  smbs: [{ t, v }], runs (as loopruns.js), windows: [t] }
//                glucose in mmol/L, as in `data`
//   pinned       { run, changed }: a loop run whose predicted curves stay
//                shown, and the changed curves ({ IOB: [mmol/L] … }) drawn over them

import { MIN, HOUR, MGDL_PER_MMOL } from './model.js';
import { CURVES, algorithmName, algorithmPeriods, curvePoints, splitReason } from './loopruns.js';

// Target range 3.9–10 mmol/L (70–180 mg/dL), as in the design.
export const LO = 3.9;
export const HI = 10;
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pad = (n) => String(n).padStart(2, '0');
export const hm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const dayHm = (t, month = false) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${d.getDate()}${month ? ' ' + MONTHS[d.getMonth()] : ''} · ${hm(t)}`; };
export const f1 = (n) => n.toFixed(1);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const mgdl = (o) => o.units === 'mg/dL';
const fmtFor = (o) => (v) => (mgdl(o) ? String(Math.round(v * MGDL_PER_MMOL)) : v.toFixed(1));
const tickFor = (o) => (v) => (mgdl(o) ? String(Math.round(v * MGDL_PER_MMOL)) : String(v));
const hoursOf = (o) => (o.t1 - o.t0) / HOUR;

/** Geometry shared by the chart and its hover layer (lanes as in the design). */
export function geometry (o) {
  const D = o.data;
  const W = Math.max(300, o.W);
  const padL = 12;
  // Phones: no rotated unit labels, and the axis values sit on the left,
  // over the plot, so the plot gets the whole width.
  const narrow = W < 640;
  const padR = narrow ? 8 : 64;
  const iw = W - padL - padR;
  const plotR = padL + iw;
  const { t0, t1 } = o;
  const Ln = { bT: 22, bH: 56, cT: 92, cH: 50, eT: 154, eH: 48, gT: 214, gH: 330, hT: 574, hH: 110 };
  const axis = Ln.hT + Ln.hH + 8;
  const GMIN = 2;
  const GMAX = 20;
  const HMIN = 40;
  const HMAX = 170;
  const CMAX = Math.max(20, ...D.cobSeries.map((p) => p.v * 1.1));
  // insulin on board shares the lane on its own scale (U), down to below 0
  const iob = [...(D.iobSeries || []), ...(o.sim?.runs || []).filter((r) => r.iob != null).map((r) => ({ t: r.t, v: r.iob }))].filter((p) => p.t >= t0 && p.t <= t1);
  const IMAX = Math.max(2, ...iob.map((p) => p.v * 1.1));
  const IMIN = Math.min(0, ...iob.map((p) => p.v * 1.1));
  const visible = D.basal.filter((s) => s.t1 > t0 && s.t0 < t1);
  const simVisible = (o.sim?.basal || []).filter((s) => s.t1 > t0 && s.t0 < t1);
  const BMAX = Math.max(2.4, ...visible.map((s) => Math.max(s.rate, o.showProfile ? s.prof : 0) * 1.1), ...simVisible.map((s) => s.rate * 1.1));
  // Long ranges draw every k-th 5-minute reading (about 400 at most).
  const k = Math.max(1, Math.ceil(hoursOf(o) * 12 / 400));
  return {
    W, H: axis + 26, narrow, padL, padR, iw, plotR, t0, t1, Ln, axis, BMAX, CMAX, IMIN, IMAX, k,
    X: (t) => padL + (t - t0) / (t1 - t0) * iw,
    GY: (v) => Ln.gT + (1 - (Math.min(GMAX, Math.max(GMIN, v)) - GMIN) / (GMAX - GMIN)) * Ln.gH,
    BY: (v) => Ln.bT + Ln.bH - Math.min(v, BMAX) / BMAX * Ln.bH,
    CY: (v) => Ln.cT + Ln.cH - Math.min(v, CMAX) / CMAX * Ln.cH,
    IY: (v) => Ln.cT + Ln.cH - (Math.min(IMAX, Math.max(IMIN, v)) - IMIN) / (IMAX - IMIN) * Ln.cH,
    HY: (v) => Ln.hT + (1 - (Math.min(HMAX, Math.max(HMIN, v)) - HMIN) / (HMAX - HMIN)) * Ln.hH,
  };
}

/** Readings in the window, thinned to one per 5·k minutes. */
export function sampled (points, t0, t1, k) {
  const out = [];
  let slot = null;
  for (const p of points) {
    if (p.t < t0 || p.t > t1) continue;
    const s = Math.floor(p.t / (5 * MIN * k));
    if (s !== slot) out.push(p);
    slot = s;
  }
  return out;
}

/** SVG path through points, broken where readings are missing for more than `gap`. */
export function linePath (points, X, Y, gap) {
  let d = '';
  let prev = null;
  for (const p of points) {
    d += (prev && p.t - prev.t <= gap ? ' L' : ' M') + f1(X(p.t)) + ' ' + f1(Y(p.v));
    prev = p;
  }
  return d.trim();
}

/** The point nearest `t`, if within `maxGap`. */
export function nearest (points, t, maxGap) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best && Math.abs(best.t - t) <= maxGap ? best : null;
}

// Recorded predictions in the glucose lane: what was predicted for each
// moment 15 and 30 minutes before it.
const FORECAST_LINES = [
  [15, 'stroke:var(--color-accent-2-600);stroke-width:1.5;stroke-dasharray:6 3'],
  [30, 'stroke:var(--color-accent-2-500);stroke-width:1.75;stroke-dasharray:2 3'],
];

const rangeOf = (v) => (v < LO ? 'lo' : v > HI ? 'hi' : 'ok');

/** Glucose in the chosen style: boxes, sticks (fading bars), dots or a line. */
function glucoseMarks (o, { W, iw, X, GY, Ln, t0, t1, k }) {
  const gw = sampled(o.data.g, t0, t1, k);
  const gBot = Ln.gT + Ln.gH;
  const out = [];
  if (o.style === 'line') {
    out.push(`<path d="${linePath(gw, X, GY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:var(--bg-ok);stroke-width:2;stroke-linejoin:round"></path>`);
  } else if (o.style === 'dots') {
    const h = hoursOf(o);
    const r = h <= 3 ? 3 : h <= 6 ? 2.6 : h <= 12 ? 2.2 : 1.8;
    const color = { lo: 'var(--bg-low)', ok: 'var(--bg-ok)', hi: 'var(--bg-high)' };
    for (const p of gw) out.push(`<circle cx="${f1(X(p.t))}" cy="${f1(GY(p.v))}" r="${r}" style="fill:${color[rangeOf(p.v)]}"></circle>`);
  } else {
    // Bars from the bottom of the lane: stacked boxes, or sticks fading downwards.
    const boxes = o.style !== 'sticks';
    const bw = Math.max(1, Math.min(8, iw / Math.max(1, Math.round((t1 - t0) / (5 * MIN * k))) * 0.62));
    const boxStep = Math.max(4, Math.round(bw) + 1);
    const pattern = (id, color) => `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="${gBot % boxStep}" width="${W}" height="${boxStep}"><rect x="0" y="1" width="${W}" height="${boxStep - 1}" style="fill:${color}"></rect></pattern>`;
    const gradient = (id, color) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:1"></stop><stop offset="1" style="stop-color:${color};stop-opacity:0"></stop></linearGradient>`;
    out.push(boxes
      ? `<defs>${pattern('g-hi', 'var(--box-high)')}${pattern('g-ok', 'var(--box-ok)')}${pattern('g-lo', 'var(--box-low)')}</defs>`
      : `<defs>${gradient('g-hi', 'var(--bg-high)')}${gradient('g-ok', 'var(--bg-ok)')}${gradient('g-lo', 'var(--bg-low)')}</defs>`);
    for (const p of gw) {
      const y = boxes ? gBot - Math.ceil((gBot - GY(p.v)) / boxStep) * boxStep + 1 : GY(p.v);
      out.push(`<rect x="${f1(X(p.t) - bw / 2)}" y="${f1(y - 1)}" width="${f1(bw)}" height="${f1(gBot - y + 1)}" style="fill:url(#g-${rangeOf(p.v)})"></rect>`);
    }
  }
  return out.join('');
}

// --- loop overlay: what AAPS's algorithm did at each run -------------------

const LOOP_COLOR = { SMB: 'var(--color-neutral-600)', 'SMB + DynISF': 'var(--color-accent-600)', AUTO_ISF: 'var(--color-accent-2-600)' };
const loopColor = (name) => LOOP_COLOR[name] || 'var(--color-neutral-600)';
const LOOP_STRIP = 12;
// carbs and insulin on board, and the labels of their scales
const COB_COLOR = 'var(--chart-carbs)';
const IOB_COLOR = 'var(--chart-insulin)';
const CURVE_COLOR = { IOB: 'var(--color-accent-600)', ZT: 'var(--color-neutral-500)', UAM: 'var(--color-accent-2-600)', COB: 'var(--color-accent-900)' };
// The simulation's color (reports.css).
const SIM = 'var(--chart-simulated)';

/** The target each run used, as dotted steps. */
function targetSteps (runs, { X, GY, padL, plotR }, style) {
  let target = '';
  let prev = null;
  for (const r of runs) {
    if (r.target == null) continue;
    const x = f1(Math.max(padL, X(r.t)));
    const y = f1(GY(r.target));
    target += prev && r.t - prev.t <= 15 * MIN ? ` H${x} V${y}` : ` M${x} ${y}`;
    prev = r;
  }
  if (prev) target += ` H${f1(Math.min(plotR, X(prev.t + 5 * MIN)))}`;
  return `<path d="${target.trim()}" style="fill:none;${style};stroke-dasharray:1 3;stroke-linecap:round"></path>`;
}

/** The eventual glucose of each run: open dots; above the lane, a small triangle under the strip. */
function eventualDots (runs, { X, GY, Ln, t0, t1, k }, color) {
  return sampled(runs.filter((r) => r.eventual != null).map((r) => ({ t: r.t, v: r.eventual })), t0, t1, k).map((p) => {
    const x = f1(X(p.t));
    const y = GY(p.v);
    return y < Ln.gT + LOOP_STRIP + 6
      ? `<path d="M${x} ${Ln.gT + LOOP_STRIP + 3} l-3 5 h6 Z" style="fill:${color}"></path>`
      : `<circle cx="${x}" cy="${f1(y)}" r="2.4" style="fill:var(--color-bg);stroke:${color};stroke-width:1.25"></circle>`;
  }).join('');
}

/**
 * The algorithm of the runs as a strip along the top of the glucose lane,
 * the target each run used (dotted steps) and the eventual glucose it
 * expected (open dots; above the lane, a small triangle under the strip).
 */
function loopOverlay (o, geo) {
  const { X, Ln, t0, t1, padL, plotR } = geo;
  const runs = o.data.loop.filter((r) => r.t >= t0 - HOUR && r.t <= t1);
  const out = [];
  for (const p of algorithmPeriods(runs)) {
    const x0 = Math.max(padL, X(p.from));
    const x1 = Math.min(plotR, X(p.to));
    if (x1 <= x0) continue;
    out.push(`<rect x="${f1(x0)}" y="${Ln.gT}" width="${f1(x1 - x0)}" height="${LOOP_STRIP}" style="fill:${loopColor(p.name)}"><title>${esc(p.name)}</title></rect>`);
    if (x1 - x0 > 80) out.push(`<text x="${f1(x0 + 4)}" y="${Ln.gT + 9.5}" style="fill:var(--color-bg);font-family:var(--font-body);font-size:9px;font-weight:600;letter-spacing:0.06em;pointer-events:none">${esc(p.name)}</text>`);
  }
  out.push(targetSteps(runs, geo, 'stroke:var(--color-accent-900);stroke-width:1.25'));
  out.push(eventualDots(runs, geo, 'var(--color-accent-2-700)'));
  return out.join('');
}

/** The curves a run predicted, from the run onwards, each labelled at its end; `changed` drawn solid in the simulation's color. */
function loopCurves (run, { X, GY, t1 }, changed = false) {
  return CURVES.map((c) => {
    const pts = curvePoints(run, c).filter((p) => p.t <= t1);
    if (pts.length < 2) return '';
    const end = pts[pts.length - 1];
    const color = changed ? SIM : CURVE_COLOR[c];
    return `<path d="${linePath(pts, X, GY, 10 * MIN)}" style="fill:none;stroke:${changed ? SIM : CURVE_COLOR[c]};stroke-width:${changed ? 2 : 1.5}${changed ? '' : ';stroke-dasharray:5 3'}"></path>`
      + `<text x="${f1(X(end.t) + 4)}" y="${f1(GY(end.v) + 4)}" style="fill:${color};font-family:var(--font-body);font-size:10px;font-weight:600;paint-order:stroke;stroke:var(--color-bg);stroke-width:3px">${c}</text>`;
  }).join('');
}

/** The hover rows of a loop run: algorithm, the values it decided on, the result. */
function loopRows (o, r) {
  const fmt = fmtFor(o);
  const row = (name, value) => `<span style="color:var(--color-neutral-700)">${name}</span><span>${value}</span>`;
  const g = (v) => (v == null ? '–' : fmt(v));
  const { values, decision } = splitReason(r.reason);
  const preds = values.filter(([n]) => /^(Dev|BGI|minPredBG|minGuardBG|IOBpredBG|COBpredBG|UAMpredBG)$/.test(n));
  return `<div style="grid-column:span 2;border-top:1px solid var(--color-divider);margin-top:2px;padding-top:4px;font-weight:600">Loop at ${hm(r.t)} · ${esc(algorithmName(r))}</div>`
    + row('Glucose → eventual', `${g(r.bg)} → ${g(r.eventual)}`)
    + row('Target', g(r.target))
    + row('ISF used', r.isf == null ? '–' : `${g(r.isf)} per U`)
    + row('Sensitivity ratio', r.sensitivityRatio == null ? '–' : r.sensitivityRatio.toFixed(2))
    + row('IOB · COB', `${r.iob == null ? '–' : r.iob.toFixed(2) + ' U'} · ${r.cob == null ? '–' : Math.round(r.cob) + ' g'}`)
    // AAPS's insulinReq: what its prediction (which counts IOB) says is still missing.
    + row('Extra insulin needed<br><span style="font-size:11px">on top of IOB</span>', r.insulinReq == null ? '–' : r.insulinReq.toFixed(2) + ' U')
    + (preds.length ? `<span style="grid-column:span 2;color:var(--color-neutral-700);font-size:11px">From its reason: ${esc(preds.map(([n, v]) => `${n} ${v}`).join(' · '))}</span>` : '')
    + `<span style="grid-column:span 2">${r.enacted ? 'Set' : 'Suggested'}: <b>${esc(runResult(r))}</b></span>`
    + (decision ? `<span style="grid-column:span 2;color:var(--color-neutral-700);font-size:11px">${esc(decision)}</span>` : '')
    + (o.runLink ? '<span style="grid-column:span 2;color:var(--color-accent-700);font-size:11px">Click: what if, with other settings</span>' : '');
}

/** What a run did, in a few words. */
function runResult (r) {
  return [
    r.rate != null ? `temp ${r.rate.toFixed(2)} U/h${r.duration ? ` for ${Math.round(r.duration)} min` : ''}` : null,
    r.smb > 0 ? `SMB ${r.smb} U${r.smbGiven != null && r.smbGiven !== r.smb ? ` (given ${r.smbGiven} U)` : ''}` : null,
  ].filter(Boolean).join(', ') || 'no change';
}

// --- the simulated overlay -------------------------------------------------

/** The simulation: its band and glucose, basal, SMBs and loop, and where it starts again from reality. */
function simOverlay (o, geo) {
  const { X, GY, BY, Ln, axis, t0, t1, k, padL, plotR } = geo;
  const s = o.sim;
  const out = [];
  const gap = Math.max(20, 10 * k) * MIN;
  for (const t of s.windows || []) {
    if (t <= t0 || t >= t1) continue;
    out.push(`<line x1="${f1(X(t))}" x2="${f1(X(t))}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-neutral-500);stroke-dasharray:2 3"></line>`);
  }
  // the band: between the low and the high estimate, broken at gaps
  const band = sampled(s.band || [], t0, t1, k).filter((p) => p.lo != null && p.hi != null);
  let part = [];
  const parts = [];
  for (const p of band) {
    if (part.length && p.t - part[part.length - 1].t > gap) { parts.push(part); part = []; }
    part.push(p);
  }
  if (part.length) parts.push(part);
  for (const ps of parts) {
    const d = ps.map((p, i) => `${i ? 'L' : 'M'}${f1(X(p.t))} ${f1(GY(p.hi))}`).join(' ')
      + ' ' + ps.slice().reverse().map((p) => `L${f1(X(p.t))} ${f1(GY(p.lo))}`).join(' ') + ' Z';
    out.push(`<path d="${d}" style="fill:color-mix(in srgb,${SIM} 16%,transparent)"></path>`);
  }
  out.push(`<path d="${linePath(sampled(s.g || [], t0, t1, k), X, GY, gap)}" style="fill:none;stroke:${SIM};stroke-width:2;stroke-linejoin:round"></path>`);
  // basal: a step line over the delivered fill
  const segs = (s.basal || []).filter((b) => b.t1 > t0 && b.t0 < t1);
  let line = '';
  segs.forEach((b, i) => {
    const x0 = f1(X(Math.max(t0, b.t0)));
    const x1 = f1(X(Math.min(t1, b.t1)));
    const y = f1(BY(b.rate));
    line += (i && segs[i - 1].t1 === b.t0 ? ' L' : ' M') + `${x0} ${y} L${x1} ${y}`;
  });
  if (line) out.push(`<path d="${line.trim()}" style="fill:none;stroke:${SIM};stroke-width:1.75"></path>`);
  // SMBs: small triangles under the recorded ones
  const many = hoursOf(o) > 48;
  for (const b of (s.smbs || []).filter((x) => x.t >= t0 && x.t <= t1)) {
    if (many) continue;
    const x = X(b.t);
    const y = Ln.eT + 24;
    out.push(`<path d="M${f1(x - 3)} ${y - 3} L${f1(x + 3)} ${y - 3} L${f1(x)} ${y + 2.4} Z" style="fill:${SIM}"></path>`);
  }
  const runs = (s.runs || []).filter((r) => r.t >= t0 - HOUR && r.t <= t1);
  const iob = sampled(runs.filter((r) => r.iob != null).map((r) => ({ t: r.t, v: r.iob })), t0, t1, k);
  out.push(`<path d="${linePath(iob, X, geo.IY, gap)}" style="fill:none;stroke:${SIM};stroke-width:1.25;stroke-dasharray:4 2;stroke-linejoin:round"></path>`);
  if (o.showLoop) {
    out.push(targetSteps(runs, { X, GY, padL, plotR }, `stroke:${SIM};stroke-width:1.25`));
    out.push(eventualDots(runs, geo, SIM));
  }
  return out.join('');
}

/** The chart as an SVG string, with empty groups for marks, a selection and the hover. */
export function chartSvg (o) {
  const D = o.data;
  const geo = geometry(o);
  const { W, H, narrow, padL, plotR, iw, t0, t1, Ln, axis, X, GY, BY, CY, IY, HY, BMAX, CMAX, IMIN, IMAX, k } = geo;
  const fmt = fmtFor(o);
  const fmtTick = tickFor(o);
  const h = hoursOf(o);
  const longRange = h > 48;
  const out = [];
  const push = (s) => out.push(s);
  const text = (x, y, s, style = '') => push(`<text x="${x}" y="${y}" style="fill:var(--color-neutral-700);font-family:var(--font-body);font-size:11px;${style}">${esc(s)}</text>`);
  const gBot = Ln.gT + Ln.gH;

  // Target band and grid.
  push(`<rect x="${padL}" y="${f1(GY(HI))}" width="${iw}" height="${f1(GY(LO) - GY(HI))}" style="fill:var(--bg-band)"></rect>`);
  const gTicks = [LO, 6, 8, HI, 14, 18];
  const bTicks = [0, 1, 2, 3, 4, 5].filter((v) => v <= BMAX);
  const cobStep = CMAX <= 20 ? 5 : CMAX <= 40 ? 10 : 20;
  const cobTicks = Array.from({ length: Math.floor(CMAX / cobStep) + 1 }, (_, i) => i * cobStep);
  const iobStep = IMAX - IMIN <= 4 ? 1 : IMAX - IMIN <= 10 ? 2 : 5;
  const iobTicks = [];
  for (let v = Math.ceil(IMIN / iobStep) * iobStep; v <= IMAX; v += iobStep) iobTicks.push(v);
  for (const v of [6, 8, 14, 18]) {
    push(`<line x1="${padL}" x2="${plotR}" y1="${f1(GY(v))}" y2="${f1(GY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  }
  for (const v of bTicks.filter((v) => v > 0)) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(BY(v))}" y2="${f1(BY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  for (const v of cobTicks.filter((v) => v > 0)) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(CY(v))}" y2="${f1(CY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  for (const v of [60, 100, 140]) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(HY(v))}" y2="${f1(HY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  const base = Ln.bT + Ln.bH;
  for (const y of [base, Ln.cT + Ln.cH, gBot, Ln.hT + Ln.hH, axis]) push(`<line x1="${padL}" x2="${plotR}" y1="${y}" y2="${y}" style="stroke:var(--color-divider)"></line>`);

  // Time ticks: hours up to two days, then midnights.
  // Narrow screens (phones) get half as many ticks.
  const step0 = h <= 6 ? 1 : h <= 12 ? 2 : h <= 24 ? 3 : h <= 48 ? 6 : h <= 168 ? 24 : 72;
  const step = narrow ? (step0 === 72 ? 168 : step0 === 3 ? 6 : step0 === 6 ? 12 : step0 * 2) : step0;
  const ticks = [];
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  if (step >= 24) d.setHours(24, 0, 0, 0);
  else while (d.getHours() % step) d.setHours(d.getHours() + 1);
  for (; d.getTime() <= t1; step >= 24 ? d.setDate(d.getDate() + step / 24) : d.setHours(d.getHours() + step)) {
    ticks.push({ x: f1(X(d.getTime())), label: d.getHours() === 0 ? DAYS[d.getDay()] + ' ' + d.getDate() : pad(d.getHours()) + ':00' });
  }
  for (const tk of ticks) push(`<line x1="${tk.x}" x2="${tk.x}" y1="${Ln.bT}" y2="${axis}" style="stroke:color-mix(in srgb,var(--color-text) 7%,transparent)"></line>`);

  // Basal lane.
  const segs = D.basal.filter((s) => s.t1 > t0 && s.t0 < t1).map((s) => ({ ...s, t0: Math.max(s.t0, t0), t1: Math.min(s.t1, t1) }));
  if (segs.length) {
    let area = `M${f1(X(segs[0].t0))} ${base}`;
    let line = '';
    let prof = '';
    segs.forEach((s, i) => {
      const x0 = f1(X(s.t0));
      const x1 = f1(X(s.t1));
      const y = f1(BY(s.rate));
      const yp = f1(BY(s.prof));
      // A gap between segments (no profile known) starts a new step line.
      const join = i && segs[i - 1].t1 === s.t0 ? ' L' : 'M';
      area += join === 'M' && i ? ` L${f1(X(segs[i - 1].t1))} ${base} L${x0} ${base} L${x0} ${y} L${x1} ${y}` : ` L${x0} ${y} L${x1} ${y}`;
      line += (i ? join : 'M') + `${x0} ${y} L${x1} ${y}`;
      prof += (i ? join : 'M') + `${x0} ${yp} L${x1} ${yp}`;
    });
    area += ` L${f1(X(segs[segs.length - 1].t1))} ${base} Z`;
    push(`<path d="${area}" style="fill:var(--color-accent-200)"></path>`);
    push(`<path d="${line}" style="fill:none;stroke:var(--color-accent-600);stroke-width:1.25"></path>`);
    if (o.showProfile) push(`<path d="${prof}" style="fill:none;stroke:var(--color-accent-900);stroke-width:1;stroke-dasharray:4 3"></path>`);
  }

  // Carbs and insulin on board reported by the loop at each device-status
  // update; below 0 IOB gets a zero line.
  const cob = sampled(D.cobSeries, t0, t1, k);
  push(`<path d="${linePath(cob, X, CY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:${COB_COLOR};stroke-width:1.5;stroke-linejoin:round"></path>`);
  if (IMIN < 0) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(IY(0))}" y2="${f1(IY(0))}" style="stroke:color-mix(in srgb,${IOB_COLOR} 25%,transparent);stroke-dasharray:1 3"></line>`);
  const iob = sampled(D.iobSeries || [], t0, t1, k);
  push(`<path d="${linePath(iob, X, IY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:${IOB_COLOR};stroke-width:1.25;stroke-linejoin:round"></path>`);

  // Events; guide lines and labels only up to two days. SMBs get no guide
  // line and are left out beyond two days: there are hundreds a day.
  const ev = D.events.filter((e) => e.t >= t0 && e.t <= t1 && !(longRange && e.smb));
  if (!longRange) {
    for (const e of ev.filter((x) => !x.smb)) {
      const x = f1(X(e.t));
      push(`<line x1="${x}" x2="${x}" y1="${Ln.eT}" y2="${gBot}" style="stroke:color-mix(in srgb,var(--color-text) 22%,transparent);stroke-dasharray:2 3"></line>`);
    }
  }
  const labels = [];
  for (const e of ev.filter((x) => x.type === 'bolus')) {
    const x = X(e.t);
    const y = Ln.eT + 13;
    const s = e.smb ? 0.6 : 1;
    push(`<path d="M${f1(x - 5 * s)} ${y - 5 * s} L${f1(x + 5 * s)} ${y - 5 * s} L${f1(x)} ${y + 4 * s} Z" style="fill:var(--color-text)"></path>`);
    if (!longRange && (!e.smb || h <= 6)) labels.push([f1(x + 8), y + 3, e.v + 'U', 'fill:var(--color-text);font-weight:500']);
  }
  for (const e of ev.filter((x) => x.type === 'carbs')) {
    const x = X(e.t);
    const y = Ln.eT + 35;
    push(`<circle cx="${f1(x)}" cy="${y}" r="4.5" style="fill:var(--color-bg);stroke:${COB_COLOR};stroke-width:1.5"></circle>`);
    if (!longRange) labels.push([f1(x + 9), y + 4, e.v + 'g', `fill:${COB_COLOR}`]);
  }

  push(glucoseMarks(o, geo));
  if (o.showForecast) {
    for (const [minutes, style] of FORECAST_LINES) {
      const points = sampled(D.forecast[minutes] || [], t0, t1, k);
      push(`<path d="${linePath(points, X, GY, Math.max(20, 10 * k) * MIN)}" style="fill:none;${style};stroke-linejoin:round"></path>`);
    }
  }
  for (const e of ev.filter((x) => x.type === 'bg')) {
    const x = X(e.t);
    const y = GY(e.v);
    push(`<rect x="${f1(x - 4)}" y="${f1(y - 4)}" width="8" height="8" style="fill:var(--color-bg);stroke:var(--color-text);stroke-width:1.5"></rect>`);
    labels.push([f1(x + 9), f1(y - 7), fmt(e.v), 'fill:var(--color-text)']);
  }

  if (o.showLoop) push(loopOverlay(o, geo));
  if (o.sim) push(simOverlay(o, geo));
  if (o.pinned) {
    const x = f1(X(o.pinned.run.t));
    push(`<line x1="${x}" x2="${x}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-text);stroke-width:1;stroke-dasharray:3 3"></line>`);
    push(loopCurves(o.pinned.run, geo));
    if (o.pinned.changed) push(loopCurves({ t: o.pinned.run.t, pred: o.pinned.changed }, geo, true));
  }

  // Heart rate.
  const hw = sampled(D.hr, t0, t1, k);
  push(`<path d="${linePath(hw, X, HY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:var(--color-neutral-700);stroke-width:1.5;stroke-linejoin:round"></path>`);

  // Labels.
  for (const tk of ticks) text(tk.x, axis + 17, tk.label, 'text-anchor:middle');
  // Over the plot, a halo in the background colour keeps the values legible.
  const yx = narrow ? padL + 3 : plotR + 8;
  const ys = 'dominant-baseline:middle' + (narrow ? ';paint-order:stroke;stroke:var(--color-bg);stroke-width:3px;stroke-linejoin:round' : '');
  for (const v of gTicks) text(yx, f1(GY(v)), fmtTick(v), ys);
  // The basal lane is short: on phones, every second value and no zero.
  const bLabels = narrow ? bTicks.filter((x) => x > 0 && (BMAX > 3 ? x % 2 === 0 : true)) : bTicks.filter((x) => x <= 2 || BMAX > 3);
  for (const v of bLabels) text(yx, f1(BY(v)), v.toFixed(1), ys);
  for (const v of cobTicks) text(yx, f1(CY(v)), String(v), `${ys};fill:${COB_COLOR}`);
  // IOB's scale on the other side: inside the plot on the left, or on phones on the right
  const halo = ';paint-order:stroke;stroke:var(--color-bg);stroke-width:3px;stroke-linejoin:round';
  for (const v of iobTicks) {
    text(narrow ? plotR - 3 : padL + 3, f1(IY(v)), String(v), `dominant-baseline:middle;fill:${IOB_COLOR}${narrow ? ';text-anchor:end' : ''}${halo}`);
  }
  for (const v of [60, 80, 100, 120, 140, 160]) text(yx, f1(HY(v)), String(v), ys);
  const laneStyle = 'fill:var(--color-accent-700);font-size:10px;letter-spacing:0.1em';
  text(padL + 4, Ln.bT - 8, 'BASAL · U/H' + (narrow ? '' : ' · FILL = DELIVERED' + (o.showProfile ? ', DASHED = PROFILE' : '')), laneStyle);
  text(padL + 4, Ln.cT - 8, 'ON BOARD · CARBS (G), INSULIN (U)', laneStyle);
  text(padL + 4, Ln.eT - 2, 'BOLUS (U) · CARBS (G)', laneStyle);
  text(padL + 4, Ln.gT - 6, 'GLUCOSE · ' + o.units.toUpperCase(), laneStyle);
  text(padL + 4, Ln.hT - 6, 'HEART RATE · BPM', laneStyle);
  for (const [x, y, s, st] of labels) text(x, y, s, st);
  for (const [s, y] of narrow ? [] : [['U/h', Ln.bT + Ln.bH / 2], ['g', Ln.cT + Ln.cH / 2], [o.units, Ln.gT + Ln.gH / 2], ['bpm', Ln.hT + Ln.hH / 2]]) {
    push(`<text x="0" y="0" transform="translate(${W - 10} ${y}) rotate(90)" style="text-anchor:middle;font-family:var(--font-body);font-size:10px;letter-spacing:0.08em;fill:var(--color-accent-700)">${esc(s)}</text>`);
  }

  push('<g id="ann"></g>');
  push('<g id="sel"></g>');
  push('<g id="hov"></g>');
  push(`<rect class="hit${o.drag ? ' dragging' : ''}" id="hit" x="${padL}" y="0" width="${iw}" height="${H}"></rect>`);

  return `<svg width="${W}" height="${H}" role="img" aria-label="Glucose, basal, events and heart rate">${out.join('')}</svg>`;
}

// Claude's marks: blue where it found too much insulin (heading low), red too little.
export const MARK_COLOR = { over: 'var(--bg-low)', under: 'var(--bg-high)', ok: 'var(--bg-ok)', note: 'var(--color-neutral-700)' };
export const MARK_LABEL = { over: 'Too much', under: 'Too little', ok: 'Good', note: 'Note' };

/**
 * The hover layer at time `t`: the values there and, with the loop shown,
 * the run nearest it. Returns { html, run }.
 */
export function hoverSvg (o, t0hover) {
  if (o.sim) return simHoverSvg(o, t0hover);
  const D = o.data;
  const fmt = fmtFor(o);
  const geo = geometry(o);
  const { W, X, GY, HY, Ln, axis, t0, t1, k } = geo;
  const p = nearest(sampled(D.g, t0, t1, k), t0hover, 15 * MIN * k);
  const t = p ? p.t : t0hover;
  const x = X(t);
  const sg = D.basal.find((s) => t >= s.t0 && t < s.t1);
  const cob = nearest(D.cobSeries.filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const iob = nearest((D.iobSeries || []).filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const h = nearest(D.hr.filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const predicted = o.showForecast
    ? FORECAST_LINES.map(([m]) => [m, nearest((D.forecast[m] || []).filter((q) => Math.abs(q.t - t) <= 5 * MIN), t, 5 * MIN)])
    : [];
  const marks = (o.annotations || []).filter((a) => t >= a.from - 5 * MIN * k && t <= a.to + 5 * MIN * k);
  // The loop run nearest the pointer, with what it predicted.
  const run = o.showLoop ? nearest(D.loop.filter((r) => Math.abs(r.t - t) <= Math.max(6, 5 * k) * MIN), t, Math.max(6, 5 * k) * MIN) : null;
  // Wider with the loop, the prediction rows or Claude's marks, so their labels fit.
  const boxW = run ? 300 : marks.length ? 260 : predicted.length ? 216 : 180;
  // With a loop run, on the left: its predicted curves run to the right.
  const onLeft = run ? x > boxW + 40 : x > W - boxW - 40;
  const left = Math.round(onLeft ? x - boxW - 14 : x + 14);
  const time = o.withDay ? dayHm(t) : hm(t);
  const html = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-text);stroke-width:1"></line>`
    + (p ? `<circle cx="${f1(x)}" cy="${f1(GY(p.v))}" r="5" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (h ? `<circle cx="${f1(x)}" cy="${f1(HY(h.v))}" r="4" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (run ? loopCurves(run, geo) : '')
    // With a loop run the window is long: it starts at the top of the chart.
    + `<foreignObject x="${left}" y="${run ? Ln.bT : Ln.gT}" width="${boxW + 16}" height="${140 + 20 * predicted.length + 40 * marks.length + (run ? 300 : 0)}" style="pointer-events:none"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${boxW}px;margin:4px;background:var(--color-bg);border:1px solid var(--color-text);box-shadow:var(--shadow-md);padding:var(--space-2) var(--space-3);display:grid;grid-template-columns:1fr auto;gap:2px var(--space-3);font-size:12px">`
    + `<div style="grid-column:span 2;font-family:var(--font-heading);font-weight:600;font-size:15px">${time}</div>`
    + `<span style="color:var(--color-neutral-700)">Glucose</span><span>${p ? fmt(p.v) + ' ' + o.units : '–'}</span>`
    + predicted.map(([m, q]) => `<span style="color:var(--color-neutral-700)">Predicted ${m} min ago</span><span>${q ? fmt(q.v) : '–'}</span>`).join('')
    + `<span style="color:var(--color-neutral-700)">Basal</span><span>${sg ? sg.rate.toFixed(2) + ' U/h' : '–'}</span>`
    + (o.showProfile ? `<span style="color:var(--color-neutral-700)">Profile</span><span>${sg ? sg.prof.toFixed(2) + ' U/h' : '–'}</span>` : '')
    + `<span style="color:var(--color-neutral-700)">IOB</span><span>${iob ? iob.v.toFixed(2) + ' U' : '–'}</span>`
    + `<span style="color:var(--color-neutral-700)">COB</span><span>${cob ? Math.round(cob.v) + ' g' : '–'}</span>`
    + `<span style="color:var(--color-neutral-700)">Heart rate</span><span>${h ? h.v + ' bpm' : '–'}</span>`
    + (run ? loopRows(o, run) : '')
    + marks.map((a) => `<span style="grid-column:span 2;border-top:1px solid var(--color-divider);padding-top:2px"><b style="color:${MARK_COLOR[a.kind]}">(${a.n}) ${MARK_LABEL[a.kind]}</b> ${esc(a.text)}</span>`).join('')
    + '</div></foreignObject>';
  return { html, run };
}

/**
 * The values of one 5-minute step, actual and simulated side by side:
 * [label, actual, simulated] as text. `step` { t, actual: { g, basal,
 * smb, run }, sim: { g, lo, hi, basal, smb, run } }.
 */
export function stepRows (step, fmt) {
  const g = (v) => (v == null ? '–' : fmt(v));
  const u = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
  const a = step.actual;
  const s = step.sim;
  const ar = a.run || {};
  const sr = s.run || {};
  return [
    ['Glucose', g(a.g), g(s.g)],
    ['Basal (U/h)', u(a.basal), u(s.basal)],
    ['SMB (U)', a.smb ? u(a.smb) : '–', s.smb ? u(s.smb) : '–'],
    ['IOB (U)', u(ar.iob), u(sr.iob)],
    ['COB (g)', u(ar.cob, 0), u(sr.cob, 0)],
    ['Eventual', g(ar.eventual), g(sr.eventual)],
    ['Target', g(ar.target), g(sr.target)],
    ['Insulin req. (U)', u(ar.insulinReq), u(sr.insulinReq)],
    ['ISF used', g(ar.isf), g(sr.isf)],
    ['Decision', a.run ? runResult(ar) : '–', s.run ? runResult(sr) : '–'],
  ];
}

/** The hover of the simulate page: each value actual and simulated, the differences marked. */
function simHoverSvg (o, tHover) {
  const D = o.data;
  const s = o.sim;
  const fmt = fmtFor(o);
  const geo = geometry(o);
  const { W, X, GY, Ln, axis, t0, t1, k } = geo;
  const p = nearest(sampled(D.g, t0, t1, k), tHover, 15 * MIN * k);
  const t = p ? p.t : tHover;
  const x = X(t);
  const near = (list, gap) => nearest(list.filter((q) => Math.abs(q.t - t) <= gap), t, gap);
  const sg = D.basal.find((b) => t >= b.t0 && t < b.t1);
  const sb = (s.basal || []).find((b) => t >= b.t0 && t < b.t1);
  const sp = near(s.g || [], 3 * MIN);
  const band = near(s.band || [], 3 * MIN);
  // SMBs in the 5 minutes up to this reading
  const smbIn = (list) => list.filter((e) => e.t > t - 5 * MIN && e.t <= t + 30 * 1000).reduce((sum, e) => sum + e.v, 0);
  const step = {
    t,
    actual: { g: p?.v, basal: sg?.rate, smb: smbIn(D.events.filter((e) => e.type === 'bolus' && e.smb)), run: near(D.loop, 4 * MIN) },
    sim: { g: sp?.v, basal: sb?.rate, smb: smbIn(s.smbs || []), run: near(s.runs || [], 4 * MIN) },
  };
  const rows = stepRows(step, fmt);
  const boxW = 330;
  const left = Math.round(x > W - boxW - 40 ? x - boxW - 14 : x + 14);
  const cell = (v, differs) => `<span style="text-align:right${differs ? `;color:${SIM};font-weight:600` : ''}">${esc(v)}</span>`;
  const html = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-text);stroke-width:1"></line>`
    + (p ? `<circle cx="${f1(x)}" cy="${f1(GY(p.v))}" r="5" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (sp ? `<circle cx="${f1(x)}" cy="${f1(GY(sp.v))}" r="5" style="fill:none;stroke:${SIM};stroke-width:1.5"></circle>` : '')
    + `<foreignObject x="${left}" y="${Ln.bT}" width="${boxW + 16}" height="520" style="pointer-events:none"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${boxW}px;margin:4px;background:var(--color-bg);border:1px solid var(--color-text);box-shadow:var(--shadow-md);padding:var(--space-2) var(--space-3);display:grid;grid-template-columns:auto 1fr 1fr;gap:2px var(--space-3);font-size:12px">`
    + `<div style="grid-column:span 3;font-family:var(--font-heading);font-weight:600;font-size:15px">${o.withDay ? dayHm(t) : hm(t)}</div>`
    + `<span></span><b style="text-align:right">Actual</b><b style="text-align:right;color:${SIM}">Simulated</b>`
    + rows.map(([label, a, b]) => (label === 'Decision'
      ? `<span style="grid-column:span 3;border-top:1px solid var(--color-divider);padding-top:2px;color:var(--color-neutral-700)">Decision</span><span style="grid-column:span 3">${esc(a)}</span><span style="grid-column:span 3;${a !== b ? `color:${SIM};font-weight:600` : ''}">${esc(b)}</span>`
      : `<span style="color:var(--color-neutral-700)">${esc(label)}</span>${cell(a, false)}${cell(b, a !== b)}`)).join('')
    + (band ? `<span style="grid-column:span 3;color:var(--color-neutral-700);font-size:11px">Band ${fmt(band.lo)}–${fmt(band.hi)} ${esc(o.units)}</span>` : '')
    + '</div></foreignObject>';
  return { html, run: null };
}
