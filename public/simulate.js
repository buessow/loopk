// The simulate page: one loop decision or a period again with changed
// settings, on loopk's copies of AAPS's algorithms (POST /api/simulate/run
// and /period, src/oref), which this browser runs itself (local.js): the
// server only reads and saves. The form and the result rows are in
// simulate-model.js; the charts are the glucose page's (glucosechart.js).

import {
  MGDL_PER_MMOL, OPEN_GROUPS, PERIOD_HOURS, SETTING_FIELDS, decisionRows, formChanges, missLists, parseView, periodEnding, periodLabel,
  periodRows, predMmol, shiftPeriod, simOverlay, viewQuery,
} from './simulate-model.js';
import { buildModel } from './model.js';
import { loopRuns } from './loopruns.js';
import { chartSvg, geometry, hoverSvg, nearest } from './glucosechart.js';
import { DEVICESTATUS_FIELDS, TREATMENT_FIELDS, api, fetchRange, fetchSwitchBefore } from './documents.js';
import { clearCache, useCacheFor } from './browser-cache.js';
import { request } from './local.js';
import { setupTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MIN = 60000;
const HOUR = 60 * MIN;
const SOURCES = { entered: 'Entered on this page.', configuration: "From AAPS's configuration.", console: "Read from the loop's log.", reason: "Read from the loop's reasons.", 'sensitivity ratio': "Read from how the sensitivity ratio moved the target.", default: "AAPS's default." };
// The chart around a single run: this much before and after it.
const RUN_SPAN = 3 * HOUR;

const state = {
  mode: 'run',
  units: stored('units', (v) => v === 'mg/dL' || v === 'mmol/L', 'mmol/L'),
  isAdmin: false,
  baseline: null, // GET /api/simulate/settings at the chosen time
  result: null,
  period: null, // { from, to } (ms)
  chart: null, // { wrap, data (model.js), t0, t1, sim, pinned } of the result shown
  hoverT: null,
};

function stored (key, valid, fallback) {
  try {
    const v = localStorage.getItem('loopk.' + key);
    if (v != null && valid(v)) return v;
  } catch { /* private mode */ }
  return fallback;
}

const mmol = () => state.units === 'mmol/L';
const glucose = (mgdl) => (mmol() ? (mgdl / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mgdl)));

/** A datetime-local value for ms, in this browser's time zone. */
function localInput (ms, seconds = false) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * MIN);
  return d.toISOString().slice(0, seconds ? 19 : 16);
}
const inputTime = (id) => ($(id).value ? new Date($(id).value).getTime() : NaN);
const dayHm = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function setStatus (text, warn = false) {
  $('status').textContent = text;
  $('status').hidden = !text;
  $('status').classList.toggle('tag-warn', warn);
}

async function call (path, body, method = body ? 'POST' : 'GET') {
  const res = await request(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `${path}: ${res.status}`);
  return json;
}

// --- the form --------------------------------------------------------------

/** The algorithm the changed decision uses, for the settings that apply to it. */
function activeAlgorithm () {
  return $('algorithm').value || (state.result?.mode === 'run' ? state.result.data.recorded.algorithm : null);
}

