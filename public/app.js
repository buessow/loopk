import { buildModel, docTime, glucoseSeries, gmiFromMmol, insulinPerDay, timeInRanges, trendDirection, MIN, HOUR, DAY, MGDL_PER_MMOL } from './model.js';
import { setupTheme } from './theme.js';
import { HI, LO, chartSvg, dayHm, esc, f1, geometry as chartGeometry, hm, hoverSvg } from './glucosechart.js';
import { claudeLink, claudePrompt } from './askclaude.js';
import { loopRuns } from './loopruns.js';
import { DEVICESTATUS_FIELDS, PAGE, TREATMENT_FIELDS, api, fetchRange, fetchSwitchBefore } from './documents.js';
import { missNote, missSelection, missSummary } from './misses.js';
import { OVERLAYS, parseView, viewSearch } from './view.js';
import { applyChanges, cacheAvailable, cachedValue, clearCache, cursorFor, saveCursor, saveValue, useCacheFor } from './browser-cache.js';

const $ = (id) => document.getElementById(id);
const RANGES = [3, 6, 12, 24, 48, 168, 720];
const STYLES = ['boxes', 'sticks', 'dots', 'line'];
const UNITS = ['mmol/L', 'mg/dL'];
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

// The longest period to ask Claude about (misses.js has the same).
const MAX_SELECTION = 12 * HOUR;
const MIN_SELECTION = 10 * MIN;
// Periods the loop's misses can be listed for, in days.
const MISS_DAYS = [7, 30, 90];
const MISS_KINDS = { all: 'All', low: 'Lows', high: 'Highs' };

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
  selecting: false, // "Select time range" is on: a drag selects instead of panning
  selection: null, // { from, to } (ms) to ask Claude about
  selDrag: null,
  misses: null, // the loop's misses (misses.js) in the last missDays, newest first
  missDays: stored('missDays', (v) => MISS_DAYS.includes(+v), 30, Number),
  missKind: 'all',
  missShown: null, // start of the miss shown on the chart
  missCopied: null, // { start, ok }: the miss whose AI prompt was just copied
  gesture: false, // a wheel pan is going on: the address is written when it ends
};

// The overlays as the address names them (view.js).
const OVERLAY_STATE = { pred: 'showForecast', basal: 'showProfile', loop: 'showLoop' };
// The view the page was opened with, applied before the remembered settings.
const openedView = parseView(location.search);

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
  writeView();
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
  writeView();
  ensureLoaded().catch(console.error);
}

// --- the view in the address (view.js) ------------------------------------

/**
 * Applies a view from the address: its range, its start (else "now") and
 * its overlays; what it leaves out stays as it is.
 */
function applyView (view) {
  if (view.duration != null) state.hours = view.duration / HOUR;
  if (view.show) for (const o of OVERLAYS) state[OVERLAY_STATE[o]] = view.show.includes(o);
  state.offset = view.start == null ? 0 : Math.max(0, state.anchor - view.start - span());
  clampOffset();
  state.hoverT = null;
}

