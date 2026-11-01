// The reports page: a dashboard of widgets, each one metric of the hourly
// totals (reports-model.js) shown as a number, chart or table. GridStack owns
// the layout, Chart.js the charts. The dashboard is saved per person on the
// server, so every device shows the same one (in this browser on a server
// that keeps nothing).
/* global GridStack, Chart */

import {
  DISPLAYS, GROUPS, METRICS, PERIODS, autoTitle, defaultDashboard, formatValue, hourRows, neededFrom,
  normalizeDashboard, periodLabel, periodRange, unitOf, widgetData,
} from './reports-model.js';
import { clearCache } from './browser-cache.js';
import { setupTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const UNITS = ['mmol/L', 'mg/dL'];
const SAVE_DELAY = 800;
// Data older than this is fetched again (also every RELOAD while the page is shown).
const STALE = 5 * 60000;
const RELOAD = 10 * 60000;
const GRID_COLUMNS = 12;
// One column on phones, widgets in their desktop order.
const COLUMN_OPTS = { breakpoints: [{ w: 700, c: 1 }], layout: 'list' };
// Colors of the groups of a doughnut that shows one value per group.
const PALETTE = ['--color-accent-700', '--color-accent-500', '--color-accent-300', '--color-accent-2-700',
  '--color-accent-2-500', '--color-accent-2-300', '--color-neutral-600', '--color-neutral-400'];

const state = {
  dashboard: null,
  inBrowser: false,
  rows: [],
  loadedFrom: null,
  loadedAt: 0,
  editing: false,
  units: stored('units', (v) => UNITS.includes(v), 'mmol/L'),
  grid: null,
  editingId: null, // widget the dialog edits; null: a new one
};
const charts = new Map();
let saveTimer = null;

function stored (key, valid, fallback) {
  try {
    const v = localStorage.getItem('loopk.' + key);
    return v != null && valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store (key, value) {
  try { localStorage.setItem('loopk.' + key, String(value)); } catch { /* private mode */ }
}

function setStatus (text, warn = false) {
  $('status').textContent = text;
  $('status').hidden = !text;
  $('status').classList.toggle('tag-warn', warn);
}

async function call (method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `${path}: ${res.status}`);
  return json;
}

// --- colors ----------------------------------------------------------------

// Chart.js draws on a canvas, which needs plain colors: CSS variables (with
// oklch and color-mix) are resolved to rgb through a probe element.
let probe = null;
let pixel = null;
function cssColor (name) {
  if (!probe) {
    probe = document.createElement('span');
    probe.hidden = true;
    document.body.append(probe);
    pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  probe.style.color = `var(${name})`;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = '#808080';
  pixel.fillStyle = getComputedStyle(probe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

// --- data ------------------------------------------------------------------

async function ensureData (force = false) {
  const from = neededFrom(state.dashboard);
  const fresh = Date.now() - state.loadedAt < STALE;
  if (!force && state.loadedFrom != null && from >= state.loadedFrom && fresh) return;
  setStatus('Loading…');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const data = await call('GET', `/api/reports/hours?from=${Math.floor(from)}&to=${Date.now()}&tz=${encodeURIComponent(tz)}`);
  state.rows = hourRows(data);
  state.loadedFrom = from;
  state.loadedAt = Date.now();
  setStatus('');
}

// --- saving ----------------------------------------------------------------

// A server that keeps nothing keeps no dashboards: this browser does.
const DASHBOARD_KEY = 'loopk.dashboard';

function browserDashboard () {
  try {
    return JSON.parse(localStorage.getItem(DASHBOARD_KEY));
  } catch {
    return null;
  }
}

function scheduleSave () {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (state.inBrowser) localStorage.setItem(DASHBOARD_KEY, JSON.stringify(state.dashboard));
      else await call('PUT', '/api/reports/dashboard', state.dashboard);
      setStatus('Saved');
      setTimeout(() => { if ($('status').textContent === 'Saved') setStatus(''); }, 1500);
    } catch (err) {
      setStatus(`Not saved: ${err.message}`, true);
    }
  }, SAVE_DELAY);
}

/** Takes the positions from the grid; only at full width, so a phone's single column does not reorder the desktop layout. */
function saveLayout () {
  if (!state.grid || state.grid.getColumn() !== GRID_COLUMNS) return;
  for (const node of state.grid.engine.nodes) {
    const w = state.dashboard.widgets.find((x) => x.id === node.id);
    if (w) Object.assign(w, { x: node.x, y: node.y, w: node.w, h: node.h });
  }
  scheduleSave();
}

// --- widgets ---------------------------------------------------------------

const widgetEl = (id) => [...$('grid').querySelectorAll('.grid-stack-item')].find((el) => el.gridstackNode?.id === id || el.dataset.id === id);

function addToGrid (w, autoPosition = false) {
  const el = document.createElement('div');
  el.className = 'grid-stack-item';
  el.dataset.id = w.id;
  el.innerHTML = `<div class="grid-stack-item-content widget">
    <div class="widget-head"><h6 class="widget-title"></h6><span class="widget-period"></span>
      <span class="widget-actions edit-only"><button type="button" class="btn btn-ghost" data-edit>Edit</button><button type="button" class="btn btn-ghost" data-remove>Remove</button></span>
    </div>
    <div class="widget-body"></div>
  </div>`;
  $('grid').append(el);
  state.grid.makeWidget(el, autoPosition ? { id: w.id, w: w.w, h: w.h, autoPosition: true } : { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
  renderWidget(w);
}

/** Lays the widgets out at 12 columns, then lets GridStack go down to one on a phone (built there directly, the order comes out reversed). */
function buildGrid () {
  for (const chart of charts.values()) chart.destroy();
  charts.clear();
  state.grid.updateOptions({ columnOpts: null });
  state.grid.column(GRID_COLUMNS, 'none');
  state.grid.removeAll();
  state.grid.batchUpdate();
  for (const w of state.dashboard.widgets) addToGrid(w);
  state.grid.batchUpdate(false);
  state.grid.updateOptions({ columnOpts: COLUMN_OPTS });
}

function renderAll () {
  for (const w of state.dashboard.widgets) renderWidget(w);
}

function renderWidget (w) {
  const el = widgetEl(w.id);
  if (!el) return;
  const metric = METRICS[w.metric];
  el.querySelector('.widget-title').textContent = w.title || autoTitle(w);
  el.querySelector('.widget-period').textContent = w.period ? periodLabel(w.period) : '';
  el.querySelector('.widget-period').title = periodLabel(w.period || state.dashboard.period);
  const body = el.querySelector('.widget-body');
  charts.get(w.id)?.destroy();
  charts.delete(w.id);

  const range = periodRange(w.period || state.dashboard.period);
  const mgdl = state.units === 'mg/dL';
  // A doughnut of several series shows their shares over the whole period.
  const def = w.display === 'doughnut' && metric.series ? { ...w, group: 'none' } : w;
  const data = widgetData(state.rows, def, { range, mgdl });
  const unit = unitOf(metric, data.ctx);
  const fmt = (v) => formatValue(v, metric, data.ctx);
  if (!data.series.some((s) => s.values.some((v) => v != null && Number.isFinite(v)))) {
    body.innerHTML = '<div class="widget-empty">No data in this period</div>';
    return;
  }

  if (w.display === 'number') {
    body.innerHTML = metric.series
      ? `<div class="widget-number">${data.series.map((s) => `<div class="part"><b style="color:var(${s.color || '--color-text'})">${fmt(s.values[0])}</b><span>${esc(s.label)} ${esc(unit)}</span></div>`).join('')}</div>`
      : `<div class="widget-number"><b>${fmt(data.series[0].values[0])}</b><span class="unit">${esc(unit)}</span></div>`;
    return;
  }

  if (w.display === 'table') {
    const head = data.series.map((s) => `<th>${esc(s.label)}${unit ? ` (${esc(unit)})` : ''}</th>`).join('');
    const rows = data.labels.map((label, i) => `<tr><td>${esc(label)}</td>${data.series.map((s) => `<td>${fmt(s.values[i])}</td>`).join('')}</tr>`).join('');
    body.innerHTML = `<div class="widget-table"><table class="table"><thead><tr><th>${esc(GROUPS[def.group])}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    return;
  }

  body.innerHTML = '<canvas></canvas>';
  const text = cssColor('--color-neutral-700');
  const gridColor = cssColor('--color-divider');
  const tooltip = { callbacks: { label: (c) => `${c.dataset.label || c.label}: ${fmt(c.raw)}${unit ? ` ${unit}` : ''}` } };
  let config;
  if (w.display === 'doughnut') {
    const shares = metric.series
      ? { labels: data.series.map((s) => s.label), values: data.series.map((s) => s.values[0]), colors: data.series.map((s) => cssColor(s.color)) }
      : { labels: data.labels, values: data.series[0].values, colors: data.labels.map((_, i) => cssColor(PALETTE[i % PALETTE.length])) };
    config = {
      type: 'doughnut',
      data: { labels: shares.labels, datasets: [{ data: shares.values, backgroundColor: shares.colors, borderColor: cssColor('--color-bg'), borderWidth: 1 }] },
      options: {
        plugins: {
          legend: { position: 'right', labels: { color: text, boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(c.raw)}${unit ? ` ${unit}` : ''}` } },
        },
      },
    };
  } else {
    const line = w.display === 'line';
    const stacked = !line && data.series.length > 1;
    const many = data.labels.length > 60;
    config = {
      type: line ? 'line' : 'bar',
      data: {
        labels: data.labels,
        datasets: data.series.map((s) => {
          const color = cssColor(s.color || '--chart-line');
          return {
            label: s.label,
            data: s.values,
            backgroundColor: color,
            borderColor: color,
            borderWidth: line ? 2 : 0,
            pointRadius: line && !many ? 2 : 0,
            tension: 0.25,
            spanGaps: true,
          };
        }),
      },
      options: {
        scales: {
          x: { stacked, grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, font: { size: 11 } } },
          y: {
            stacked,
            beginAtZero: !(line && (w.metric === 'mean' || w.metric === 'gmi' || w.metric === 'heartRate')),
            max: stacked && metric.unit === '%' ? 100 : undefined,
            grid: { color: gridColor },
            ticks: { color: text, font: { size: 11 } },
          },
        },
        plugins: {
          legend: { display: data.series.length > 1, position: 'bottom', labels: { color: text, boxWidth: 10, font: { size: 11 } } },
          tooltip,
        },
      },
    };
  }
  config.options.responsive = true;
  config.options.maintainAspectRatio = false;
  config.options.animation = false;
  charts.set(w.id, new Chart(body.querySelector('canvas'), config));
}

