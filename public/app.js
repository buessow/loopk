import { buildModel, docTime, glucoseSeries, gmiFromMmol, timeInRanges, trendDirection, MIN, HOUR, MGDL_PER_MMOL } from './model.js';

const $ = (id) => document.getElementById(id);
const RANGES = [3, 6, 12, 24, 48, 168, 720];
const STYLES = ['boxes', 'sticks', 'dots', 'line'];
const UNITS = ['mmol/L', 'mg/dL'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A reading older than this is shown as out of date.
const STALE = 10 * MIN;
const TREND_ANGLE = {
  DoubleUp: -90, SingleUp: -90, FortyFiveUp: -45, Flat: 0, FortyFiveDown: 45, SingleDown: 90, DoubleDown: 90,
};
// What a periodic or live reload fetches again: the summary tiles and, while
// the chart shows the present, its newest part.
const RECENT = 30 * HOUR;
// Keep a 30-day browser-side buffer either side of the visible chart window.
// This lets the chart pan through the full history without retaining it all.
const CACHE_MARGIN = 30 * 24 * HOUR;
const PAGE = 1000;
// What the chart needs of a treatment; profile switches add their profile.
const TREATMENT_FIELDS = 'identifier,date,created_at,srvModified,eventType,type,isSMB,insulin,carbs,glucose,units,'
  + 'duration,durationInMilliseconds,absolute,rate,percent,profile,profileJson,percentage,timeshift';

// Target range 3.9–10 mmol/L (70–180 mg/dL), as in the design.
const LO = 3.9;
const HI = 10;

const state = {
  recent: null, // the last RECENT, device status and profile, for the tiles
  now: null, // model of `recent`
  win: null, // documents loaded for the chart: [loadedFrom, loadedTo)
  loadedFrom: null,
  loadedTo: null, // null: up to now
  data: null, // model of `win`
  anchor: Date.now(), // "now" the offset counts back from; moved on reload
  earliest: null, // time of the first reading
  hours: stored('hours', (v) => RANGES.includes(+v), 24, Number),
  units: stored('units', (v) => UNITS.includes(v), null),
  style: stored('style', (v) => STYLES.includes(v), 'boxes'),
  showProfile: stored('profile', (v) => v === '0' || v === '1', true, (v) => v === '1'),
  offset: 0, // ms the window is panned back from the anchor
  W: 1200,
  hoverT: null,
  drag: null,
};

function stored (key, valid, fallback, parse = (v) => v) {
  try {
    const v = localStorage.getItem('loopk.' + key);
    return v != null && valid(v) ? parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function store (key, value) {
  try { localStorage.setItem('loopk.' + key, String(value)); } catch { /* private mode */ }
}

const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dayHm = (t, month = false) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${d.getDate()}${month ? ' ' + MONTHS[d.getMonth()] : ''} · ${hm(t)}`; };
const f1 = (n) => n.toFixed(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rangeLabel = (h) => (h <= 24 ? h + 'h' : h / 24 + 'd');
/** How long ago `t` was: "3 min", "2 h 5 min", "4 d". */
function ago (t) {
  const m = Math.max(0, Math.round((Date.now() - t) / MIN));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.round(m / 1440)} d`;
}

// Glucose is kept in mmol/L and shown in the chosen unit.
const unit = () => state.units || 'mmol/L';
const mgdl = () => unit() === 'mg/dL';
const fmt = (v) => (mgdl() ? String(Math.round(v * MGDL_PER_MMOL)) : v.toFixed(1));
/** A round value (axis, target), without trailing zeros in mmol/L. */
const fmtTick = (v) => (mgdl() ? String(Math.round(v * MGDL_PER_MMOL)) : String(v));

// --- loading -------------------------------------------------------------

async function api (path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const body = await res.json();
  return body.result ?? body;
}

/**
 * All documents of a collection with `field` in [from, to), fetched in pages
 * of PAGE sorted by that field. `field` is `date` (epoch ms) or `created_at` (ISO).
 */
async function fetchRange (col, field, from, to, query = '') {
  const value = (t) => (field === 'date' ? t : new Date(t).toISOString());
  const docs = new Map();
  let cursor = value(from);
  for (;;) {
    const upper = to != null ? `&${field}$lt=${encodeURIComponent(value(to))}` : '';
    const page = await api(`/api/v3/${col}?${field}$gte=${encodeURIComponent(cursor)}${upper}&sort=${field}&limit=${PAGE}${query}`);
    const before = docs.size;
    for (const d of page) docs.set(d.identifier, d);
    if (page.length < PAGE || docs.size === before) break;
    // Continue from the last value; documents sharing it are deduplicated.
    cursor = page[page.length - 1][field];
  }
  return [...docs.values()];
}

/** Entries, treatments and heart rate in [from, to). */
async function fetchSeries (from, to) {
  const [entries, treatments, heartrate] = await Promise.all([
    fetchRange('entries', 'date', from, to, '&type=sgv&fields=identifier,date,srvModified,sgv,direction,type'),
    fetchRange('treatments', 'created_at', from, to, '&fields=' + TREATMENT_FIELDS),
    fetchRange('heartrate', 'date', from, to, '&fields=identifier,date,srvModified,beatsPerMinute').catch(() => []),
  ]);
  return { entries, treatments, heartrate };
}

const SERIES = ['entries', 'treatments', 'heartrate'];

function merge (old, fresh, keep = () => true) {
  const byId = new Map(old.filter(keep).map((d) => [d.identifier, d]));
  for (const d of fresh) byId.set(d.identifier, d);
  return [...byId.values()].sort((a, b) => docTime(a) - docTime(b));
}

/** The latest profile switch before `t`: the profile in effect at the start of loaded data. */
function fetchSwitchBefore (t) {
  return api(`/api/v3/treatments?eventType$re=Profile%20Switch$&created_at$lt=${new Date(t).toISOString()}&sort$desc=created_at&limit=1`);
}

/** Reloads recent data, device status and profile; the chart keeps what it has loaded. */
async function loadRecent () {
  const now = Date.now();
  const from = now - RECENT;
  const [series, devicestatus, profiles, switchesBefore, lastEntry] = await Promise.all([
    fetchSeries(from, null),
    api('/api/v3/devicestatus?sort$desc=created_at&limit=3'),
    api('/api/v3/profile?sort$desc=date&limit=1'),
    fetchSwitchBefore(from),
    api('/api/v3/entries?type=sgv&sort$desc=date&limit=1&fields=identifier,date,srvModified,sgv,direction,type'),
  ]);
  state.recent = { ...series, devicestatus, profile: profiles[0], switchesBefore, lastEntry: lastEntry[0] };
  // When the server last received anything from the phone, with or without glucose.
  let lastUpload = null;
  for (const d of [...devicestatus, ...lastEntry, ...series.entries, ...series.treatments, ...series.heartrate]) {
    const t = typeof d.srvModified === 'number' ? d.srvModified : docTime(d);
    if (t != null && t <= now + MIN && (lastUpload == null || t > lastUpload)) lastUpload = t;
  }
  state.recent.lastUpload = lastUpload;
  state.now = buildModel({ ...state.recent, start: from, now });
  if (!state.units) state.units = /^mg/i.test(profiles[0]?.units || '') ? 'mg/dL' : 'mmol/L';

  // A window panned into the past stays where it is while time moves on.
  if (state.offset > 0) state.offset += now - state.anchor;
  state.anchor = now;
  if (!state.win) {
    state.win = { ...series, switchesBefore };
    state.loadedFrom = from;
    state.loadedTo = null;
  } else if (state.loadedTo == null) {
    const older = (d) => docTime(d) < from;
    for (const k of SERIES) state.win[k] = merge(state.win[k], series[k], older);
    state.loadedFrom = Math.min(state.loadedFrom, from);
  }
  rebuild();
  ensureLoaded().catch(console.error);
}

/**
 * Loads the 30-day cache around the visible window and drops data outside it.
 * Runs one fetch at a time; calls itself until the cache is complete.
 */
let extending = null;
async function ensureLoaded () {
  if (!state.win || extending) return;
  const { from, to } = cacheWindow();
  const loadedTo = state.loadedTo ?? state.anchor;
  let job = null;
  if (from < state.loadedFrom) {
    job = { from, to: state.loadedFrom };
  } else if (to > loadedTo) {
    job = { from: loadedTo, to };
  }
  if (!job) {
    if (trim()) rebuild();
    return;
  }
  extending = (async () => {
    $('loading').hidden = false;
    const [series, switchesBefore] = await Promise.all([
      fetchSeries(job.from, job.to),
      job.from < state.loadedFrom ? fetchSwitchBefore(job.from) : null,
    ]);
    for (const k of SERIES) state.win[k] = merge(state.win[k], series[k]);
    if (job.from < state.loadedFrom) {
      state.win.switchesBefore = switchesBefore;
      state.loadedFrom = job.from;
    } else {
      // null means that recent reloads keep this end current.
      state.loadedTo = job.to >= state.anchor ? null : job.to;
    }
    trim();
    rebuild();
  })();
  try {
    await extending;
  } finally {
    extending = null;
    $('loading').hidden = true;
  }
  ensureLoaded().catch(console.error);
}

/** The target cache bounds for the current visible chart window. */
function cacheWindow () {
  const { t0, t1 } = windowTimes();
  return {
    from: Math.max(earliest(), t0 - CACHE_MARGIN),
    to: Math.min(state.anchor, t1 + CACHE_MARGIN),
  };
}

/** Drops documents outside the 30-day cache on either side of the window. */
function trim () {
  const { from, to } = cacheWindow();
  const loadedTo = state.loadedTo ?? state.anchor;
  const w = state.win;
  let changed = false;
  if (state.loadedFrom < from) {
    // The newest switch dropped is the profile in effect from the new start.
    const before = [...w.switchesBefore, ...w.treatments.filter((d) => docTime(d) < from && /Profile Switch$/.test(d.eventType || ''))];
    w.switchesBefore = before.length ? [before[before.length - 1]] : [];
    state.loadedFrom = from;
    changed = true;
  }
  if (loadedTo > to) {
    state.loadedTo = to >= state.anchor ? null : to;
    changed = true;
  }
  const inside = (d) => { const t = docTime(d); return t >= state.loadedFrom && (state.loadedTo == null || t < state.loadedTo); };
  for (const k of SERIES) {
    const filtered = w[k].filter(inside);
    if (filtered.length !== w[k].length) changed = true;
    w[k] = filtered;
  }
  return changed;
}

function rebuild () {
  const { recent, win } = state;
  state.data = buildModel({
    ...win, devicestatus: recent.devicestatus, profile: recent.profile,
    start: state.loadedFrom, now: state.loadedTo ?? state.anchor,
  });
  clampOffset();
  render();
}

// --- window --------------------------------------------------------------

function span () {
  return state.hours * HOUR;
}

function earliest () {
  return state.earliest ?? state.anchor - 30 * 24 * HOUR;
}

function windowTimes () {
  const t1 = state.anchor - state.offset;
  return { t0: t1 - span(), t1 };
}

function maxOffset () {
  return Math.max(0, state.anchor - earliest() - span());
}

function clampOffset () {
  state.offset = Math.max(0, Math.min(maxOffset(), state.offset));
}

function pan (ms) {
  state.offset += ms;
  clampOffset();
  state.hoverT = null;
  scheduleRender();
  ensureLoaded().catch(console.error);
}

let frame = null;
function scheduleRender () {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    render();
  });
}

