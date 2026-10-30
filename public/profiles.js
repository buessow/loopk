// The profiles page: the basal profiles in effect in a period, the time and
// insulin under each one and its manual percentages, and on click a chart of
// the profile by hour of day with the loop's and the manual adaptations
// (profiles-model.js). Chart.js draws the charts.
/* global Chart */

import { PERIODS, periodRange } from './reports-model.js';
import { chartSeries, combinePcts, hourlyProfile, rowSummary } from './profiles-model.js';
import { clearCache } from './browser-cache.js';
import { setupTheme } from './theme.js';
import { testDelta } from './testprofile-model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const COLUMNS = 11;
// The series a chart can show; each can be switched off (saved in this browser).
const SERIES = {
  profile: 'Profile 100%',
  pcts: 'Profile × manual %',
  basal: 'Delivered basal',
  bolus: 'SMB/bolus',
  sd: '± SD',
  ratio: 'Sensitivity chart',
};

const state = {
  period: storedPeriod(),
  data: null,
  open: new Map(), // key of an expanded profile → percentage shown (number or 'all')
  series: storedSeries(),
};
const charts = new Map();

function storedPeriod () {
  try {
    const p = JSON.parse(localStorage.getItem('loopk.profilesPeriod'));
    if (p && PERIODS[p.preset] && (p.preset !== 'custom' || (p.from && p.to))) return p;
  } catch { /* none */ }
  return { preset: '30d' };
}

function storedSeries () {
  try {
    const hidden = JSON.parse(localStorage.getItem('loopk.profilesHidden'));
    if (Array.isArray(hidden)) return new Set(Object.keys(SERIES).filter((k) => !hidden.includes(k)));
  } catch { /* none */ }
  return new Set(Object.keys(SERIES));
}

function setSeries (key, on) {
  if (on) state.series.add(key);
  else state.series.delete(key);
  try {
    localStorage.setItem('loopk.profilesHidden', JSON.stringify(Object.keys(SERIES).filter((k) => !state.series.has(k))));
  } catch { /* private mode */ }
  renderTable();
}

function storePeriod () {
  try { localStorage.setItem('loopk.profilesPeriod', JSON.stringify(state.period)); } catch { /* private mode */ }
}

function setStatus (text, warn = false) {
  $('status').textContent = text;
  $('status').hidden = !text;
  $('status').classList.toggle('tag-warn', warn);
}

async function call (path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `${path}: ${res.status}`);
  return json;
}

// Chart.js draws on a canvas, which needs plain colors (as in reports.js).
let probe = null;
let pixel = null;
function cssColor (name, alpha = 1) {
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
  return `rgba(${r}, ${g}, ${b}, ${((a / 255) * alpha).toFixed(2)})`;
}

// --- table -----------------------------------------------------------------

const num = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits));
const date = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function cells (usage) {
  const r = rowSummary(usage, state.data.minutes);
  return [num(r.hours), num(r.share), num(r.total), num(r.basal), num(r.bolus), num(r.perDay), num(r.sensitivity, 2), String(r.fullDays), num(r.dayMean), num(r.daySd)]
    .map((v) => `<td>${v}</td>`).join('');
}