function removeWidget (id) {
  const el = widgetEl(id);
  charts.get(id)?.destroy();
  charts.delete(id);
  state.dashboard.widgets = state.dashboard.widgets.filter((w) => w.id !== id);
  if (el) state.grid.removeWidget(el);
  scheduleSave();
}

// --- widget dialog -----------------------------------------------------------

const options = (entries, current) => entries.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join('');

function syncDialog () {
  const display = $('wDisplay').value;
  // A number is always over the whole period.
  $('wGroup').disabled = display === 'number';
  $('wDates').hidden = $('wPeriod').value !== 'custom';
}

function openDialog (id = null) {
  state.editingId = id;
  const w = id ? state.dashboard.widgets.find((x) => x.id === id) : { metric: 'tir', group: 'day', display: 'bar', period: null, title: '' };
  $('widgetDialogTitle').textContent = id ? 'Edit widget' : 'Add widget';
  $('widgetOk').textContent = id ? 'Apply' : 'Add';
  $('wMetric').innerHTML = options(Object.entries(METRICS).map(([k, m]) => [k, m.label]), w.metric);
  $('wGroup').innerHTML = options(Object.entries(GROUPS), w.group);
  $('wDisplay').innerHTML = options(Object.entries(DISPLAYS), w.display);
  $('wPeriod').innerHTML = options([['', 'Dashboard period'], ...Object.entries(PERIODS)], w.period?.preset || '');
  const fallback = defaultDates();
  $('wFrom').value = w.period?.from || fallback.from;
  $('wTo').value = w.period?.to || fallback.to;
  $('wTitle').value = w.title || '';
  syncDialog();
  $('widgetDialog').returnValue = '';
  $('widgetDialog').showModal();
}