// --- summary tiles -------------------------------------------------------

function renderTrend (id, current, previous, decimals, name) {
  const el = $(id);
  const direction = trendDirection(current, previous, decimals);
  if (!direction) {
    el.hidden = true;
    return;
  }
  const symbol = { up: '↗', down: '↘', flat: '→' }[direction];
  const word = { up: 'increased', down: 'decreased', flat: 'unchanged' }[direction];
  el.hidden = false;
  el.textContent = symbol;
  el.title = `${name} ${word} from the previous equal period`;
  el.setAttribute('aria-label', `${name} ${word} from the previous equal period`);
}

function renderStats () {
  const N = state.now;
  const G = N.g.filter((p) => p.t >= N.start);
  // The newest reading, also when it is older than the recent data.
  const last = G[G.length - 1] || glucoseSeries(state.recent.lastEntry ? [state.recent.lastEntry] : [])[0];

  const up = state.recent.lastUpload;
  $('syncText').textContent = up != null ? `Last update ${ago(up)} ago` : 'No updates';
  $('syncText').classList.toggle('tag-warn', up == null || Date.now() - up >= STALE);

  if (!last) {
    $('glucoseKicker').textContent = 'Glucose now';
    $('bgNow').textContent = '–';
    $('bgNow').className = 'bg-now';
    $('delta').textContent = 'No glucose readings';
    $('glucoseAge').hidden = true;
    $('trendIcon').style.display = 'none';
  } else {
    const stale = Date.now() - last.t >= STALE;
    $('glucoseKicker').textContent = `${stale ? 'Last glucose' : 'Glucose now'} · ${hm(last.t)}`;
    $('bgNow').textContent = fmt(last.v);
    $('bgNow').className = 'bg-now ' + (stale ? 'stale' : last.v > HI ? 'high' : last.v < LO ? 'low' : 'ok');
    $('bgNow').title = stale ? 'Last reading is out of date' : '';
    $('glucoseAge').hidden = false;
    $('glucoseAge').textContent = `Last glucose ${ago(last.t)} ago`;
    $('glucoseAge').className = 'tag ' + (stale ? 'tag-warn' : 'tag-neutral');
    $('trendIcon').style.display = stale ? 'none' : '';

    const prev = G.length > 1 && last.t - G[G.length - 2].t <= 15 * MIN ? G[G.length - 2] : null;
    const p15 = G.find((p) => p.t >= last.t - 16 * MIN);
    let angle = TREND_ANGLE[last.direction];
    if (angle === undefined && p15 && p15 !== last) {
      const slope = (last.v - p15.v) / ((last.t - p15.t) / (5 * MIN));
      angle = slope >= 0.3 ? -90 : slope >= 0.12 ? -45 : slope > -0.12 ? 0 : slope > -0.3 ? 45 : 90;
    }
    $('trend').setAttribute('transform', `translate(24 24) rotate(${angle ?? 0}) scale(1.8) translate(-12 -12)`);
    $('trend').style.display = angle === undefined ? 'none' : '';
    if (stale) {
      $('delta').textContent = 'Waiting for the sensor';
    } else if (prev) {
      const dl = last.v - prev.v;
      $('delta').textContent = `${dl >= 0 ? '+' : '−'}${fmt(Math.abs(dl))} ${unit()} in ${Math.round((last.t - prev.t) / MIN)} min`;
    } else {
      $('delta').textContent = ' ';
    }
  }

  // Time in ranges and mean cover the window shown in the chart; trends use
  // the preceding window of the same duration.
  const { t0, t1 } = windowTimes();
  const W = state.data.g.filter((p) => p.t > t0 && p.t <= t1);
  const previous = state.data.g.filter((p) => p.t > t0 - span() && p.t <= t0);
  const ranges = timeInRanges(W);
  const previousRanges = timeInRanges(previous);
  $('tirVeryLow').textContent = ranges.veryLow ?? '–';
  $('tirLow').textContent = ranges.low ?? '–';
  $('tir').textContent = ranges.inRange ?? '–';
  $('tirHigh').textContent = ranges.high ?? '–';
  $('tirVeryHigh').textContent = ranges.veryHigh ?? '–';
  const mean = W.length ? W.reduce((a, p) => a + p.v, 0) / W.length : null;
  const previousMean = previous.length ? previous.reduce((a, p) => a + p.v, 0) / previous.length : null;
  const gmi = gmiFromMmol(mean);
  const previousGmi = gmiFromMmol(previousMean);
  $('mean').textContent = mean != null ? fmt(mean) : '–';
  $('gmi').textContent = gmi != null ? gmi.toFixed(1) : '–';
  const displayMean = (value) => value != null && mgdl() ? value * MGDL_PER_MMOL : value;
  renderTrend('meanTrend', displayMean(mean), displayMean(previousMean), mgdl() ? 0 : 1, 'Mean glucose');
  renderTrend('tirTrend', ranges.inRange, previousRanges.inRange, 0, 'Target time in range');
  renderTrend('gmiTrend', gmi, previousGmi, 1, 'GMI');
  const label = state.hours <= 24 ? `${state.hours} h` : `${state.hours / 24} d`;
  document.querySelectorAll('.statHours').forEach((el) => { el.textContent = label; });
  $('gmiNote').textContent = mean != null
    ? `CGM estimate, not lab HbA1c · ${W.length} readings · ${label}`
    : `No readings · ${label}`;

  const cs = N.basal[N.basal.length - 1];
  $('basalNow').textContent = cs ? cs.rate.toFixed(2) : '–';
  $('basalNote').textContent = cs && cs.prof > 0 ? `${Math.round(cs.rate / cs.prof * 100)}% of profile ${cs.prof.toFixed(2)}` : 'no profile';
  $('iob').textContent = N.iob != null ? N.iob.toFixed(1) : '–';
  $('cob').textContent = N.cob != null ? Math.round(N.cob) : '–';
  const lastHr = N.hr[N.hr.length - 1];
  $('hrNow').textContent = lastHr && Date.now() - lastHr.t < 30 * MIN ? lastHr.v : '–';
}

