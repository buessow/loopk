import { buildModel, docTime, glucoseSeries, gmiFromMmol, insulinPerDay, timeInRanges, trendDirection, MIN, HOUR, DAY, MGDL_PER_MMOL } from './model.js';
import { setupTheme } from './theme.js';
import { renderMarkdown } from './markdown.js';
import { extractAnnotations } from './annotations.js';
import { CURVES, algorithmName, algorithmPeriods, curvePoints, loopRuns, splitReason } from './loopruns.js';
import { applyChanges, cacheAvailable, cacheRange, cachedRange, cachedValue, clearCache, cursorFor, saveCursor, saveValue, useCacheFor } from './browser-cache.js';

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
const DEVICESTATUS_FIELDS = 'identifier,date,srvModified,openaps,loop';

// The longest period Claude reviews (src/analysis/context.js, MAX_WINDOW).
const MAX_SELECTION = 12 * HOUR;
const MIN_SELECTION = 10 * MIN;

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
  cacheWarmed: false, // first render loads only its visible time range
  hours: stored('hours', (v) => RANGES.includes(+v), 24, Number),
  units: stored('units', (v) => UNITS.includes(v), null),
  style: stored('style', (v) => STYLES.includes(v), 'boxes'),
  showProfile: stored('profile', (v) => v === '0' || v === '1', true, (v) => v === '1'),
  showForecast: stored('forecast', (v) => v === '0' || v === '1', false, (v) => v === '1'),
  showLoop: stored('loop', (v) => v === '0' || v === '1', false, (v) => v === '1'),
  offset: 0, // ms the window is panned back from the anchor
  W: 1200,
  hoverT: null,
  drag: null,
  selecting: false, // "Ask Claude" is on: a drag selects instead of panning
  selection: null, // { from, to } (ms) for Claude to review
  selDrag: null,
  annotations: [], // Claude's marks on the chart: [{ n, from, to, kind, text }]
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
  const cached = await cachedRange(col, field, from, to).catch(() => null);
  if (cached) return cached;

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
  const result = [...docs.values()];
  // IndexedDB is an optional progressive enhancement: a full/quota-restricted
  // cache must never prevent the dashboard from loading from the API.
  await cacheRange(col, result, from, to).catch(() => {});
  return result;
}

/**
 * Recorded predictions for [from, to) (to null: up to the newest, which
 * lies ahead of now), in requests of at most 30 days. Optional: [] on errors.
 */
async function fetchPredictions (from, to) {
  const end = to ?? Date.now() + HOUR;
  const out = [];
  try {
    for (let t = from; t < end; t += 30 * DAY) {
      out.push(...await api(`/api/prediction/history?from=${Math.round(t)}&to=${Math.round(Math.min(end, t + 30 * DAY))}`));
    }
  } catch {
    return [];
  }
  return out;
}

/** Entries, treatments, device status, heart rate and recorded predictions in [from, to). */
async function fetchSeries (from, to) {
  const [entries, treatments, devicestatus, heartrate, predictions] = await Promise.all([
    fetchRange('entries', 'date', from, to, '&type=sgv&fields=identifier,date,srvModified,sgv,direction,type,device'),
    fetchRange('treatments', 'created_at', from, to, '&fields=' + TREATMENT_FIELDS),
    fetchRange('devicestatus', 'date', from, to, '&fields=' + DEVICESTATUS_FIELDS).catch(() => []),
    fetchRange('heartrate', 'date', from, to, '&fields=identifier,date,srvModified,beatsPerMinute').catch(() => []),
    fetchPredictions(from, to),
  ]);
  return { entries, treatments, devicestatus, heartrate, predictions };
}

// Collections kept in the browser cache; the chart also keeps predictions.
const SERIES = ['entries', 'treatments', 'devicestatus', 'heartrate'];
const WINDOW_SERIES = [...SERIES, 'predictions'];

/** Applies only API changes newer than the cursor saved in this browser. */
async function syncCollection (collection) {
  let cursor = await cursorFor(collection);
  if (cursor == null) return false;
  let changed = false;
  for (;;) {
    const docs = await api(`/api/v3/${collection}/history/${cursor}?limit=${PAGE}`);
    if (!docs.length) return changed;
    await applyChanges(collection, docs);
    changed = true;
    const newest = Math.max(...docs.map((doc) => typeof doc.srvModified === 'number' ? doc.srvModified : 0));
    const full = docs.length >= PAGE;
    // The cursor form is exclusive. Step back one millisecond at a page
    // boundary so records sharing the newest timestamp are not skipped.
    const next = !full || newest - 1 <= cursor ? newest : newest - 1;
    if (next > cursor) {
      cursor = next;
      await saveCursor(collection, cursor);
    }
    if (!full) return changed;
  }
}

let cacheSyncing = null;

/**
 * Initializes a new browser cache at the current server cursors, or catches
 * an existing cache up through API history. The initial page load has already
 * fetched its visible interval; every later visit asks only for changes.
 */