function renderTable () {
  for (const c of charts.values()) c.destroy();
  charts.clear();
  const table = $('profiles');
  table.querySelectorAll('tbody').forEach((b) => b.remove());
  const profiles = state.data?.profiles || [];
  if (!profiles.length) {
    table.insertAdjacentHTML('beforeend', '<tbody><tr><td colspan="${COLUMNS}" class="text-muted">No profile in effect in this period</td></tr></tbody>');
    return;
  }
  for (const p of profiles) {
    const open = state.open.has(p.key);
    const when = `${date(p.firstSeen)} – ${p.current ? 'now' : date(p.lastSeen)}`;
    const name = `<button type="button" class="profile-toggle" aria-expanded="${open}" data-key="${esc(p.key)}">`
      + `<span class="profile-caret" aria-hidden="true">▸</span><b>${esc(p.name || 'Unnamed')}</b>`
      + `${p.current ? ' <span class="tag tag-accent">current</span>' : ''}<span class="profile-when">${esc(when)}</span></button>`;
    let html = `<tbody class="profile${open ? ' open' : ''}"><tr class="profile-main"><td>${name}</td>${cells(combinePcts(p.pcts))}</tr>`;
    if (p.pcts.length > 1 || p.pcts[0]?.pct !== 100) {
      html += p.pcts.map((u) => `<tr class="profile-pct"><td>${num(u.pct, 0)}%</td>${cells(u)}</tr>`).join('');
    }
    if (open) {
      const shown = state.open.get(p.key);
      const options = [['all', 'All'], ...p.pcts.map((u) => [u.pct, `${num(u.pct, 0)}%`])];
      const seg = p.pcts.length > 1
        ? `<div class="seg" role="radiogroup" aria-label="Percentage">${options.map(([v, label]) => `<label class="seg-opt"><input type="radio" name="pct-${esc(p.key)}" value="${esc(v)}" data-key="${esc(p.key)}" ${String(v) === String(shown) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div>`
        : '';
      const toggles = `<div class="profile-series" role="group" aria-label="Lines">${Object.entries(SERIES).map(([k, label]) => `<label><input type="checkbox" data-series="${k}" ${state.series.has(k) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div>`;
      const label = esc(p.name || 'the profile');
      const ratio = state.series.has('ratio')
        ? `<h4 class="profile-chart-title">Sensitivity ratio (above 1: less sensitive, more basal)</h4><div class="profile-chart profile-ratio"><canvas aria-label="Sensitivity ratio under ${label} by hour of day"></canvas></div>`
        : '';
      const aiTest = testShown() ? testDetail(p) : '';
      html += `<tr class="profile-detail"><td colspan="${COLUMNS}">${seg}${toggles}<h4 class="profile-chart-title">Basal and boluses</h4><div class="profile-chart"><canvas aria-label="Basal of ${label} by hour of day"></canvas></div>${aiTest}${ratio}</td></tr>`;
    }
    html += '</tbody>';
    table.insertAdjacentHTML('beforeend', html);
    if (open) drawCharts(p, table.lastElementChild);
  }
}

// --- charts ----------------------------------------------------------------

const line = (label, data, color, extra = {}) => ({
  label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, spanGaps: true, ...extra,
});

/** A mean with its ± SD band (the area between a hidden lower line and the upper one). */
function bandSets (series, label, b, color) {
  return [
    ...(state.series.has('sd')
      ? [line(`${label} −SD`, b.low, 'transparent', { band: true }),
          line(`${label} +SD`, b.high, 'transparent', { band: true, fill: '-1', backgroundColor: color.replace(/[\d.]+\)$/, '0.18)') })]
      : []),
    line(`${label} (mean)`, b.mean, color, { tension: 0.25, pointRadius: 2, series, n: b.n }),
  ];
}

/** A line chart by hour of day; `unit` follows the values in tooltips. */
function hourChart (canvas, datasets, { unit, title, beginAtZero = true, digits = 2 }) {
  const text = cssColor('--color-neutral-700');
  return new Chart(canvas, {
    type: 'line',
    data: { labels: HOURS, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, font: { size: 11 } } },
        y: { beginAtZero, grid: { color: cssColor('--color-divider') }, ticks: { color: text, font: { size: 11 } }, title: { display: true, text: title, color: text } },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: text, boxWidth: 10, font: { size: 11 }, filter: (item, data) => !data.datasets[item.datasetIndex].band },
          // Switches the series off, band included, as its checkbox does.
          onClick: (e, item, legend) => {
            const series = legend.chart.data.datasets[item.datasetIndex].series;
            if (series) setSeries(series, false);
          },
        },
        tooltip: {
          filter: (item) => !item.dataset.band && item.raw != null,
          callbacks: {
            label: (c) => {
              const hours = c.dataset.n?.[c.dataIndex];
              return `${c.dataset.label}: ${num(c.raw, digits)}${unit ? ` ${unit}` : ''}${hours != null ? ` (${hours} h)` : ''}`;
            },
          },
        },
      },
    },
  });
}