/** Texts that name the unit or the target range. */
function renderUnits () {
  document.querySelectorAll('.unit').forEach((el) => { el.textContent = unit(); });
  document.querySelectorAll('.target').forEach((el) => { el.textContent = `${fmtTick(LO)}–${fmtTick(HI)} ${unit()}`; });
  $('legHigh').textContent = `High >${fmtTick(HI)}`;
  $('legLow').textContent = `Low <${fmtTick(LO)}`;
}

function renderTitle () {
  const scrolled = state.offset > 0;
  $('toNow').hidden = !scrolled;
  $('later').disabled = !scrolled;
  $('earlier').disabled = state.offset >= maxOffset();
  if (!scrolled) {
    $('rangeTitle').textContent = 'Last ' + (state.hours <= 24 ? state.hours + ' hours' : state.hours / 24 + ' days');
    return;
  }
  const { t0, t1 } = windowTimes();
  // Long windows, and windows beyond this year, name the month and year.
  const month = state.hours > 48 || new Date(t0).getMonth() !== new Date(t1).getMonth();
  const year = new Date(t1).getFullYear() !== new Date(state.anchor).getFullYear() ? ` ${new Date(t1).getFullYear()}` : '';
  $('rangeTitle').textContent = `${dayHm(t0, month)} – ${dayHm(t1, month)}${year}`;
}