function renderSettings () {
  const values = state.baseline?.values || {};
  const sources = state.baseline?.sources || {};
  const algorithm = activeAlgorithm();
  const keep = readSettings();
  // groups keep the open state the reader gave them
  const open = new Map([...document.querySelectorAll('#settings details')].map((d) => [d.dataset.group, d.open]));
  const field = (f) => {
    const base = values[f.key];
    const value = keep[f.key] !== undefined ? keep[f.key] : base;
    const title = `AAPS: ${f.aaps}. ${SOURCES[sources[f.key]] || ''}`;
    if (f.kind === 'boolean') {
      return `<label class="field simulate-check" title="${esc(title)}"><input type="checkbox" data-setting="${f.key}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    }
    return `<div class="field" title="${esc(title)}"><label for="set-${f.key}">${esc(f.label)}</label>`
      + `<input class="input" type="number" id="set-${f.key}" data-setting="${f.key}" step="${f.step}" value="${value == null ? '' : esc(value)}"${f.nullable ? ' placeholder="from target"' : ''}></div>`;
  };
  const groups = new Map();
  for (const f of SETTING_FIELDS) {
    if (f.algorithms && algorithm && !f.algorithms.includes(algorithm)) continue;
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  $('settings').innerHTML = [...groups].map(([group, fields]) => {
    const isOpen = open.get(group) ?? OPEN_GROUPS.includes(group);
    return `<details class="simulate-subgroup" data-group="${esc(group)}"${isOpen ? ' open' : ''}>`
      + `<summary>${esc(group)} <span class="simulate-changed-count"></span></summary>`
      + `<div class="simulate-fields">${fields.map(field).join('')}</div></details>`;
  }).join('');
  markChanged();
}

/** The settings the form holds: { key: value }, null for an empty nullable one. */
function readSettings () {
  const out = {};
  for (const input of document.querySelectorAll('[data-setting]')) {
    const f = SETTING_FIELDS.find((s) => s.key === input.dataset.setting);
    if (f.kind === 'boolean') out[f.key] = input.checked;
    else if (input.value === '') out[f.key] = f.nullable ? null : undefined;
    else out[f.key] = Number(input.value);
  }
  return out;
}

function readForm () {
  const num = (id) => ($(id).value === '' ? NaN : Number($(id).value));
  return {
    settings: readSettings(),
    extra: $('extra').value,
    profileName: $('profileName').value,
    percentage: num('percentage'),
    isfFactor: num('isfFactor'),
    carbRatioFactor: num('carbRatioFactor'),
    basalFactor: num('basalFactor'),
    target: num('target'),
    algorithm: $('algorithm').value,
    tempTarget: $('tempTarget').value,
    tempTargetValue: num('ttValue'),
    tempTargetMinutes: num('ttMinutes'),
    sensitivityRatio: num('sensitivityRatio'),
  };
}

function changes () {
  return formChanges(readForm(), state.baseline?.values || {}, state.units);
}

/** Marks the fields that differ from the baseline. */
function markChanged () {
  let c = {};
  try { c = changes(); } catch { /* bad JSON: shown on run */ }
  const settings = c.settings || {};
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.closest('.field').classList.toggle('field-changed', Object.hasOwn(settings, input.dataset.setting));
  }
  // a folded group says how many of its settings are changed
  for (const d of document.querySelectorAll('#settings details')) {
    const n = d.querySelectorAll('.field-changed').length;
    d.querySelector('.simulate-changed-count').textContent = n ? `(${n} changed)` : '';
  }
  const p = c.profile || {};
  const mark = (id, on) => $(id).closest('.field').classList.toggle('field-changed', on);
  mark('profileName', !!p.name);
  mark('percentage', p.percentage != null && p.percentage !== state.baseline?.profile?.percentage);
  mark('isfFactor', p.isfFactor != null);
  mark('carbRatioFactor', p.carbRatioFactor != null);
  mark('basalFactor', p.basalFactor != null);
  mark('target', p.targetMgdl != null);
  mark('algorithm', !!c.algorithm);
  mark('tempTarget', c.tempTarget !== undefined);
  mark('sensitivityRatio', c.sensitivityRatio != null);
  $('extra').closest('.field').classList.toggle('field-changed', !!$('extra').value.trim());
  $('saveRow').hidden = !state.isAdmin || !Object.keys(settings).length;
  profileHint();
}

function profileHint () {
  const p = state.baseline?.profile;
  if (!p) {
    $('profileHint').textContent = 'No profile found at that time.';
    return;
  }
  const pct = p.percentage ?? 100;
  $('percentage').placeholder = String(pct);
  const target = p.targetLow?.[0]?.[1];
  const toMgdl = /^mmol/i.test(p.units || '') ? MGDL_PER_MMOL : 1;
  if (target != null) $('target').placeholder = glucose(target * toMgdl);
  const name = $('profileName').value;
  const inEffect = `In effect: ${p.name ? `“${p.name}”` : 'the profile'} at ${pct}%.`;
  $('profileHint').textContent = name
    ? `${inEffect} Simulated with the stored profile “${name}” instead, at ${$('percentage').value || pct}%. The factors multiply its ISF, carb ratio and basal.`
    : `${inEffect} Empty fields stay as they were; the factors multiply the profile's ISF, carb ratio and basal.`;
}

/** The stored profiles to pick from, keeping the one picked. */
function renderProfiles () {
  const picked = $('profileName').value;
  const names = state.baseline?.profiles || [];
  $('profileName').innerHTML = '<option value="">As recorded (profile and % as they were)</option>'
    + names.map((n) => `<option value="${esc(n)}"${n === picked ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

async function loadBaseline (at) {
  if (!Number.isFinite(at)) return;
  try {
    state.baseline = await call(`/api/simulate/settings?at=${Math.round(at)}`);
    // the values start from the baseline again
    for (const input of document.querySelectorAll('[data-setting]')) input.remove();
    renderProfiles();
    renderSettings();
  } catch (err) {
    setStatus(err.message, true);
  }
}

/** The form back to the loop as it was: no changes. */
function reset () {
  for (const input of document.querySelectorAll('[data-setting]')) input.remove();
  $('extra').value = '';
  $('profileName').value = '';
  for (const id of ['percentage', 'target', 'sensitivityRatio']) $(id).value = '';
  for (const id of ['isfFactor', 'carbRatioFactor', 'basalFactor']) $(id).value = '1';
  $('algorithm').value = '';
  $('tempTarget').value = '';
  $('ttValue').value = mmol() ? '8.0' : '144';
  $('ttMinutes').value = '60';
  showTempTarget();
  renderSettings();
}

// --- the charts: the glucose page's, with the simulation over it -----------

/** The glucose page's model of [from, to]: readings, treatments, the loop's runs, heart rate. */
async function chartData (from, to) {
  const [entries, treatments, devicestatus, heartrate, profiles, switchesBefore] = await Promise.all([
    fetchRange('entries', 'date', from - 6 * HOUR, to, '&type=sgv&fields=identifier,date,srvModified,sgv,direction,type,device'),
    fetchRange('treatments', 'created_at', from, to, '&fields=' + TREATMENT_FIELDS),
    fetchRange('devicestatus', 'date', from - HOUR, to, '&fields=' + DEVICESTATUS_FIELDS).catch(() => []),
    fetchRange('heartrate', 'date', from, to, '&fields=identifier,date,srvModified,beatsPerMinute').catch(() => []),
    api('/api/v3/profile?sort$desc=date&limit=1'),
    fetchSwitchBefore(from),
  ]);
  const data = buildModel({ entries, treatments, devicestatus, heartrate, predictions: [], profile: profiles[0], switchesBefore, start: from, now: to });
  data.loop = loopRuns(devicestatus);
  return data;
}

function chartOptions () {
  const c = state.chart;
  return {
    data: c.data,
    W: c.wrap.clientWidth || 1200,
    t0: c.t0,
    t1: c.t1,
    units: state.units,
    style: stored('style', (v) => ['boxes', 'sticks', 'dots', 'line'].includes(v), 'boxes'),
    showProfile: stored('profile', (v) => v === '0' || v === '1', '1') === '1',
    showForecast: false,
    showLoop: true,
    withDay: c.t1 - c.t0 > 24 * HOUR,
    sim: c.sim,
    pinned: c.pinned,
  };
}

function drawChart () {
  const c = state.chart;
  if (!c) return;
  c.wrap.innerHTML = chartSvg(chartOptions());
  drawHover();
}

function drawHover () {
  const g = state.chart?.wrap.querySelector('#hov');
  if (!g) return;
  g.innerHTML = state.hoverT == null ? '' : hoverSvg(chartOptions(), state.hoverT).html;
}

function wireChart (wrap) {
  wrap.addEventListener('pointermove', (e) => {
    if (state.chart?.wrap !== wrap || e.target.id !== 'hit') {
      if (state.hoverT != null) { state.hoverT = null; drawHover(); }
      return;
    }
    const { t0, t1, padL, iw } = geometry(chartOptions());
    state.hoverT = t0 + (e.clientX - wrap.getBoundingClientRect().left - padL) / iw * (t1 - t0);
    drawHover();
  });
  wrap.addEventListener('pointerleave', () => {
    state.hoverT = null;
    drawHover();
  });
  let width = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== width) {
      width = w;
      if (state.chart?.wrap === wrap) drawChart();
    }
  }).observe(wrap);
}

// --- results ---------------------------------------------------------------

function table (el, head, rows, changedCol = null) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`
    + rows.map((r) => {
      const differs = changedCol != null && r[changedCol] !== r[changedCol - 1];
      return `<tr${differs ? ' class="row-changed"' : ''}>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`;
    }).join('') + '</tbody>';
}

async function renderRun (r) {
  $('reproduces').textContent = r.reproduces ? 'it does' : 'it does not here, so read the changed column against loopk, unchanged';
  table($('decision'), ['', 'Recorded', 'loopk, unchanged', 'Changed'], decisionRows(r, glucose), 3);
  $('reasons').innerHTML = [['Recorded', r.recorded.reason], ['loopk, unchanged', r.baseline.reason], ['Changed', r.changed.reason]]
    .map(([label, text]) => `<p><b>${esc(label)}</b>: ${esc(text || '–')}</p>`).join('');
  $('runResult').hidden = false;
  const t0 = r.time - RUN_SPAN;
  const t1 = Math.min(Date.now(), r.time + RUN_SPAN);
  const data = await chartData(t0, t1);
  const run = nearest(data.loop, r.time, 2 * MIN) || { t: r.time, pred: {} };
  state.chart = { wrap: $('runChart'), data, t0, t1, pinned: { run, changed: predMmol(r.changed.predBGs) } };
  drawChart();
}

const FATE = { both: 'in both', gone: 'gone', new: 'new' };

function renderMisses (r) {
  const lists = missLists(r.misses);
  const missItem = (m) => `<li><span class="miss-time">${esc(dayHm(m.start))}</span> ${m.kind === 'low' ? 'low to' : 'high to'} ${esc(glucose(m.glucose))} ${esc(state.units)} <span class="miss-fate miss-fate-${m.fate}">${FATE[m.fate]}</span></li>`;
  const missList = (title, list) => `<div><h5>${esc(title)} (${list.length})</h5>${list.length ? `<ul class="simulate-misses">${list.map(missItem).join('')}</ul>` : '<p class="text-muted">None.</p>'}</div>`;
  $('misses').innerHTML = '<p class="text-muted report-note">Loop misses: lows and highs the loop could have prevented (as on the glucose page), found again in the simulated glucose. <b>In both</b>: in reality and in the simulation (within half an hour). <b>Gone</b>: in reality, not in the simulation. <b>New</b>: only in the simulation.</p>'
    + `<div class="simulate-miss-lists">${missList('Actual', lists.actual)}${missList('Simulated', lists.simulated)}</div>`
    + (r.errors ? `<p class="text-muted">${r.errors} loop runs couldn't be decided; the temp running then went on.</p>` : '');
}

async function renderPeriod (r) {
  if (r.error) {
    setStatus(r.error, true);
    return;
  }
  const [kLow, , kHigh] = r.ks;
  table($('periodTable'), ['', 'Actual', 'Simulated', `Band low (${kLow.toFixed(2)})`, `Band high (${kHigh.toFixed(2)})`], periodRows(r, glucose));
  renderMisses(r);
  $('periodResult').hidden = false;
  const data = await chartData(r.from, r.to);
  state.chart = { wrap: $('periodChart'), data, t0: r.from, t1: r.to, sim: simOverlay(r) };
  drawChart();
}

async function render () {
  $('runResult').hidden = true;
  $('periodResult').hidden = true;
  state.chart = null;
  state.hoverT = null;
  for (const id of ['runChart', 'periodChart']) $(id).innerHTML = '';
  document.querySelectorAll('.unit').forEach((el) => { el.textContent = state.units; });
  if (!state.result) return;
  try {
    if (state.result.mode === 'run') await renderRun(state.result.data);
    else await renderPeriod(state.result.data);
  } catch (err) {
    setStatus(err.message, true);
  }
}

// --- the period ------------------------------------------------------------

function renderPeriodNav () {
  const { from, to } = state.period;
  const hours = (to - from) / HOUR;
  $('periodRanges').innerHTML = PERIOD_HOURS.map((h) => `<label class="seg-opt"><input type="radio" name="periodRanges" value="${h}" ${h === hours ? 'checked' : ''}>${periodLabel(h)}</label>`).join('');
  const atNow = Date.now() - to < 5 * MIN;
  $('periodTitle').textContent = atNow ? `Last ${hours <= 48 ? `${hours} hours` : `${hours / 24} days`}` : `${dayHm(from)} – ${dayHm(to)}`;
  $('later').disabled = atNow;
  $('toNow').hidden = atNow;
}

/** A new period: the baseline at its start, and the simulation again if one is shown. */
async function setPeriod (period) {
  state.period = period;
  renderPeriodNav();
  history.replaceState(null, '', `/simulate?${viewQuery(view())}`);
  await loadBaseline(period.from);
  if (state.result?.mode === 'period') await run();
}

// --- running ---------------------------------------------------------------

function view () {
  return state.mode === 'run'
    ? { mode: 'run', run: inputTime('runAt') }
    : { mode: 'period', from: state.period.from, to: state.period.to };
}

async function run () {
  let c;
  try {
    c = changes();
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  const v = view();
  history.replaceState(null, '', `/simulate?${viewQuery(v)}`);
  $('run').disabled = true;
  setStatus(state.mode === 'run' ? 'Deciding…' : 'Simulating…');
  try {
    if (v.mode === 'run') {
      if (!Number.isFinite(v.run)) throw new Error('Pick the time of a loop run');
      const data = await call('/api/simulate/run', { time: v.run, changes: c });
      // the run found may be a little off the time asked for
      $('runAt').value = localInput(data.time, true);
      history.replaceState(null, '', `/simulate?${viewQuery({ mode: 'run', run: data.time })}`);
      state.result = { mode: 'run', data };
      renderSettings();
    } else {
      const k = Number($('k').value) || undefined;
      state.result = { mode: 'period', data: await call('/api/simulate/period', { from: v.from, to: v.to, changes: c, k }) };
    }
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('run').disabled = false;
  }
  await render();
}

async function save () {
  const c = changes();
  if (!c.settings) return;
  const at = state.mode === 'run' ? inputTime('runAt') : state.period.from;
  const names = Object.entries(c.settings).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
  if (!confirm(`Save ${names} as your AAPS settings from ${dayHm(at)} on?`)) return;
  try {
    await call('/api/simulate/settings', { values: c.settings, validFrom: at }, 'PUT');
    await loadBaseline(at);
    setStatus('Saved');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setMode (mode) {
  state.mode = mode;
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $('runWhen').hidden = mode !== 'run';
  $('periodWhen').hidden = mode !== 'period';
}

function showTempTarget () {
  const set = $('tempTarget').value === 'set';
  $('ttValueField').hidden = !set;
  $('ttMinutesField').hidden = !set;
}

function wire () {
  $('mode').addEventListener('change', (e) => {
    setMode(e.target.value);
    if (state.mode === 'period') history.replaceState(null, '', `/simulate?${viewQuery(view())}`);
    loadBaseline(state.mode === 'run' ? inputTime('runAt') : state.period.from);
  });
  $('runAt').addEventListener('change', () => loadBaseline(inputTime('runAt')));
  $('periodRanges').addEventListener('change', (e) => setPeriod(periodEnding(state.period.to, Number(e.target.value))));
  $('earlier').addEventListener('click', () => setPeriod(shiftPeriod(state.period, -1)));
  $('later').addEventListener('click', () => setPeriod(shiftPeriod(state.period, 1)));
  $('toNow').addEventListener('click', () => setPeriod(periodEnding(Date.now(), (state.period.to - state.period.from) / HOUR)));
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
  $('form').addEventListener('input', markChanged);
  $('algorithm').addEventListener('change', renderSettings);
  $('tempTarget').addEventListener('change', showTempTarget);
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', reset);
  wireChart($('runChart'));
  wireChart($('periodChart'));
}

async function main () {
  const res = await request('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const session = await res.json();
  await useCacheFor(session.user?.email).catch(() => {});
  state.isAdmin = !!session.isAdmin;
  $('adminLink').hidden = !session.isAdmin || session.keepsNothing;
  $('signOut').addEventListener('click', async () => {
    await clearCache().catch(() => {});
    await request('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });
  setupTheme($('themeToggle'));
  document.querySelectorAll('.unit').forEach((el) => { el.textContent = state.units; });
  $('ttValue').value = mmol() ? '8.0' : '144';

  const v = parseView(location.search);
  const now = Date.now();
  $('runAt').value = localInput(v?.mode === 'run' ? v.run : now - 5 * MIN, true);
  state.period = v?.mode === 'period' ? { from: v.from, to: v.to } : periodEnding(now, 24);
  renderPeriodNav();
  setMode(v?.mode || 'run');
  wire();
  await loadBaseline(state.mode === 'run' ? inputTime('runAt') : state.period.from);
  await render();
  if (v) await run();
}

main().catch((err) => setStatus(err.message, true));