function syncBrowserCache () {
  if (cacheSyncing) return cacheSyncing;
  cacheSyncing = (async () => {
    if (!(await cacheAvailable())) return false;
    const cursors = await Promise.all(SERIES.map(cursorFor));
    if (cursors.some((cursor) => cursor == null)) {
      const latest = await api('/api/v3/lastModified');
      await Promise.all(SERIES.map((collection) => saveCursor(collection, latest.collections?.[collection] ?? 0)));
      return false;
    }
    const changed = await Promise.all(SERIES.map(syncCollection));
    return changed.some(Boolean);
  })().catch((err) => {
    console.warn('Browser cache sync failed:', err);
    return false;
  }).finally(() => { cacheSyncing = null; });
  return cacheSyncing;
}

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
async function loadRecent ({ refreshCache = true } = {}) {
  const now = Date.now();
  const from = now - RECENT;
  const [series, devicestatus, profiles, switchesBefore, lastEntry, prediction] = await Promise.all([
    fetchSeries(from, null),
    api('/api/v3/devicestatus?sort$desc=created_at&limit=3'),
    api('/api/v3/profile?sort$desc=date&limit=1'),
    fetchSwitchBefore(from),
    api('/api/v3/entries?type=sgv&sort$desc=date&limit=1&fields=identifier,date,srvModified,sgv,direction,type,device'),
    // Optional: the page works without it.
    api('/api/prediction').catch(() => null),
  ]);
  state.recent = { ...series, devicestatus, profile: profiles[0], switchesBefore, lastEntry: lastEntry[0], prediction };
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
    for (const k of WINDOW_SERIES) state.win[k] = merge(state.win[k], series[k], older);
    state.loadedFrom = Math.min(state.loadedFrom, from);
  }
  rebuild();
  ensureLoaded().catch(console.error);
  if (refreshCache) {
    syncBrowserCache().then((changed) => {
      // Redraw from IndexedDB after the incremental history requests finish;
      // this performs no range request because that interval is cached.
      if (changed) loadRecent({ refreshCache: false }).catch(console.error);
    });
  }
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
    for (const k of WINDOW_SERIES) state.win[k] = merge(state.win[k], series[k]);
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
  const margin = state.cacheWarmed ? CACHE_MARGIN : 0;
  // The insulin/day tile covers a trailing whole number of days, which can
  // begin before a short visible chart window.
  const insulinFrom = t1 - Math.ceil(span() / DAY) * DAY;
  return {
    from: Math.max(earliest(), Math.min(t0 - margin, insulinFrom)),
    to: Math.min(state.anchor, t1 + margin),
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
  for (const k of WINDOW_SERIES) {
    const filtered = w[k].filter(inside);
    if (filtered.length !== w[k].length) changed = true;
    w[k] = filtered;
  }
  return changed;
}