function drawCharts (profile, body) {
  const s = chartSeries(profile, state.open.get(profile.key));
  const on = (k) => state.series.has(k);
  const profileColor = cssColor('--color-text');
  const basal = [
    ...(on('profile') ? [line('Profile 100%', s.profile, profileColor, { stepped: 'middle', series: 'profile' })] : []),
    ...(testShown() ? [line('AI Test', hourlyProfile(test.view.profile.basal), cssColor('--chart-test'), { stepped: 'middle', order: -1 })] : []),
    ...(on('pcts') ? s.adjusted.map((a) => line(`Profile ${a.pct}%`, a.values, profileColor, { stepped: 'middle', borderDash: [5, 4], borderWidth: 1.5, series: 'pcts' })) : []),
    ...(on('basal') ? bandSets('basal', 'Delivered basal', s.basal, cssColor('--chart-basal')) : []),
    ...(on('bolus') ? bandSets('bolus', 'SMB/bolus', s.bolus, cssColor('--chart-bolus')) : []),
  ];
  charts.set(profile.key, hourChart(body.querySelector('.profile-chart canvas'), basal, { unit: 'U/h', title: 'U/h' }));
  if (testShown()) drawTestDelta(profile, body);

  const canvas = body.querySelector('.profile-ratio canvas');
  if (!canvas) return;
  const ratio = [
    line('No change (1)', s.ratio.mean.map(() => 1), profileColor, { borderDash: [5, 4], borderWidth: 1 }),
    ...bandSets('ratio', 'Sensitivity ratio', s.ratio, cssColor('--chart-ratio')),
  ];
  charts.set(`${profile.key}:ratio`, hourChart(canvas, ratio, { title: 'Ratio', beginAtZero: false }));
}

// --- the AI Test profile -----------------------------------------------------

// The AI Test profile an agent wrote (GET /api/simulate/test-profile), shown
// on the expanded profiles when `show` is on; `status` is the message after
// a copy or delete, for the profile `key` it was made on.
const test = { view: null, show: storedTestShown(), isAdmin: false, status: null };

function storedTestShown () {
  try { return localStorage.getItem('loopk.profilesTest') === '1'; } catch { return false; }
}

const testShown = () => test.show && !!test.view?.profile;

function renderTestToggle () {
  const exists = !!test.view?.profile;
  $('testToggleWrap').hidden = !exists;
  $('testToggle').checked = test.show;
  $('testNote').hidden = !testShown();
  $('testAdminNote').hidden = !test.isAdmin;
}

/** The store entry of the profile named `name` (ISF, carb ratio, targets, DIA), or null. */
const storeOf = (name) => test.view?.stores?.find((s) => s.name === name) || null;

/** The AI Test part of an expanded profile: what it is, the difference chart and the buttons. */
function testDetail (p) {
  const t = test.view.profile;
  const other = storeOf(p.name);
  const label = esc(p.name || 'the profile');
  const when = new Date(t.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const meta = `AI Test${t.basedOn ? `, from ${t.basedOn}` : ''}, written ${when}${t.updatedBy ? ` by ${t.updatedBy}` : ''}. DIA ${num(t.dia, 1)} h${other ? ` (${p.name}: ${num(other.dia, 1)} h)` : ''}.${t.note ? `\n${t.note}` : ''}`;
  const status = test.status?.key === p.key ? `<span class="tag${test.status.warn ? ' tag-warn' : ''}" role="status">${esc(test.status.text)}</span>` : '';
  const adds = !other?.inStore;
  const follows = test.view.follows;
  const copy = !test.isAdmin || !p.name ? ''
    : follows ? `<span class="text-muted">This server follows ${esc(follows)} and changes no profiles. Copy there: an agent writes the AI Test with that server's MCP tools, and you copy it on its Profiles page.</span>`
    : `<button type="button" class="btn btn-primary" data-copy="${esc(p.name)}" data-adds="${adds}" data-key="${esc(p.key)}">Copy into ${label}</button>`
      + (adds ? `<span class="text-muted">AAPS has only reported switching to ${label}; its last profile store doesn't list it. Copying adds ${label} there.</span>` : '');
  const remove = test.isAdmin ? `<button type="button" class="btn btn-ghost" data-delete-test data-key="${esc(p.key)}">Delete AI Test</button>` : '';
  return `<h4 class="profile-chart-title">AI Test against ${label} (% above)</h4><p class="test-meta">${esc(meta)}</p>`
    + `<div class="profile-chart profile-delta"><canvas aria-label="How much the AI Test profile is above ${label} by hour of day"></canvas></div>`
    + `<div class="test-tools">${copy}${remove}${status}</div>`;
}

function drawTestDelta (profile, body) {
  const canvas = body.querySelector('.profile-delta canvas');
  if (!canvas) return;
  const d = testDelta(test.view.profile, profile.schedule, storeOf(profile.name));
  const step = { stepped: 'middle' };
  const sets = [
    line('No difference', d.basal.map(() => 0), cssColor('--color-text'), { borderDash: [5, 4], borderWidth: 1, order: 1 }),
    line('Basal', d.basal, cssColor('--chart-test'), { ...step, order: -1 }),
    line('ISF', d.isf, cssColor('--chart-ratio'), step),
    line('Carb ratio', d.ic, cssColor('--chart-carbs'), step),
    line('Low target', d.target, cssColor('--color-neutral-600'), { ...step, borderDash: [2, 3] }),
  ];
  charts.set(`${profile.key}:test`, hourChart(canvas, sets, { unit: '%', title: '% above', beginAtZero: false, digits: 0 }));
}

async function loadTestProfile () {
  try {
    test.view = await call('/api/simulate/test-profile');
  } catch (err) {
    test.view = null;
    console.error(err);
  }
  renderTestToggle();
}

function wireTestProfile () {
  $('testToggle').addEventListener('change', (e) => {
    test.show = e.target.checked;
    try { localStorage.setItem('loopk.profilesTest', test.show ? '1' : '0'); } catch { /* private mode */ }
    renderTestToggle();
    renderTable();
  });
  $('profiles').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    const remove = e.target.closest('[data-delete-test]');
    if (!copy && !remove) return;
    const key = (copy || remove).dataset.key;
    try {
      if (copy) {
        const to = copy.dataset.copy;
        const what = copy.dataset.adds === 'true' ? `Add ${to}, with the schedules and DIA of AI Test, to the profile store?` : `Replace the schedules and DIA of ${to} with those of AI Test?`;
        if (!confirm(`${what} This writes a new profile store, which AAPS receives.`)) return;
        await call('/api/simulate/test-profile/copy', { method: 'POST', body: { to, utcOffset: -new Date().getTimezoneOffset() } });
        test.status = { key, text: `Copied into ${to}. Check on the phone that the profile store arrived, then switch to ${to}.` };
      } else {
        if (!confirm('Delete the AI Test profile? Agents can write it again.')) return;
        await call('/api/simulate/test-profile', { method: 'DELETE' });
        test.status = null;
      }
      await loadTestProfile();
    } catch (err) {
      test.status = { key, text: err.message, warn: true };
    }
    renderTable();
  });
}