// --- chart ---------------------------------------------------------------

/** Geometry shared by the chart and its hover layer (lanes as in the design). */
function geometry () {
  const D = state.data;
  const W = Math.max(300, state.W);
  const padL = 12;
  // Phones: no rotated unit labels, and the axis values sit on the left,
  // over the plot, so the plot gets the whole width.
  const narrow = W < 640;
  const padR = narrow ? 8 : 64;
  const iw = W - padL - padR;
  const plotR = padL + iw;
  const { t0, t1 } = windowTimes();
  const Ln = { bT: 22, bH: 56, eT: 92, eH: 48, gT: 152, gH: 330, hT: 512, hH: 110 };
  const axis = Ln.hT + Ln.hH + 8;
  const GMIN = 2;
  const GMAX = 20;
  const HMIN = 40;
  const HMAX = 170;
  const visible = D.basal.filter((s) => s.t1 > t0 && s.t0 < t1);
  const BMAX = Math.max(2.4, ...visible.map((s) => Math.max(s.rate, state.showProfile ? s.prof : 0) * 1.1));
  // Long ranges draw every k-th 5-minute reading (about 400 at most).
  const k = Math.max(1, Math.ceil(state.hours * 12 / 400));
  return {
    W, H: axis + 26, narrow, padL, padR, iw, plotR, t0, t1, Ln, axis, BMAX, k,
    X: (t) => padL + (t - t0) / (t1 - t0) * iw,
    GY: (v) => Ln.gT + (1 - (Math.min(GMAX, Math.max(GMIN, v)) - GMIN) / (GMAX - GMIN)) * Ln.gH,
    BY: (v) => Ln.bT + Ln.bH - Math.min(v, BMAX) / BMAX * Ln.bH,
    HY: (v) => Ln.hT + (1 - (Math.min(HMAX, Math.max(HMIN, v)) - HMIN) / (HMAX - HMIN)) * Ln.hH,
  };
}