function rebuild () {
  const { recent, win } = state;
  state.data = buildModel({
    ...win, profile: recent.profile,
    start: state.loadedFrom, now: state.loadedTo ?? state.anchor,
  });
  // What the loop decided at each run, for the loop overlay.
  state.data.loop = loopRuns(win.devicestatus || []);
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

/**
 * Shows [from, to] with some room around it: the shortest range that holds
 * it, centred on it. The range picked here is not remembered as a preference.
 */
function zoomTo (from, to) {
  const needed = (to - from) * 1.2 + 30 * MIN;
  const hours = RANGES.find((h) => h * HOUR >= needed) ?? RANGES[RANGES.length - 1];
  if (hours !== state.hours) {
    state.hours = hours;
    renderSeg('ranges', RANGES, state.hours, rangeLabel);
  }
  state.offset = state.anchor - ((from + to) / 2 + span() / 2);
  clampOffset();
  state.hoverT = null;
  render();
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

/** Predicted glucose for the reading shown, while it is current (GET /api/prediction). */
function renderForecast (last, stale) {
  const el = $('forecast');
  const pastEl = $('forecastPast');
  const p = state.recent.prediction;
  if (stale || !last || !p?.available || Math.abs(p.date - last.t) > MIN) {
    el.hidden = true;
    pastEl.hidden = true;
    return;
  }
  const v = (sgv) => fmt(sgv / MGDL_PER_MMOL);
  el.hidden = false;
  el.innerHTML = 'Predicted ' + p.predictions.map((x) => `${x.minutes} min <b>${v(x.sgv)}</b>`).join(' · ')
    + (p.lowWarning ? ' <span class="tag tag-warn">Low likely within 30 min</span>' : '');
  el.title = 'From the last 2 h of glucose and the time of day. 80% range: '
    + p.predictions.map((x) => `${x.minutes} min ${v(x.low)}–${v(x.high)}`).join(', ')
    + `. Chance of a low within 30 min: ${Math.round(p.lowProbability30 * 100)}%.`;

  // What was predicted for now, and how far off it was.
  const past = p.past || [];
  pastEl.hidden = !past.length;
  const pct = (e) => `${e > 0 ? '+' : e < 0 ? '−' : '±'}${Math.abs(Math.round(e))}%`;
  pastEl.innerHTML = 'Predicted ' + past.map((x) => `${x.minutes} min ago <b>${v(x.sgv)}</b> (${pct(x.errorPercent)})`).join(' · ');
  pastEl.title = past.map((x) => `${x.minutes} min ago (${hm(x.madeAt)}), the model predicted ${v(x.sgv)} for now; `
    + `actual ${v(x.actual)}, error ${pct(x.errorPercent)}`).join('. ') + '.';
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
    $('forecast').hidden = true;
    $('forecastPast').hidden = true;
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
    renderForecast(last, stale);
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
  const insulinDays = Math.ceil(span() / DAY);
  const insulinFrom = t1 - insulinDays * DAY;
  const insulin = state.loadedFrom <= insulinFrom
    ? insulinPerDay({ start: t0, end: t1, basal: state.data.basal, events: state.data.events })
    : null;
  $('insulinPerDay').textContent = insulin ? insulin.perDay.toFixed(1) : '–';
  $('insulinNote').textContent = insulin
    ? `Basal ${insulin.basalUnits.toFixed(1)} · bolus ${insulin.bolusUnits.toFixed(1)} · ${insulin.days} ${insulin.days === 1 ? 'day' : 'days'}`
    : `Loading ${insulinDays} ${insulinDays === 1 ? 'day' : 'days'}…`;
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
  const Ln = { bT: 22, bH: 56, cT: 92, cH: 50, eT: 154, eH: 48, gT: 214, gH: 330, hT: 574, hH: 110 };
  const axis = Ln.hT + Ln.hH + 8;
  const GMIN = 2;
  const GMAX = 20;
  const HMIN = 40;
  const HMAX = 170;
  const CMAX = Math.max(20, ...D.cobSeries.map((p) => p.v * 1.1));
  const visible = D.basal.filter((s) => s.t1 > t0 && s.t0 < t1);
  const BMAX = Math.max(2.4, ...visible.map((s) => Math.max(s.rate, state.showProfile ? s.prof : 0) * 1.1));
  // Long ranges draw every k-th 5-minute reading (about 400 at most).
  const k = Math.max(1, Math.ceil(state.hours * 12 / 400));
  return {
    W, H: axis + 26, narrow, padL, padR, iw, plotR, t0, t1, Ln, axis, BMAX, CMAX, k,
    X: (t) => padL + (t - t0) / (t1 - t0) * iw,
    GY: (v) => Ln.gT + (1 - (Math.min(GMAX, Math.max(GMIN, v)) - GMIN) / (GMAX - GMIN)) * Ln.gH,
    BY: (v) => Ln.bT + Ln.bH - Math.min(v, BMAX) / BMAX * Ln.bH,
    CY: (v) => Ln.cT + Ln.cH - Math.min(v, CMAX) / CMAX * Ln.cH,
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

// Recorded predictions in the glucose lane: what was predicted for each
// moment 15 and 30 minutes before it.
const FORECAST_LINES = [
  [15, 'stroke:var(--color-accent-2-600);stroke-width:1.5;stroke-dasharray:6 3'],
  [30, 'stroke:var(--color-accent-2-500);stroke-width:1.75;stroke-dasharray:2 3'],
];

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

// --- loop overlay: what AAPS's algorithm did at each run -------------------

const LOOP_COLOR = { SMB: 'var(--color-neutral-600)', 'SMB + DynISF': 'var(--color-accent-600)', AUTO_ISF: 'var(--color-accent-2-600)' };
const loopColor = (name) => LOOP_COLOR[name] || 'var(--color-neutral-600)';
const LOOP_STRIP = 12;
const CURVE_COLOR = { IOB: 'var(--color-accent-600)', ZT: 'var(--color-neutral-500)', UAM: 'var(--color-accent-2-600)', COB: 'var(--color-accent-900)' };

/**
 * The algorithm of the runs as a strip along the top of the glucose lane,
 * the target each run used (dotted steps) and the eventual glucose it
 * expected (open dots; above the lane, a small triangle under the strip).
 */
function loopOverlay ({ X, GY, Ln, t0, t1, k, padL, plotR }) {
  const runs = state.data.loop.filter((r) => r.t >= t0 - HOUR && r.t <= t1);
  const out = [];
  for (const p of algorithmPeriods(runs)) {
    const x0 = Math.max(padL, X(p.from));
    const x1 = Math.min(plotR, X(p.to));
    if (x1 <= x0) continue;
    out.push(`<rect x="${f1(x0)}" y="${Ln.gT}" width="${f1(x1 - x0)}" height="${LOOP_STRIP}" style="fill:${loopColor(p.name)}"><title>${esc(p.name)}</title></rect>`);
    if (x1 - x0 > 80) out.push(`<text x="${f1(x0 + 4)}" y="${Ln.gT + 9.5}" style="fill:var(--color-bg);font-family:var(--font-body);font-size:9px;font-weight:600;letter-spacing:0.06em;pointer-events:none">${esc(p.name)}</text>`);
  }
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
  out.push(`<path d="${target.trim()}" style="fill:none;stroke:var(--color-accent-900);stroke-width:1.25;stroke-dasharray:1 3;stroke-linecap:round"></path>`);
  const eventual = sampled(runs.filter((r) => r.eventual != null).map((r) => ({ t: r.t, v: r.eventual })), t0, t1, k);
  for (const p of eventual) {
    const x = f1(X(p.t));
    const y = GY(p.v);
    out.push(y < Ln.gT + LOOP_STRIP + 6
      ? `<path d="M${x} ${Ln.gT + LOOP_STRIP + 3} l-3 5 h6 Z" style="fill:var(--color-accent-2-700)"></path>`
      : `<circle cx="${x}" cy="${f1(y)}" r="2.4" style="fill:var(--color-bg);stroke:var(--color-accent-2-700);stroke-width:1.25"></circle>`);
  }
  return out.join('');
}

/** The curves a run predicted, from the run onwards, each labelled at its end. */
function loopCurves (run, { X, GY, t1 }) {
  return CURVES.map((c) => {
    const pts = curvePoints(run, c).filter((p) => p.t <= t1);
    if (pts.length < 2) return '';
    const end = pts[pts.length - 1];
    return `<path d="${linePath(pts, X, GY, 10 * MIN)}" style="fill:none;stroke:${CURVE_COLOR[c]};stroke-width:1.5;stroke-dasharray:5 3"></path>`
      + `<text x="${f1(X(end.t) + 4)}" y="${f1(GY(end.v) + 4)}" style="fill:${CURVE_COLOR[c]};font-family:var(--font-body);font-size:10px;font-weight:600;paint-order:stroke;stroke:var(--color-bg);stroke-width:3px">${c}</text>`;
  }).join('');
}

/** The hover rows of a loop run: algorithm, the values it decided on, the result. */
function loopRows (r) {
  const row = (name, value) => `<span style="color:var(--color-neutral-700)">${name}</span><span>${value}</span>`;
  const g = (v) => (v == null ? '–' : fmt(v));
  const { values, decision } = splitReason(r.reason);
  const preds = values.filter(([n]) => /^(Dev|BGI|minPredBG|minGuardBG|IOBpredBG|COBpredBG|UAMpredBG)$/.test(n));
  const result = [
    r.rate != null ? `temp ${r.rate.toFixed(2)} U/h${r.duration ? ` for ${Math.round(r.duration)} min` : ''}` : null,
    r.smb > 0 ? `SMB ${r.smb} U${r.smbGiven != null && r.smbGiven !== r.smb ? ` (given ${r.smbGiven} U)` : ''}` : null,
  ].filter(Boolean).join(', ') || 'no change';
  return `<div style="grid-column:span 2;border-top:1px solid var(--color-divider);margin-top:2px;padding-top:4px;font-weight:600">Loop at ${hm(r.t)} · ${esc(algorithmName(r))}</div>`
    + row('Glucose → eventual', `${g(r.bg)} → ${g(r.eventual)}`)
    + row('Target', g(r.target))
    + row('ISF used', r.isf == null ? '–' : `${g(r.isf)} per U`)
    + row('Sensitivity ratio', r.sensitivityRatio == null ? '–' : r.sensitivityRatio.toFixed(2))
    + row('IOB · COB', `${r.iob == null ? '–' : r.iob.toFixed(2) + ' U'} · ${r.cob == null ? '–' : Math.round(r.cob) + ' g'}`)
    // AAPS's insulinReq: what its prediction (which counts IOB) says is still missing.
    + row('Extra insulin needed<br><span style="font-size:11px">on top of IOB</span>', r.insulinReq == null ? '–' : r.insulinReq.toFixed(2) + ' U')
    + (preds.length ? `<span style="grid-column:span 2;color:var(--color-neutral-700);font-size:11px">From its reason: ${esc(preds.map(([n, v]) => `${n} ${v}`).join(' · '))}</span>` : '')
    + `<span style="grid-column:span 2">${r.enacted ? 'Set' : 'Suggested'}: <b>${esc(result)}</b></span>`
    + (decision ? `<span style="grid-column:span 2;color:var(--color-neutral-700);font-size:11px">${esc(decision)}</span>` : '');
}

function renderChart () {
  const D = state.data;
  const geo = geometry();
  const { W, H, narrow, padL, plotR, iw, t0, t1, Ln, axis, X, GY, BY, CY, HY, BMAX, CMAX, k } = geo;
  const longRange = state.hours > 48;
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
  for (const v of [6, 8, 14, 18]) {
    push(`<line x1="${padL}" x2="${plotR}" y1="${f1(GY(v))}" y2="${f1(GY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  }
  for (const v of bTicks.filter((v) => v > 0)) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(BY(v))}" y2="${f1(BY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  for (const v of cobTicks.filter((v) => v > 0)) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(CY(v))}" y2="${f1(CY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  for (const v of [60, 100, 140]) push(`<line x1="${padL}" x2="${plotR}" y1="${f1(HY(v))}" y2="${f1(HY(v))}" style="stroke:var(--color-divider);stroke-dasharray:2 4"></line>`);
  const base = Ln.bT + Ln.bH;
  for (const y of [base, Ln.cT + Ln.cH, gBot, Ln.hT + Ln.hH, axis]) push(`<line x1="${padL}" x2="${plotR}" y1="${y}" y2="${y}" style="stroke:var(--color-divider)"></line>`);

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

  // Carbs on board reported by the loop at each device-status update.
  const cob = sampled(D.cobSeries, t0, t1, k);
  push(`<path d="${linePath(cob, X, CY, Math.max(20, 10 * k) * MIN)}" style="fill:none;stroke:var(--color-accent-600);stroke-width:1.5;stroke-linejoin:round"></path>`);

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
  if (state.showForecast) {
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

  if (state.showLoop) push(loopOverlay(geo));

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
  for (const v of cobTicks) text(yx, f1(CY(v)), String(v), ys);
  for (const v of [60, 80, 100, 120, 140, 160]) text(yx, f1(HY(v)), String(v), ys);
  const laneStyle = 'fill:var(--color-accent-700);font-size:10px;letter-spacing:0.1em';
  text(padL + 4, Ln.bT - 8, 'BASAL · U/H' + (narrow ? '' : ' · FILL = DELIVERED' + (state.showProfile ? ', DASHED = PROFILE' : '')), laneStyle);
  text(padL + 4, Ln.cT - 8, 'CARBS ON BOARD · G', laneStyle);
  text(padL + 4, Ln.eT - 2, 'BOLUS (U) · CARBS (G)', laneStyle);
  text(padL + 4, Ln.gT - 6, 'GLUCOSE · ' + unit().toUpperCase(), laneStyle);
  text(padL + 4, Ln.hT - 6, 'HEART RATE · BPM', laneStyle);
  for (const [x, y, s, st] of labels) text(x, y, s, st);
  for (const [s, y] of narrow ? [] : [['U/h', Ln.bT + Ln.bH / 2], ['g', Ln.cT + Ln.cH / 2], [unit(), Ln.gT + Ln.gH / 2], ['bpm', Ln.hT + Ln.hH / 2]]) {
    push(`<text x="0" y="0" transform="translate(${W - 10} ${y}) rotate(90)" style="text-anchor:middle;font-family:var(--font-body);font-size:10px;letter-spacing:0.08em;fill:var(--color-accent-700)">${esc(s)}</text>`);
  }

  push('<g id="ann"></g>');
  push('<g id="sel"></g>');
  push('<g id="hov"></g>');
  push(`<rect class="hit${state.drag ? ' dragging' : ''}" id="hit" x="${padL}" y="0" width="${iw}" height="${H}"></rect>`);

  $('chartWrap').innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Glucose, basal, events and heart rate">${out.join('')}</svg>`;
  renderSelection();
  renderAnnotations();
  renderHover();
}

// Claude's marks: blue where it found too much insulin (heading low), red too little.
const MARK_COLOR = { over: 'var(--bg-low)', under: 'var(--bg-high)', ok: 'var(--bg-ok)', note: 'var(--color-neutral-700)' };
const MARK_LABEL = { over: 'Too much', under: 'Too little', ok: 'Good', note: 'Note' };

/** Claude's marks: a dashed line and a numbered badge at each time, a band over each period. */
function renderAnnotations () {
  const g = $('ann');
  if (!g) return;
  const { X, Ln, axis, padL, plotR, t0, t1 } = geometry();
  let lastX = -Infinity;
  let row = 0;
  g.innerHTML = state.annotations.filter((a) => a.to >= t0 && a.from <= t1).map((a) => {
    const c = MARK_COLOR[a.kind];
    const x0 = Math.max(padL, X(a.from));
    const x1 = Math.min(plotR, X(a.to));
    // Badges close together stack downwards.
    row = x0 - lastX < 22 ? row + 1 : 0;
    lastX = x0;
    const y = Ln.gT + 14 + row * 22;
    return (x1 > x0 ? `<rect x="${f1(x0)}" y="${Ln.gT}" width="${f1(x1 - x0)}" height="${Ln.gH}" style="fill:color-mix(in srgb,${c} 12%,transparent)"></rect>` : '')
      + `<line x1="${f1(x0)}" x2="${f1(x0)}" y1="${Ln.bT}" y2="${axis}" style="stroke:${c};stroke-width:1.25;stroke-dasharray:4 3"></line>`
      + `<circle cx="${f1(x0)}" cy="${y}" r="9" style="fill:${c};stroke:var(--color-bg);stroke-width:1.5"></circle>`
      + `<text x="${f1(x0)}" y="${y + 4}" style="fill:var(--color-bg);font-family:var(--font-body);font-size:11px;font-weight:600;text-anchor:middle">${a.n}</text>`;
  }).join('');
}

/** The period selected for Claude: a shaded band with an edge at each end in view. */
function renderSelection () {
  const g = $('sel');
  if (!g) return;
  const s = state.selection;
  const { X, Ln, axis, padL, plotR } = geometry();
  const x0 = s && Math.max(padL, X(s.from));
  const x1 = s && Math.min(plotR, X(s.to));
  if (!s || x1 <= x0) {
    g.innerHTML = '';
    return;
  }
  const edge = (x) => (x >= padL && x <= plotR ? `<line x1="${f1(x)}" x2="${f1(x)}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-accent);stroke-width:1.5"></line>` : '');
  g.innerHTML = `<rect x="${f1(x0)}" y="${Ln.bT}" width="${f1(x1 - x0)}" height="${axis - Ln.bT}" style="fill:color-mix(in srgb,var(--color-accent) 14%,transparent)"></rect>`
    + edge(X(s.from)) + edge(X(s.to));
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
  const cob = nearest(D.cobSeries.filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const h = nearest(D.hr.filter((q) => Math.abs(q.t - t) <= 10 * MIN), t, 10 * MIN);
  const predicted = state.showForecast
    ? FORECAST_LINES.map(([m]) => [m, nearest((D.forecast[m] || []).filter((q) => Math.abs(q.t - t) <= 5 * MIN), t, 5 * MIN)])
    : [];
  const marks = state.annotations.filter((a) => t >= a.from - 5 * MIN * k && t <= a.to + 5 * MIN * k);
  // The loop run nearest the pointer, with what it predicted.
  const run = state.showLoop ? nearest(D.loop.filter((r) => Math.abs(r.t - t) <= Math.max(6, 5 * k) * MIN), t, Math.max(6, 5 * k) * MIN) : null;
  // Wider with the loop, the prediction rows or Claude's marks, so their labels fit.
  const boxW = run ? 300 : marks.length ? 260 : predicted.length ? 216 : 180;
  // With a loop run, on the left: its predicted curves run to the right.
  const onLeft = run ? x > boxW + 40 : x > W - boxW - 40;
  const left = Math.round(onLeft ? x - boxW - 14 : x + 14);
  const time = state.hours > 24 || state.offset > 0 ? dayHm(t) : hm(t);
  g.innerHTML = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${Ln.bT}" y2="${axis}" style="stroke:var(--color-text);stroke-width:1"></line>`
    + (p ? `<circle cx="${f1(x)}" cy="${f1(GY(p.v))}" r="5" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (h ? `<circle cx="${f1(x)}" cy="${f1(HY(h.v))}" r="4" style="fill:none;stroke:var(--color-text);stroke-width:1.5"></circle>` : '')
    + (run ? loopCurves(run, { X, GY, t1 }) : '')
    // With a loop run the window is long: it starts at the top of the chart.
    + `<foreignObject x="${left}" y="${run ? Ln.bT : Ln.gT}" width="${boxW + 16}" height="${140 + 20 * predicted.length + 40 * marks.length + (run ? 300 : 0)}" style="pointer-events:none"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${boxW}px;margin:4px;background:var(--color-bg);border:1px solid var(--color-text);box-shadow:var(--shadow-md);padding:var(--space-2) var(--space-3);display:grid;grid-template-columns:1fr auto;gap:2px var(--space-3);font-size:12px">`
    + `<div style="grid-column:span 2;font-family:var(--font-heading);font-weight:600;font-size:15px">${time}</div>`
    + `<span style="color:var(--color-neutral-700)">Glucose</span><span>${p ? fmt(p.v) + ' ' + unit() : '–'}</span>`
    + predicted.map(([m, q]) => `<span style="color:var(--color-neutral-700)">Predicted ${m} min ago</span><span>${q ? fmt(q.v) : '–'}</span>`).join('')
    + `<span style="color:var(--color-neutral-700)">Basal</span><span>${sg ? sg.rate.toFixed(2) + ' U/h' : '–'}</span>`
    + (state.showProfile ? `<span style="color:var(--color-neutral-700)">Profile</span><span>${sg ? sg.prof.toFixed(2) + ' U/h' : '–'}</span>` : '')
    + `<span style="color:var(--color-neutral-700)">COB</span><span>${cob ? Math.round(cob.v) + ' g' : '–'}</span>`
    + `<span style="color:var(--color-neutral-700)">Heart rate</span><span>${h ? h.v + ' bpm' : '–'}</span>`
    + (run ? loopRows(run) : '')
    + marks.map((a) => `<span style="grid-column:span 2;border-top:1px solid var(--color-divider);padding-top:2px"><b style="color:${MARK_COLOR[a.kind]}">(${a.n}) ${MARK_LABEL[a.kind]}</b> ${esc(a.text)}</span>`).join('')
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
  $('showForecast').checked = state.showForecast;
  $('legForecast').hidden = !state.showForecast;
  $('showLoop').checked = state.showLoop;
  $('legLoop').hidden = !state.showLoop;
}

function render () {
  if (!state.data) return;
  renderUnits();
  renderTitle();
  renderStats();
  renderChart();
}

// --- review by Claude ---------------------------------------------------

let reviewing = null; // AbortController of the review being streamed

/** "Thu 22 · 14:05 – 17:30 · 3 h 25 min" */
function selectionLabel ({ from, to }) {
  const m = Math.round((to - from) / MIN);
  const length = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  return `${dayHm(from)} – ${sameDay ? hm(to) : dayHm(to)} · ${length}`;
}

function showAnalysis () {
  const panel = $('analysis');
  if (!panel.hidden) return;
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateAnalysis () {
  const s = state.selection;
  $('analysisRange').textContent = s ? selectionLabel(s) : 'No period selected';
  $('analysisRun').disabled = !s && !reviewing;
  $('analysisRun').textContent = reviewing ? 'Stop' : review.conversation.length ? 'New review' : 'Review with Claude';
  $('analysisAskButton').disabled = !!reviewing;
  $('askClaude').setAttribute('aria-pressed', String(state.selecting));
  $('chartWrap').classList.toggle('selecting', state.selecting);
}

// The review being discussed: the first request ({ from, to, tz, question })
// and the answers and follow-up questions since ([{ role, text }]).
const review = { request: null, conversation: [] };

/** The answers and questions so far; the annotations blocks are on the chart instead. */
function renderThread () {
  const near = review.request?.from ?? Date.now();
  $('analysisResult').innerHTML = review.conversation.map((turn) => (turn.role === 'user'
    ? `<div class="analysis-question">${esc(turn.text)}</div>`
    : `<div class="analysis-answer">${renderMarkdown(extractAnnotations(turn.text, near).markdown)}</div>`)).join('');
  $('analysisFollow').hidden = !review.conversation.some((turn) => turn.role === 'assistant');
}

/**
 * Asks Claude: the first review of the selection (no question) or a
 * follow-up question about it. Streams the answer into the thread; while
 * it runs, "Review with Claude" stops it.
 */
async function askClaude (question = null) {
  if (reviewing) return;
  if (question == null) {
    const s = state.selection;
    if (!s) return;
    review.request = { from: Math.round(s.from), to: Math.round(s.to), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, units: unit(), question: $('analysisNote').value };
    review.conversation = [];
    setAnnotations([]);
  } else {
    review.conversation.push({ role: 'user', text: question });
  }
  const sent = review.conversation.length ? [...review.conversation] : undefined;
  const answer = { role: 'assistant', text: '' };
  review.conversation.push(answer);
  const ctl = new AbortController();
  reviewing = ctl;
  const status = (text) => { $('analysisStatus').textContent = text; };
  status(question == null ? 'Claude is reading the records… a review takes a minute or two.' : 'Claude is thinking…');
  renderThread();
  updateAnalysis();
  try {
    const res = await fetch('/api/analysis', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...review.request, conversation: sent }),
      signal: ctl.signal,
    });
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.description || `error ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      answer.text += decoder.decode(value, { stream: true });
      // A follow-up only replaces the marks when it lists them again.
      const { annotations } = extractAnnotations(answer.text, review.request.from);
      if (annotations.length && annotations.length !== state.annotations.length) {
        setAnnotations(annotations);
        // Show the reviewed period and everything Claude marked.
        zoomTo(Math.min(review.request.from, ...annotations.map((a) => a.from)), Math.max(review.request.to, ...annotations.map((a) => a.to)));
      }
      renderThread();
      status('Claude is writing…');
    }
    status(`About ${selectionLabel(review.request)}. Claude can be wrong: check it against the chart.`);
  } catch (err) {
    status(ctl.signal.aborted ? 'Stopped.' : `No answer: ${err.message}`);
  } finally {
    // Without an answer, the question goes back into the box to ask again.
    if (!answer.text.trim()) {
      review.conversation.pop();
      if (question != null) {
        review.conversation.pop();
        if (!$('analysisAsk').value) $('analysisAsk').value = question;
      }
    }
    reviewing = null;
    renderThread();
    updateAnalysis();
  }
}

/** Shows Claude's marks on the chart and lists them in the panel. */
function setAnnotations (annotations) {
  state.annotations = annotations;
  renderAnnotations();
  $('analysisMarks').innerHTML = annotations.map((a) => `<li><button type="button" class="analysis-mark" data-mark="${a.n}">`
    + `<span class="analysis-mark-n" style="background:${MARK_COLOR[a.kind]}">${a.n}</span>`
    + `<span class="analysis-mark-time">${hm(a.from)}${a.to > a.from ? '–' + hm(a.to) : ''}</span>`
    + `<b style="color:${MARK_COLOR[a.kind]}">${MARK_LABEL[a.kind]}</b> <span>${esc(a.text)}</span></button></li>`).join('');
}

function wireAnalysis () {
  // A mark in the list zooms the chart to it.
  $('analysisMarks').addEventListener('click', (e) => {
    const a = state.annotations.find((x) => String(x.n) === e.target.closest('[data-mark]')?.dataset.mark);
    if (!a) return;
    // The mark with an hour either side.
    zoomTo(a.from - HOUR, a.to + HOUR);
    $('chartWrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('askClaude').addEventListener('click', () => {
    state.selecting = !state.selecting;
    if (state.selecting) showAnalysis();
    updateAnalysis();
  });
  $('analysisClose').addEventListener('click', () => {
    reviewing?.abort();
    state.selecting = false;
    state.selection = null;
    review.request = null;
    review.conversation = [];
    renderThread();
    setAnnotations([]);
    $('analysis').hidden = true;
    renderSelection();
    updateAnalysis();
  });
  $('analysisRun').addEventListener('click', () => (reviewing ? reviewing.abort() : askClaude()));
  // Follow-up questions; Enter sends, shift + Enter starts a new line.
  const follow = () => {
    const q = $('analysisAsk').value.trim();
    if (!q || reviewing) return;
    $('analysisAsk').value = '';
    askClaude(q);
  };
  $('analysisFollow').addEventListener('submit', (e) => {
    e.preventDefault();
    follow();
  });
  $('analysisAsk').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      follow();
    }
  });
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
    // "Ask Claude" on, or shift held: the drag selects a period.
    if (state.selecting || e.shiftKey) {
      const t = Math.min(Date.now(), timeAt(e));
      state.selDrag = { id: e.pointerId, t };
      state.selection = { from: t, to: t };
      wrap.setPointerCapture(e.pointerId);
      renderSelection();
      return;
    }
    state.drag = { x: e.clientX, offset: state.offset, id: e.pointerId, moved: false };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (state.selDrag && e.pointerId === state.selDrag.id) {
      const a = state.selDrag.t;
      // At most MAX_SELECTION from where the drag started, and not in the future.
      const b = Math.min(Date.now(), Math.max(a - MAX_SELECTION, Math.min(a + MAX_SELECTION, timeAt(e))));
      state.selection = { from: Math.min(a, b), to: Math.max(a, b) };
      renderSelection();
      updateAnalysis();
      return;
    }
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
    if (state.selDrag && e.pointerId === state.selDrag.id) {
      state.selDrag = null;
      const s = state.selection;
      if (s && s.to - s.from < MIN_SELECTION) state.selection = null;
      renderSelection();
      if (state.selection) showAnalysis();
      updateAnalysis();
      return;
    }
    if (!state.drag || e.pointerId !== state.drag.id) return;
    state.drag = null;
    // Touch taps do not open a persistent value popover; values are available
    // through mouse hover on desktop.
    scheduleRender();
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

function wireOptions () {
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
  $('showForecast').addEventListener('change', (e) => {
    state.showForecast = e.target.checked;
    store('forecast', state.showForecast ? 1 : 0);
    $('legForecast').hidden = !state.showForecast;
    render();
  });
  $('earlier').addEventListener('click', () => pan(span() / 2));
  $('later').addEventListener('click', () => pan(-span() / 2));
  $('toNow').addEventListener('click', () => pan(-state.offset));
}

// --- sport mode: a profile percentage and temp target sent to AAPS ---------

// 0: until ended.
const SPORT_DURATIONS = [0, 30, 45, 60, 90, 120, 180, 240];
let sport = null; // GET /api/sport
let sportTimer = null;

function renderSport () {
  const s = sport;
  const on = s.active;
  const c = s.config;
  const target = (mgdl) => `${fmt(mgdl / MGDL_PER_MMOL)} ${unit()}`;
  $('sportWrap').hidden = !s.configured && !on;
  $('sport').setAttribute('aria-pressed', String(on));
  const until = s.until ? `until ${hm(s.until)}` : 'until ended';
  $('sport').textContent = on ? `Sport · ${s.until ? until : 'on'}` : 'Sport';
  $('sportTag').textContent = on ? `On ${until}` : 'Off';
  $('sportTag').className = on ? 'tag tag-accent' : 'tag';
  $('sportText').textContent = on
    ? `AAPS was sent ${s.profile} at ${s.percentage}%${s.target != null ? ` and an Activity temp target of ${target(s.target)}` : ''} ${s.until ? until : 'until you end it'}. Check on the phone that it took them over. Ending goes back to the profile from before.`
    : c
      ? `Switches AAPS to ${c.profile || 'the profile in use'} at ${c.percentage}%${c.target != null ? ` with an Activity temp target of ${target(c.target)}` : ''}, and back when it ends. AAPS applies it when it receives it from this server: check on the phone.`
      : 'Sport mode is not set up: an admin can set it up on the Access page.';
  if (c) {
    const options = SPORT_DURATIONS;
    // No limit unless another duration was picked.
    const chosen = Number($('sportDuration').value) || 0;
    const label = (m) => (!m ? 'No limit' : m < 60 || m % 60 ? m + ' min' : m / 60 + ' h');
    $('sportDuration').innerHTML = options.map((m) => `<option value="${m}"${m === chosen ? ' selected' : ''}>${label(m)}</option>`).join('');
  }
  $('sportDurationField').hidden = on || !c;
  $('sportSwitch').textContent = on ? 'End now' : 'Start';
  $('sportSwitch').disabled = !s.canSwitch || (!on && !c);
  if (!s.canSwitch) $('sportStatus').textContent = s.following ? `This server follows ${s.following}: switch sport mode there.` : 'Only admins can switch sport mode.';
  // Show it ended when it ends.
  clearTimeout(sportTimer);
  if (on && s.until) sportTimer = setTimeout(() => loadSport().catch(console.error), Math.max(0, s.until - Date.now()) + 5000);
}

async function loadSport () {
  sport = await api('/api/sport');
  renderSport();
}

function wireSport () {
  const pop = $('sportPop');
  const show = (open) => {
    pop.hidden = !open;
    $('sport').setAttribute('aria-expanded', String(open));
    if (!open) return;
    // Below the button, kept inside the screen.
    pop.style.right = '0';
    const left = pop.getBoundingClientRect().left;
    if (left < 16) pop.style.right = `${left - 16}px`;
    $('sportStatus').textContent = '';
    loadSport().catch(console.error);
  };
  $('sport').addEventListener('click', () => show(pop.hidden));
  $('sportClose').addEventListener('click', () => show(false));
  document.addEventListener('click', (e) => { if (!pop.hidden && !$('sportWrap').contains(e.target)) show(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      show(false);
      $('sport').focus();
    }
  });
  $('sportSwitch').addEventListener('click', async () => {
    const on = sport.active;
    const button = $('sportSwitch');
    button.disabled = true;
    $('sportStatus').textContent = on ? 'Ending…' : 'Sending to AAPS…';
    try {
      const res = await fetch(`/api/sport/${on ? 'stop' : 'start'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utcOffset: -new Date().getTimezoneOffset(), ...(on ? {} : { duration: Number($('sportDuration').value) }) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `${res.status}`);
      sport = { ...sport, ...body };
      $('sportStatus').textContent = on ? 'Ended: AAPS was sent the profile from before.' : 'Sent: AAPS applies it when it receives it.';
      renderSport();
      loadRecent().catch(console.error);
    } catch (err) {
      $('sportStatus').textContent = err.message;
      button.disabled = false;
    }
  });
}

async function main () {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const session = await res.json();
  await useCacheFor(session.user.email).catch(() => {});
  $('adminLink').hidden = !session.isAdmin;
  // Reviews need an Anthropic API key (Access page).
  $('analysis').hidden = !session.claude;
  state.canReview = !!session.claude;
  // Sport mode, once an admin set it up (Access page).
  if (session.sport) loadSport().catch(console.error);
  $('signOut').addEventListener('click', async () => {
    await clearCache().catch(() => {});
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });

  setupTheme($('themeToggle'));
  renderOptions();
  wireOptions();
  wireChart();
  wireAnalysis();
  wireSport();

  try {
    const [first] = await Promise.all([
      (async () => {
        const cached = await cachedValue('earliest-entry');
        if (cached != null) return cached;
        const [entry] = await api('/api/v3/entries?type=sgv&sort=date&limit=1&fields=date').catch(() => []);
        const earliest = entry ? docTime(entry) : null;
        if (earliest != null) await saveValue('earliest-entry', earliest);
        return earliest;
      })(),
      loadRecent(),
    ]);
    if (first != null) state.earliest = first;
  } catch (err) {
    console.error(err);
    $('chartWrap').innerHTML = '<div class="chart-empty">Could not load data.</div>';
    return;
  }
  renderOptions();
  render();
  ensureLoaded().catch(console.error);
  // Let the selected range paint before filling its 30-day buffers. Nested
  // animation frames ensure at least one browser paint happens first.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    state.cacheWarmed = true;
    ensureLoaded().catch(console.error);
  }));

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
