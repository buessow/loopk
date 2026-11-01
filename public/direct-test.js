// The direct read test page: exchanges an access token for a JWT on a
// Nightscout server and reads the last 24 hours of its API v3 from this
// browser (the server must send CORS headers). Nothing goes to loopk.
/* global Chart */

import { support, createPasskey, unlock, seal, open } from './passkey-vault.js';
import { useLocal } from './local.js';

const $ = (id) => document.getElementById(id);
const DAY = 24 * 3600 * 1000;
const MMOL = 18.0182;
// Its own vault, apart from the sign-in page's (loopk.vault).
const VAULT_KEY = 'loopk.directTestVault';
let chart = null;
// The server and token of the last read, for the simulator.
let last = null;

function log (text) {
  $('log').textContent += `${new Date().toLocaleTimeString()}  ${text}\n`;
}

const loadVault = () => {
  try { return JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { return null; }
};

/** fetch with a readable error when the browser blocks the answer (no CORS headers). */
async function get (url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`The browser could not read ${new URL(url).origin} (${err.message}): is it reachable, and does it send CORS headers (ENABLE with cors)?`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}${body?.message ? ` (${body.message})` : ''}`);
  return body?.result ?? body;
}

async function read ({ url, token }) {
  const base = url.replace(/\/$/, '');
  const t = performance.now();
  const auth = await get(`${base}/api/v2/authorization/request/${encodeURIComponent(token)}`);
  log(`Token accepted: subject ${auth.sub}, may ${JSON.stringify(auth.permissionGroups.flat().filter(Boolean))}`);
  const headers = { Authorization: `Bearer ${auth.token}` };
  const from = Date.now() - DAY;
  const search = (collection, params) => get(`${base}/api/v3/${collection}?${new URLSearchParams(params)}`, headers);
  const [entries, treatments, [status]] = await Promise.all([
    search('entries', { 'date$gte': from, sort: 'date', limit: 1000, fields: 'date,sgv,direction,type' }),
    search('treatments', { 'date$gte': from, sort: 'date', limit: 1000, fields: 'date,eventType,insulin,carbs,isSMB' }),
    search('devicestatus', { sort$desc: 'date', limit: 1, fields: 'date,openaps' }),
  ]);
  const ms = Math.round(performance.now() - t);
  log(`Read ${entries.length} readings, ${treatments.length} treatments and the newest device status in ${ms} ms`);
  return { base, entries: entries.filter((e) => e.sgv > 0), treatments, status, ms };
}

const mmol = (sgv) => (sgv / MMOL).toFixed(1);
const ARROWS = { DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗', Flat: '→', FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊' };

function show ({ base, entries, treatments, status, ms }) {
  $('result').hidden = false;
  $('summary').textContent = `${entries.length} readings and ${treatments.length} treatments of the last 24 hours, read from ${base} by this browser in ${ms} ms.`;
  const last = entries.at(-1);
  $('now').textContent = last ? `${mmol(last.sgv)} ${ARROWS[last.direction] ?? ''}` : '–';
  $('nowAge').textContent = last ? `${Math.round((Date.now() - last.date) / 60000)} min ago` : '';
  const inRange = entries.filter((e) => e.sgv >= 70 && e.sgv <= 180).length;
  $('tir').textContent = entries.length ? `${Math.round((100 * inRange) / entries.length)} %` : '–';
  $('mean').textContent = entries.length ? mmol(entries.reduce((s, e) => s + e.sgv, 0) / entries.length) : '–';
  const iob = status?.openaps?.iob;
  const iobValue = Array.isArray(iob) ? iob[0]?.iob : iob?.iob;
  const cob = status?.openaps?.suggested?.COB ?? status?.openaps?.enacted?.COB;
  $('iob').textContent = iobValue == null ? '–' : `${iobValue.toFixed(2)} U / ${cob == null ? '–' : Math.round(cob)} g`;
  const insulin = treatments.reduce((s, x) => s + (x.insulin || 0), 0);
  const carbs = treatments.reduce((s, x) => s + (x.carbs || 0), 0);
  $('totals').textContent = `${insulin.toFixed(1)} U / ${Math.round(carbs)} g`;
  draw(entries, treatments);
}

function draw (entries, treatments) {
  const css = getComputedStyle(document.documentElement);
  const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const accent = color('--color-accent', '#1c7ed6');
  const muted = color('--color-text-muted', '#888');
  const bolus = color('--chart-test', '#e03131');
  const time = (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  chart?.destroy();
  chart = new Chart($('chart'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Glucose (mmol/L)', data: entries.map((e) => ({ x: e.date, y: e.sgv / MMOL })), borderColor: accent, backgroundColor: accent, pointRadius: 1.5, showLine: true, borderWidth: 1 },
        { label: 'Bolus / SMB (U)', data: treatments.filter((x) => x.insulin > 0).map((x) => ({ x: x.date, y: x.insulin })), yAxisID: 'u', backgroundColor: bolus, pointStyle: 'triangle', pointRadius: 4 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { type: 'linear', min: Date.now() - DAY, max: Date.now(), ticks: { callback: time, color: muted, maxTicksLimit: 8 } },
        y: { min: 2, suggestedMax: 15, title: { display: true, text: 'mmol/L', color: muted }, ticks: { color: muted } },
        u: { position: 'right', min: 0, suggestedMax: 8, grid: { display: false }, title: { display: true, text: 'U', color: muted }, ticks: { color: muted } },
      },
      plugins: { legend: { labels: { color: muted } }, tooltip: { callbacks: { title: (items) => time(items[0].parsed.x) } } },
    },
  });
}

async function run (credentials) {
  $('go').disabled = true;
  try {
    show(await read(credentials));
    last = credentials;
    return true;
  } catch (err) {
    log(err.message);
    return false;
  } finally {
    $('go').disabled = false;
  }
}

$('connect').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const credentials = { url: $('url').value.trim(), token: $('token').value.trim() };
  if (!(await run(credentials)) || !$('keep').checked) return;
  try {
    const made = await createPasskey({ name: `loopk direct ${new URL(credentials.url).host}` });
    const secret = made.secret ?? (await unlock(made.credentialId)).secret;
    localStorage.setItem(VAULT_KEY, JSON.stringify({ credentialId: made.credentialId, sealed: await seal(secret, JSON.stringify(credentials)) }));
    $('passkey').hidden = false;
    log('Address and token kept in the passkey, encrypted in this browser');
  } catch (err) {
    log(`Not kept in a passkey: ${err.message}`);
  }
});

$('passkey').addEventListener('click', async () => {
  const vault = loadVault();
  try {
    const { secret } = await unlock(vault.credentialId);
    const credentials = JSON.parse(await open(secret, vault.sealed));
    $('url').value = credentials.url;
    await run(credentials);
  } catch (err) {
    log(err.name === 'NotAllowedError' ? 'The passkey was not used' : err.message);
  }
});

$('simulate').addEventListener('click', () => {
  useLocal(last);
  location.href = '/simulate';
});

support().then((can) => { $('keepField').hidden = !(can.webauthn && can.secureContext); }).catch(() => {});
$('passkey').hidden = !loadVault()?.sealed;