// --- data and controls -----------------------------------------------------

async function load () {
  setStatus('Loading…');
  try {
    const { from, to } = periodRange(state.period);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    state.data = await call(`/api/reports/profiles?from=${Math.floor(from)}&to=${Math.floor(to)}&tz=${encodeURIComponent(tz)}`);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  }
  renderTable();
}

function renderControls () {
  const p = state.period;
  $('period').innerHTML = Object.entries(PERIODS).map(([value, label]) => `<label class="seg-opt"><input type="radio" name="period" value="${esc(value)}" ${value === p.preset ? 'checked' : ''}>${esc(label)}</label>`).join('');
  $('customDates').hidden = p.preset !== 'custom';
  if (p.preset === 'custom') {
    $('periodFrom').value = p.from;
    $('periodTo').value = p.to;
  }
}

/** The last 30 days as dates, for a new custom period. */
function defaultDates () {
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date();
  return { from: day(new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29)), to: day(to) };
}

function wire () {
  $('period').addEventListener('change', (e) => {
    const preset = e.target.value;
    state.period = preset === 'custom' ? { preset, ...defaultDates() } : { preset };
    storePeriod();
    renderControls();
    load();
  });
  const customChanged = () => {
    const from = $('periodFrom').value;
    const to = $('periodTo').value;
    if (!from || !to || from > to) return;
    state.period = { preset: 'custom', from, to };
    storePeriod();
    load();
  };
  $('periodFrom').addEventListener('change', customChanged);
  $('periodTo').addEventListener('change', customChanged);
  $('profiles').addEventListener('click', (e) => {
    const key = e.target.closest('.profile-toggle')?.dataset.key;
    if (!key) return;
    if (state.open.has(key)) state.open.delete(key);
    else state.open.set(key, 'all');
    renderTable();
  });
  $('profiles').addEventListener('change', (e) => {
    if (e.target.dataset.series) {
      setSeries(e.target.dataset.series, e.target.checked);
      return;
    }
    const key = e.target.dataset.key;
    if (!key) return;
    state.open.set(key, e.target.value === 'all' ? 'all' : Number(e.target.value));
    renderTable();
  });
  // Colors come from the theme.
  new MutationObserver(renderTable).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

async function main () {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    return;
  }
  const session = await res.json();
  $('adminLink').hidden = !session.isAdmin;
  test.isAdmin = !!session.isAdmin;
  $('signOut').addEventListener('click', async () => {
    await clearCache().catch(() => {});
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });
  setupTheme($('themeToggle'));
  renderControls();
  wire();
  wireTestProfile();
  await loadTestProfile();
  await load();
}

main().catch((err) => setStatus(err.message, true));