/** Readings in the window, thinned to one per 5·k minutes. */
function sampled (points, t0, t1, k) {
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
function linePath (points, X, Y, gap) {
  let d = '';
  let prev = null;
  for (const p of points) {
    d += (prev && p.t - prev.t <= gap ? ' L' : ' M') + f1(X(p.t)) + ' ' + f1(Y(p.v));
    prev = p;
  }
  return d.trim();
}

const rangeOf = (v) => (v < LO ? 'lo' : v > HI ? 'hi' : 'ok');

/** Glucose in the chosen style: boxes, sticks (fading bars), dots or a line. */
function glucoseMarks ({ W, iw, X, GY, Ln, t0, t1, k }) {
  const gw = sampled(state.data.g, t0, t1, k);
  const gBot = Ln.gT + Ln.gH;
  const out = [];
  if (state.style === 'line') {
    out.push(`<path d="${linePath(gw, X, GY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:var(--bg-ok);stroke-width:2;stroke-linejoin:round"></path>`);
  } else if (state.style === 'dots') {
    const h = state.hours;
    const r = h <= 3 ? 3 : h <= 6 ? 2.6 : h <= 12 ? 2.2 : 1.8;
    const color = { lo: 'var(--bg-low)', ok: 'var(--bg-ok)', hi: 'var(--bg-high)' };
    for (const p of gw) out.push(`<circle cx="${f1(X(p.t))}" cy="${f1(GY(p.v))}" r="${r}" style="fill:${color[rangeOf(p.v)]}"></circle>`);
  } else {
    // Bars from the bottom of the lane: stacked boxes, or sticks fading downwards.
    const boxes = state.style === 'boxes';
    const bw = Math.max(1, Math.min(8, iw / Math.max(1, Math.round(span() / (5 * MIN * k))) * 0.62));
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

function renderChart () {
  const D = state.data;
  const geo = geometry();
  const { W, H, narrow, padL, plotR, iw, t0, t1, Ln, axis, X, GY, BY, HY, BMAX, k } = geo;
  const longRange = state.hours > 48;
  const out = [];
  const push = (s) => out.push(s);
  const text = (x, y, s, style = '') => push(`<text x="${x}" y="${y}" style="fill:var(--color-neutral-700);font-family:var(--font-body);font-size:11px;${style}">${esc(s)}</text>`);
  const gBot = Ln.gT + Ln.gH;

  // Target band and grid.
  push(`<rect x="${padL}" y="${f1(GY(HI))}" width="${iw}" height="${f1(GY(LO) - GY(HI))}" style="fill:var(--bg-band)"></rect>`);
  const gTicks = [LO, 6, 8, HI, 14, 18];
  const bTicks = [0, 1, 2, 3, 4, 5].filter((v) => v <= BMAX);
  for (const v of [6, 8, 14, 18]) {
    push(`<line x1="${padL}" x2="${plotR}" y1="${f1(GY(v))}" y2="${f1(GY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  }
  for (const v of bTicks.filter((v) => v > 0)) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(BY(v))}" y2="${f1(BY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  for (const v of [60, 100, 140]) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(HY(v))}" y2="${f1(HY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  const base = Ln.bT + Ln.bH;
  for (const y of [base, gBot, Ln.hT + Ln.hH, axis]) push(`<line x1="${padL}" x2="${plotR}" y1="${y}" y2="${y}" style="stroke:var(--color-divider)"></line>`);

  // Time ticks: hours up to two days, then midnights.
  const h = state.hours;
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
    if (state.showProfile) push(`<path d="${prof}" style="fill:none;stroke:var(--color-accent-900);stroke-width:1;stroke-dasharray:4 3"></path>`);
  }

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
    push(`<circle cx="${f1(x)}" cy="${y}" r="4.5" style="fill:var(--color-bg);stroke:var(--color-text);stroke-width:1.5"></circle>`);
    if (!longRange) labels.push([f1(x + 9), y + 4, e.v + 'g', 'fill:var(--color-text)']);
  }

  push(glucoseMarks(geo));
  for (const e of ev.filter((x) => x.type === 'bg')) {
    const x = X(e.t);
    const y = GY(e.v);
    push(`<rect x="${f1(x - 4)}" y="${f1(y - 4)}" width="8" height="8" style="fill:var(--color-bg);stroke:var(--color-text);stroke-width:1.5"></rect>`);
    labels.push([f1(x + 9), f1(y - 7), fmt(e.v), 'fill:var(--color-text)']);
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
  for (const v of [60, 80, 100, 120, 140, 160]) text(yx, f1(HY(v)), String(v), ys);
  const laneStyle = 'fill:var(--color-accent-700);font-size:10px;letter-spacing:0.1em';
  text(padL + 4, Ln.bT - 8, 'BASAL · U/H' + (narrow ? '' : ' · FILL = DELIVERED' + (state.showProfile ? ', DASHED = PROFILE' : '')), laneStyle);
  text(padL + 4, Ln.eT - 2, 'BOLUS (U) · CARBS (G)', laneStyle);
  text(padL + 4, Ln.gT - 6, 'GLUCOSE · ' + unit().toUpperCase(), laneStyle);
  text(padL + 4, Ln.hT - 6, 'HEART RATE · BPM', laneStyle);
  for (const [x, y, s, st] of labels) text(x, y, s, st);
  for (const [s, y] of narrow ? [] : [['U/h', Ln.bT + Ln.bH / 2], [unit(), Ln.gT + Ln.gH / 2], ['bpm', Ln.hT + Ln.hH / 2]]) {
    push(`<text x="0" y="0" transform="translate(${W - 10} ${y}) rotate(90)" style="text-anchor:middle;font-family:var(--font-body);font-size:10px;letter-spacing:0.08em;fill:var(--color-accent-700)">${esc(s)}</text>`);
  }

  push('<g id="hov"></g>');
  push(`<rect class="hit${state.drag ? ' dragging' : ''}" id="hit" x="${padL}" y="0" width="${iw}" height="${H}"></rect>`);

  $('chartWrap').innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Glucose, basal, events and heart rate">${out.join('')}</svg>`;
  renderHover();
}

function nearest (points, t, maxGap) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best && Math.abs(best.t - t) <= maxGap ? best : null;
}

function renderHover () {
  const g = $('hov');
  if (!g) return;
  const D = state.data;
  if (state.hoverT == null) {
    g.innerHTML = '';
    return;
  }
  const { W, X, GY, HY, Ln, axis, t0, t1, k } = geometry();
  const p = nearest(sampled(D.g, t0, t1, k), state.hoverT, 15 * MIN * k);
  const t = p ? p.t : state.hoverT;
  const x = X(t);
  const sg = D.basal.find((s) => t >= s.t0 && t < s.t1);
  const h = nearest(D.hr.filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const left = Math.round(x > W - 220 ? x - 194 : x + 14);
  const time = state.hours > 24 || state.offset > 0 ? dayHm(t) : hm(t);
  g.innerHTML = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-text);stroke-width:1"></line>`
    + (p ? `<circle cx="${f1(x)}" cy="${f1(GY(p.v))}" r="5" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (h ? `<circle cx="${f1(x)}" cy="${f1(HY(h.v))}" r="4" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + `<foreignObject x="${left}" y="${Ln.gT}" width="196" height="140" style="pointer-events:none"><div xmlns="http://www.w3.org/1999/xhtml" style="width:180px;margin:4px;background:var(--color-bg);border:1px solid var(--color-text);box-shadow:var(--shadow-md);padding:var(--space-2) var(--space-3);display:grid;grid-template-columns:1fr auto;gap:2px var(--space-3);font-size:12px">`
    + `<div style="grid-column:span 2;font-family:var(--font-heading);font-weight:600;font-size:15px">${time}</div>`
    + `<span style="color:var(--color-neutral-700)">Glucose</span><span>${p ? fmt(p.v) + ' ' + unit() : '–'}</span>`
    + `<span style="color:var(--color-neutral-700)">Basal</span><span>${sg ? sg.rate.toFixed(2) + ' U/h' : '–'}</span>`
    + (state.showProfile ? `<span style="color:var(--color-neutral-700)">Profile</span><span>${sg ? sg.prof.toFixed(2) + ' U/h' : '–'}</span>` : '')
    + `<span style="color:var(--color-neutral-700)">Heart rate</span><span>${h ? h.v + ' bpm' : '–'}</span>`
    + '</div></foreignObject>';
}

/** A segmented control: one radio per option. */
function renderSeg (id, options, current, label = (o) => o) {
  $(id).innerHTML = options.map((o) => `<label class="seg-opt"><input type="radio" name="${id}" value="${o}" ${o === current ? 'checked' : ''}>${esc(label(o))}</label>`).join('');
}

function renderOptions () {
  renderSeg('ranges', RANGES, state.hours, rangeLabel);
  renderSeg('glucoseStyle', STYLES, state.style, (s) => s[0].toUpperCase() + s.slice(1));
  renderSeg('units', UNITS, unit());
  $('showProfile').checked = state.showProfile;
  $('legProfile').hidden = !state.showProfile;
}

function render () {
  if (!state.data) return;
  renderUnits();
  renderTitle();
  renderStats();
  renderChart();
}

// --- wiring --------------------------------------------------------------

function wireChart () {
  const wrap = $('chartWrap');
  const timeAt = (e) => {
    const { t0, t1, padL, iw } = geometry();
    const rc = wrap.getBoundingClientRect();
    return t0 + (e.clientX - rc.left - padL) / iw * (t1 - t0);
  };
  const isHit = (e) => e.target.id === 'hit';

  // Drag (mouse or touch) pans; the chart is redrawn while dragging, so the
  // wrapper, which stays, captures the pointer.
  wrap.addEventListener('pointerdown', (e) => {
    if (!isHit(e) || e.button !== 0) return;
    e.preventDefault();
    state.drag = { x: e.clientX, offset: state.offset, id: e.pointerId, moved: false };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (state.drag && e.pointerId === state.drag.id) {
      const dx = e.clientX - state.drag.x;
      if (Math.abs(dx) >= 6) state.drag.moved = true;
      if (!state.drag.moved) return;
      const { iw } = geometry();
      pan(state.drag.offset + dx / iw * span() - state.offset);
      return;
    }
    if (!state.data || e.pointerType !== 'mouse') return;
    if (!isHit(e)) {
      if (state.hoverT != null) { state.hoverT = null; renderHover(); }
      return;
    }
    state.hoverT = timeAt(e);
    renderHover();
  });
  const endDrag = (e) => {
    if (!state.drag || e.pointerId !== state.drag.id) return;
    const tapped = !state.drag.moved;
    state.drag = null;
    // A tap (touch) shows the values at that time.
    if (tapped && state.data) {
      state.hoverT = timeAt(e);
      renderHover();
    } else {
      scheduleRender();
    }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  // Touch: a sideways swipe pans the chart rather than scrolling the page
  // (Safari does not always honour touch-action on SVG elements).
  let touch = null;
  wrap.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, sideways: null } : null;
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (touch.sideways == null && Math.max(Math.abs(dx), Math.abs(dy)) >= 6) touch.sideways = Math.abs(dx) > Math.abs(dy);
    if (touch.sideways) e.preventDefault();
  }, { passive: false });
  wrap.addEventListener('pointerleave', (e) => {
    if (state.drag || e.pointerType !== 'mouse') return;
    state.hoverT = null;
    renderHover();
  });
  // Horizontal scrolling (trackpad, or shift + wheel) pans.
  wrap.addEventListener('wheel', (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!d || !state.data) return;
    e.preventDefault();
    pan(-d / geometry().iw * span());
  }, { passive: false });

  const setW = (w) => {
    w = Math.round(w);
    if (w && w !== state.W) {
      state.W = w;
      if (state.data) renderChart();
    }
  };
  setW(wrap.clientWidth);
  new ResizeObserver(([e]) => setW(e.contentRect.width)).observe(wrap);
}

/**
 * Day / night follows the device's light / dark setting (which phones and
 * computers can switch at sunset). The button overrides it until the device
 * switches next.
 */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const systemTheme = () => (darkQuery.matches ? 'night' : 'day');

function renderTheme () {
  const night = document.documentElement.dataset.theme === 'night';
  $('themeToggle').innerHTML = night
    ? '<svg width="16" height="16" style="fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><g transform="scale(0.6667)"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></g></svg>Day'
    : '<svg width="16" height="16" style="fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><g transform="scale(0.6667)"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></g></svg>Night';
}

function toggleTheme () {
  const theme = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
  document.documentElement.dataset.theme = theme;
  if (theme === systemTheme()) {
    try { localStorage.removeItem('loopk.theme'); } catch { /* private mode */ }
  } else {
    store('theme', JSON.stringify({ theme, system: systemTheme() }));
  }
  renderTheme();
}

/** The device's theme, or one picked by hand since the device last switched. */
function autoTheme () {
  let theme = systemTheme();
  try {
    const o = JSON.parse(localStorage.getItem('loopk.theme'));
    if (o && o.system === theme) theme = o.theme;
    else localStorage.removeItem('loopk.theme');
  } catch { /* none */ }
  document.documentElement.dataset.theme = theme;
  renderTheme();
}

function wireOptions () {
  $('themeToggle').addEventListener('click', toggleTheme);
  darkQuery.addEventListener('change', autoTheme);
  $('ranges').addEventListener('change', (e) => {
    state.hours = parseInt(e.target.value, 10);
    state.hoverT = null;
    store('hours', state.hours);
    clampOffset();
    render();
    ensureLoaded().catch(console.error);
  });
  $('glucoseStyle').addEventListener('change', (e) => {
    state.style = e.target.value;
    store('style', state.style);
    render();
  });
  $('units').addEventListener('change', (e) => {
    state.units = e.target.value;
    store('units', state.units);
    render();
  });
  $('showProfile').addEventListener('change', (e) => {
    state.showProfile = e.target.checked;
    store('profile', state.showProfile ? 1 : 0);
    $('legProfile').hidden = !state.showProfile;
    render();
  });
  $('earlier').addEventListener('click', () => pan(span() / 2));
  $('later').addEventListener('click', () => pan(-span() / 2));
  $('toNow').addEventListener('click', () => pan(-state.offset));
}

async function main () {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const session = await res.json();
  $('adminLink').hidden = !session.isAdmin;
  $('signOut').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });

  autoTheme();
  renderOptions();
  wireOptions();
  wireChart();

  try {
    const [first] = await Promise.all([
      api('/api/v3/entries?type=sgv&sort=date&limit=1&fields=date').catch(() => []),
      loadRecent(),
    ]);
    if (first[0]) state.earliest = docTime(first[0]);
  } catch (err) {
    console.error(err);
    $('chartWrap').innerHTML = '<div class="chart-empty">Could not load data.</div>';
    return;
  }
  renderOptions();
  render();
  ensureLoaded().catch(console.error);

  // Live updates over the storage socket; a periodic reload keeps the window sliding.
  let pending = null;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => loadRecent().catch(console.error), 500);
  };
  if (window.io) {
    const socket = window.io('/storage', { withCredentials: true });
    socket.on('connect', () => socket.emit('subscribe', { collections: ['entries', 'treatments', 'devicestatus', 'profile', 'heartrate'] }, () => {}));
    for (const ev of ['create', 'update', 'delete']) socket.on(ev, reload);
  }
  setInterval(reload, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
}

main();