/** Writes the view to the address, unless a pan gesture is still going on. */
function writeView () {
  if (state.drag || state.gesture) return;
  const { t0 } = windowTimes();
  const search = viewSearch({
    start: state.offset > 0 ? t0 : null,
    duration: span(),
    show: OVERLAYS.filter((o) => state[OVERLAY_STATE[o]]),
  });
  if (search !== location.search) history.replaceState(history.state, '', location.pathname + search + location.hash);
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

/** The chart's options (glucosechart.js) from the page's state. */
function chartOptions () {
  const { t0, t1 } = windowTimes();
  return {
    data: state.data, W: state.W, t0, t1, units: unit(), style: state.style,
    showProfile: state.showProfile, showForecast: state.showForecast, showLoop: state.showLoop,
    withDay: state.hours > 24 || state.offset > 0, runLink: true, drag: state.drag,
  };
}

const geometry = () => chartGeometry(chartOptions());

function renderChart () {
  $('chartWrap').innerHTML = chartSvg(chartOptions());
  renderSelection();
  renderHover();
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

function renderHover () {
  const g = $('hov');
  if (!g) return;
  if (state.hoverT == null) {
    g.innerHTML = '';
    state.hoverRun = null;
    return;
  }
  const { html, run } = hoverSvg(chartOptions(), state.hoverT);
  state.hoverRun = run;
  g.innerHTML = html;
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
  renderMisses();
}

// --- a prompt for Claude ---------------------------------------------------

/** "Thu 22 · 14:05 – 17:30 · 3 h 25 min" */
function selectionLabel ({ from, to }) {
  const m = Math.round((to - from) / MIN);
  const length = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  return `${dayHm(from)} – ${sameDay ? hm(to) : dayHm(to)} · ${length}`;
}

function showAnalysis () {
  const panel = $('analysis');
  if (panel.open) return;
  panel.open = true;
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The panel for the selection: its label, buttons and the prompt (askclaude.js). */
function updateAnalysis () {
  const s = state.selection;
  $('analysisRange').textContent = s ? selectionLabel(s) : 'No period selected';
  $('analysisSelect').setAttribute('aria-pressed', String(state.selecting));
  $('analysisSelect').textContent = state.selecting ? 'Drag across the chart…' : s ? 'Select another time range' : 'Select time range';
  $('analysisClear').hidden = !s;
  $('chartWrap').classList.toggle('selecting', state.selecting);
  const prompt = s ? claudePrompt({ from: Math.round(s.from), to: Math.round(s.to), note: $('analysisNote').value, units: unit(), origin: location.origin }) : '';
  $('analysisPromptField').hidden = !s;
  $('analysisPrompt').value = prompt;
  $('analysisCopy').disabled = !s;
  const link = s && claudeLink(prompt);
  const open = $('analysisOpen');
  if (link) open.href = link;
  else open.removeAttribute('href');
  open.setAttribute('aria-disabled', String(!link));
  open.title = s && !link ? 'The prompt is too long for a link: copy it instead' : '';
  $('analysisStatus').textContent = '';
}

/** Copies the prompt; true if it worked, else it is selected in the box to copy by hand. */
async function copyPrompt () {
  const status = (text) => { $('analysisStatus').textContent = text; };
  try {
    await navigator.clipboard.writeText($('analysisPrompt').value);
    status('Copied: paste it into Claude (or another agent) with the loopk connector on.');
    return true;
  } catch {
    $('analysisPrompt').select();
    status('Select all and copy it from the box.');
    return false;
  }
}

function wireAnalysis () {
  $('analysisSelect').addEventListener('click', () => {
    state.selecting = !state.selecting;
    if (state.selecting) $('chartWrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    updateAnalysis();
  });
  $('analysisClear').addEventListener('click', () => {
    state.missShown = null;
    renderMisses();
    state.selecting = false;
    state.selection = null;
    $('analysisNote').value = '';
    renderSelection();
    updateAnalysis();
  });
  $('analysisNote').addEventListener('input', updateAnalysis);
  $('analysisCopy').addEventListener('click', copyPrompt);
  rememberOpen('analysis', 'claudeOpen');
  updateAnalysis();
}

/** Opens the section `id` as it was left, and remembers it under `key`. */
function rememberOpen (id, key) {
  const section = $(id);
  section.open = stored(key, (v) => v === '0' || v === '1', false, (v) => v === '1');
  section.addEventListener('toggle', () => store(key, section.open ? 1 : 0));
}

// --- loop misses ---------------------------------------------------------

// Glucose (mg/dL, as the misses come) in the page's unit.
const missGlucose = (v) => `${fmt(v / MGDL_PER_MMOL)} ${unit()}`;

async function loadMisses () {
  const to = Date.now();
  $('missesStatus').textContent = 'Searching…';
  state.misses = null;
  renderMisses();
  try {
    const body = await api(`/api/analysis/misses?from=${to - state.missDays * DAY}&to=${to}`);
    state.misses = body.misses;
  } catch (err) {
    state.misses = [];
    $('missesStatus').textContent = `Could not search: ${err.message}`;
    return;
  }
  renderMisses();
}

function renderMisses () {
  if (!$('misses').open || !state.misses) return;
  const list = state.misses.filter((m) => state.missKind === 'all' || m.kind === state.missKind);
  const lows = state.misses.filter((m) => m.kind === 'low').length;
  $('missesCount').hidden = false;
  $('missesCount').textContent = `${state.misses.length} in ${state.missDays} days`;
  $('missesStatus').textContent = `${lows} low${lows === 1 ? '' : 's'} after SMBs and ${state.misses.length - lows} under-dosed high${state.misses.length - lows === 1 ? '' : 's'} in the last ${state.missDays} days.`;
  $('missesList').innerHTML = list.map((m) => `<li class="miss${m.start === state.missShown ? ' miss-shown' : ''}" data-miss="${m.start}"${m.start === state.missShown ? ' aria-current="true"' : ''}>`
    + `<button type="button" class="miss-show" title="Show it on the chart">`
    + `<span class="miss-time">${esc(dayHm(m.start, true))}</span>`
    + `<span class="tag ${m.kind === 'low' ? 'miss-low' : 'tag-warn'}">${m.kind === 'low' ? 'Low' : 'High'} ${esc(fmt(m.glucose / MGDL_PER_MMOL))}</span>`
    + `<span class="miss-text">${esc(missSummary(m, missGlucose))}</span>`
    + (m.flags.length ? `<span class="miss-flags">${m.flags.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</span>` : '')
    + '</button>'
    + `<a class="btn btn-secondary miss-simulate" href="/simulate?${missSimulation(m)}" title="Dose this stretch again with other settings">Simulate</a>`
    + `<button type="button" class="btn btn-secondary miss-ask" title="Copy a prompt about it for Claude or another agent with loopk's MCP connector">${state.missCopied?.start === m.start ? (state.missCopied.ok ? 'Copied' : 'Not copied') : 'AI Prompt'}</button>`
    + '</li>').join('');
}

/** The simulate page's query for a miss: from 3 h before its SMBs (or start) to 2 h after its end. */
function missSimulation (m) {
  const from = Math.round(Math.min(m.from ?? m.start, m.start) - 3 * HOUR);
  const to = Math.round(Math.min(Date.now(), m.end + 2 * HOUR));
  return `from=${from}&to=${to}`;
}

/** Selects the miss's period and shows it on the chart. */
function showMiss (m) {
  state.missShown = m.start;
  renderMisses();
  state.selection = missSelection(m);
  zoomTo(state.selection.from, state.selection.to);
  renderSelection();
  updateAnalysis();
}

function wireMisses () {
  renderSeg('missDays', MISS_DAYS, state.missDays, (d) => d + 'd');
  renderSeg('missKind', Object.keys(MISS_KINDS), state.missKind, (k) => MISS_KINDS[k]);
  $('misses').addEventListener('toggle', () => {
    if (!$('misses').open) return;
    if (!state.misses) loadMisses();
    else renderMisses();
  });
  rememberOpen('misses', 'missesOpen');
  $('missDays').addEventListener('change', (e) => {
    state.missDays = Number(e.target.value);
    store('missDays', state.missDays);
    loadMisses();
  });
  $('missKind').addEventListener('change', (e) => {
    state.missKind = e.target.value;
    renderMisses();
  });
  $('missesList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-miss]');
    const m = item && state.misses?.find((x) => String(x.start) === item.dataset.miss);
    if (!m || e.target.closest('.miss-simulate')) return;
    showMiss(m);
    if (e.target.closest('.miss-ask')) {
      // Copies at once (in the click, as the clipboard requires) and shows the prompt.
      $('analysisNote').value = missNote(m, missGlucose);
      updateAnalysis();
      copyPrompt().then((ok) => {
        state.missCopied = { start: m.start, ok };
        renderMisses();
        setTimeout(() => {
          if (state.missCopied?.start !== m.start) return;
          state.missCopied = null;
          renderMisses();
        }, 2000);
      });
      showAnalysis();
    } else {
      $('chartWrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    // "Select time range" on, or shift held: the drag selects a period.
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
      // One selection per "Select time range"; shift-drag selects again.
      if (state.selection) {
        state.selecting = false;
        showAnalysis();
      }
      updateAnalysis();
      return;
    }
    if (!state.drag || e.pointerId !== state.drag.id) return;
    const clicked = !state.drag.moved;
    state.drag = null;
    // A click on a loop run opens its what-if on the simulate page.
    if (clicked && e.pointerType === 'mouse' && state.hoverRun) {
      location.href = `/simulate?run=${Math.round(state.hoverRun.t)}`;
      return;
    }
    writeView();
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
  // Horizontal scrolling (trackpad, or shift + wheel) pans. Wheel events
  // have no end: the gesture ends once they pause.
  let wheelEnd = null;
  wrap.addEventListener('wheel', (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!d || !state.data) return;
    e.preventDefault();
    state.gesture = true;
    pan(-d / geometry().iw * span());
    clearTimeout(wheelEnd);
    wheelEnd = setTimeout(() => {
      state.gesture = false;
      writeView();
    }, 300);
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
    writeView();
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
    writeView();
  });
  $('showForecast').addEventListener('change', (e) => {
    state.showForecast = e.target.checked;
    store('forecast', state.showForecast ? 1 : 0);
    $('legForecast').hidden = !state.showForecast;
    render();
    writeView();
  });
  $('showLoop').addEventListener('change', (e) => {
    state.showLoop = e.target.checked;
    store('loop', state.showLoop ? 1 : 0);
    $('legLoop').hidden = !state.showLoop;
    render();
    writeView();
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
  // Sport mode, once an admin set it up (Access page).
  if (session.sport) loadSport().catch(console.error);
  $('signOut').addEventListener('click', async () => {
    await clearCache().catch(() => {});
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });

  setupTheme($('themeToggle'));
  applyView(openedView);
  renderOptions();
  wireOptions();
  wireChart();
  wireAnalysis();
  wireMisses();
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
    // A start older than the first guess of the earliest reading was cut: apply it again.
    if (openedView.start != null) applyView({ start: openedView.start });
  } catch (err) {
    console.error(err);
    $('chartWrap').innerHTML = '<div class="chart-empty">Could not load data.</div>';
    return;
  }
  renderOptions();
  render();
  writeView();
  // Back and forward between addresses of this page.
  window.addEventListener('popstate', () => {
    applyView(parseView(location.search));
    renderOptions();
    render();
    ensureLoaded().catch(console.error);
  });
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