function dialogPeriod () {
  const preset = $('wPeriod').value;
  if (!preset) return null;
  return preset === 'custom' ? { preset, from: $('wFrom').value, to: $('wTo').value } : { preset };
}

async function applyDialog () {
  const def = {
    metric: $('wMetric').value,
    group: $('wGroup').value,
    display: $('wDisplay').value,
    period: dialogPeriod(),
    title: $('wTitle').value.trim(),
  };
  if (state.editingId) {
    const w = state.dashboard.widgets.find((x) => x.id === state.editingId);
    // normalizeDashboard drops a custom period with bad dates.
    Object.assign(w, normalizeDashboard({ widgets: [{ ...w, ...def }] }).widgets[0], { id: w.id });
    await refresh();
  } else {
    const [w] = normalizeDashboard({ widgets: [{ ...def, id: `w${Date.now().toString(36)}`, y: 1000, w: 6, h: 4 }] }).widgets;
    state.dashboard.widgets.push(w);
    await ensureData();
    addToGrid(w, true);
    saveLayout();
  }
  scheduleSave();
}

// --- controls ----------------------------------------------------------------

function renderSeg (id, entries, current) {
  $(id).innerHTML = entries.map(([value, label]) => `<label class="seg-opt"><input type="radio" name="${id}" value="${esc(value)}" ${value === current ? 'checked' : ''}>${esc(label)}</label>`).join('');
}

/** The last 14 days as dates, for a new custom period. */
function defaultDates () {
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 13);
  return { from: day(from), to: day(to) };
}

function renderControls () {
  const p = state.dashboard.period;
  renderSeg('period', Object.entries(PERIODS), p.preset);
  renderSeg('units', UNITS.map((u) => [u, u]), state.units);
  $('customDates').hidden = p.preset !== 'custom';
  if (p.preset === 'custom') {
    $('periodFrom').value = p.from;
    $('periodTo').value = p.to;
  }
}

async function refresh (force = false) {
  try {
    await ensureData(force);
    renderAll();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setEditing (on) {
  state.editing = on;
  document.querySelector('.reports-page').classList.toggle('editing', on);
  state.grid.setStatic(!on);
  $('editDashboard').textContent = on ? 'Done' : 'Edit dashboard';
  $('editDashboard').setAttribute('aria-pressed', String(on));
}

function wire () {
  $('period').addEventListener('change', (e) => {
    const preset = e.target.value;
    state.dashboard.period = preset === 'custom' ? { preset, ...defaultDates() } : { preset };
    renderControls();
    scheduleSave();
    refresh();
  });
  const customChanged = () => {
    const period = { preset: 'custom', from: $('periodFrom').value, to: $('periodTo').value };
    // normalizeDashboard falls back to the default period for bad dates.
    if (normalizeDashboard({ period, widgets: [] }).period.preset !== 'custom') return;
    state.dashboard.period = period;
    scheduleSave();
    refresh();
  };
  $('periodFrom').addEventListener('change', customChanged);
  $('periodTo').addEventListener('change', customChanged);
  $('units').addEventListener('change', (e) => {
    state.units = e.target.value;
    store('units', state.units);
    renderAll();
  });
  $('editDashboard').addEventListener('click', () => setEditing(!state.editing));
  $('addWidget').addEventListener('click', () => openDialog());
  $('resetDashboard').addEventListener('click', async () => {
    if (!confirm('Replace your dashboard with the standard one?')) return;
    state.dashboard = defaultDashboard();
    renderControls();
    await ensureData();
    buildGrid();
    scheduleSave();
  });
  $('grid').addEventListener('click', (e) => {
    const id = e.target.closest('.grid-stack-item')?.gridstackNode?.id;
    if (!id) return;
    if (e.target.closest('[data-edit]')) openDialog(id);
    else if (e.target.closest('[data-remove]')) removeWidget(id);
  });
  $('wDisplay').addEventListener('change', syncDialog);
  $('wPeriod').addEventListener('change', syncDialog);
  $('widgetDialog').addEventListener('close', () => {
    if ($('widgetDialog').returnValue === 'ok') applyDialog().catch((err) => setStatus(err.message, true));
  });
  state.grid.on('change', saveLayout);
  // Colors come from the theme.
  new MutationObserver(renderAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setInterval(() => { if (!document.hidden) refresh(true); }, RELOAD);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

async function main () {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const session = await res.json();
  $('adminLink').hidden = !session.isAdmin || session.keepsNothing;
  $('signOut').addEventListener('click', async () => {
    await clearCache().catch(() => {});
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });
  setupTheme($('themeToggle'));

  state.grid = GridStack.init({
    column: GRID_COLUMNS,
    cellHeight: 76,
    margin: 6,
    float: false,
    staticGrid: true,
    animate: false,
    handle: '.widget-head',
  }, $('grid'));

  try {
    state.inBrowser = !!session.keepsNothing;
    const saved = state.inBrowser ? browserDashboard() : await call('GET', '/api/reports/dashboard');
    state.dashboard = saved ? normalizeDashboard(saved) : defaultDashboard();
  } catch (err) {
    state.dashboard = defaultDashboard();
    setStatus(`Dashboard not loaded: ${err.message}`, true);
  }
  renderControls();
  wire();
  try {
    await ensureData();
  } catch (err) {
    setStatus(err.message, true);
  }
  buildGrid();
}

main().catch((err) => setStatus(err.message, true));
