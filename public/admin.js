import { localCredentials, request } from './local.js';
import { setupTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function call (method, path, body) {
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
  if (!res.ok) throw new Error(json.message || `${res.status}`);
  return json;
}

function showError (err) {
  $('error').textContent = err.message;
  $('error').hidden = false;
  $('error').scrollIntoView({ block: 'nearest' });
}

let tokenNames = [];

async function loadTokens () {
  const list = await call('GET', '/api/v2/authorization/subjects');
  tokenNames = list.map((s) => s.name);
  $('tokens').innerHTML = list.map((s) => `<tr>
    <td>${esc(s.name)}</td><td>${s.canUploadModel ? 'Upload model' : s.canWrite ? 'Read &amp; write' : 'Read'}</td>
    <td class="mono">${esc(s.accessToken)}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost" data-copy-token="${esc(s.accessToken)}" aria-label="Copy the token of ${esc(s.name)}">Copy</button><button class="btn btn-ghost" data-del-token="${esc(s._id)}" data-name="${esc(s.name)}">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="4" class="text-muted">No tokens yet.</td></tr>';
}

/** Copies text; the Clipboard API needs a secure context, so fall back to a selection. */
async function copyText (text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copying is not supported in this browser');
}

async function loadUsers () {
  const [list, session] = await Promise.all([call('GET', '/api/admin/users'), call('GET', '/api/session')]);
  const me = session.user.email;
  $('users').innerHTML = list.map((u) => `<tr>
    <td>${esc(u.email)}</td><td>${esc(u.name)}</td>
    <td><input type="checkbox" data-admin-user="${esc(u.email)}" aria-label="Admin" ${u.isAdmin ? 'checked' : ''} ${u.email === me ? 'disabled title="You cannot remove your own admin rights"' : ''}></td>
    <td>${u.last_login ? esc(new Date(u.last_login).toLocaleString()) : '–'}</td>
    <td style="text-align:right">${u.email === me ? '' : `<button class="btn btn-ghost" data-del-user="${esc(u.email)}">Remove</button>`}</td>
  </tr>`).join('');
}

$('tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const access = document.querySelector('input[name=tokenAccess]:checked').value;
    await call('POST', '/api/v2/authorization/subjects', {
      name: $('tokenName').value, canWrite: access === 'write', canUploadModel: access === 'model',
    });
    $('tokenName').value = '';
    await loadTokens();
  } catch (err) { showError(err); }
});

// --- a token and command for an MCP agent -------------------------------------

/** How each agent adds this server's MCP endpoint with the token, at user scope. */
function mcpCommands (origin, accessToken) {
  const url = `${origin}/mcp?token=${accessToken}`;
  return [
    ['Claude Code', `claude mcp add --scope user --transport http loopk '${url}'`],
    ['Codex CLI (ChatGPT)', `codex mcp add loopk --url '${url}'`],
    ['Gemini CLI', `gemini mcp add --scope user --transport http loopk '${url}'`],
    ['MCP URL (ChatGPT app, other clients)', url],
  ];
}

/**
 * How each agent runs loopk's MCP server itself with the variables `env`
 * (src/mcp/local.js: LOOPK_URL and LOOPK_TOKEN, or NIGHTSCOUT_URL and
 * NIGHTSCOUT_TOKEN), from the package at `pkg`, which starts the current
 * version (src/mcp/latest.js).
 */
function localMcpCommands (env, pkg) {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const config = { mcpServers: { loopk: { command: 'npx', args: ['-y', pkg], env } } };
  return [
    ['Claude Code', `claude mcp add --scope user loopk ${pairs.map((p) => `-e ${p}`).join(' ')} -- npx -y ${pkg}`],
    ['Codex CLI (ChatGPT)', `codex mcp add loopk ${pairs.map((p) => `--env ${p}`).join(' ')} -- npx -y ${pkg}`],
    ['Gemini CLI', `gemini mcp add --scope user loopk ${pairs.map((p) => `-e ${p}`).join(' ')} -- npx -y ${pkg}`],
    ['Claude Desktop, other clients (JSON configuration)', JSON.stringify(config)],
  ];
}

// Where the agent's MCP runs, remembered in this browser.
const MCP_WHERE = 'loopk.mcpWhere';
const mcpWhere = () => document.querySelector('input[name=mcpWhere]:checked').value;
let agentToken = null;

async function showMcpCommands () {
  const agent = mcpWhere() === 'agent';
  $('mcpServerText').hidden = agent;
  $('mcpAgentText').hidden = !agent;
  if (!agentToken) return;
  renderMcpCommands(agent
    ? localMcpCommands({ LOOPK_URL: location.origin, LOOPK_TOKEN: agentToken }, `${location.origin}/mcp/local.tgz`)
    : mcpCommands(location.origin, agentToken));
}

/**
 * In the browser (the static server): the agent reads the Nightscout server
 * this tab signed in to, with its token. latest.js asks loopk.cc for the
 * current package unless LOOPK_SITE names this site.
 */
function showStaticMcpCommands () {
  const { url, token } = localCredentials();
  const env = { NIGHTSCOUT_URL: url, NIGHTSCOUT_TOKEN: token, ...(location.origin === 'https://loopk.cc' ? {} : { LOOPK_SITE: location.origin }) };
  renderMcpCommands(localMcpCommands(env, `${location.origin}/mcp/local.tgz`));
}

function renderMcpCommands (commands) {
  $('mcpResult').innerHTML = commands.map(([label, text], i) => `<div class="field">
      <label for="mcpCommand${i}">${esc(label)}</label>
      <div class="row" style="align-items:stretch;flex-wrap:nowrap"><input class="input mono" id="mcpCommand${i}" readonly value="${esc(text)}" style="flex:1;min-width:0"><button class="btn btn-secondary" type="button" data-copy-token="${esc(text)}">Copy</button></div>
    </div>`).join('');
  $('mcpResult').hidden = false;
  $('mcpResult').style.display = 'flex';
}

try {
  const saved = localStorage.getItem(MCP_WHERE);
  const input = document.querySelector(`input[name=mcpWhere][value="${saved}"]`);
  if (input) input.checked = true;
} catch { /* no storage: the default */ }
for (const input of document.querySelectorAll('input[name=mcpWhere]')) {
  input.addEventListener('change', () => {
    try { localStorage.setItem(MCP_WHERE, mcpWhere()); } catch { /* not remembered */ }
    showMcpCommands().catch(showError);
  });
}

$('mcpCreate').addEventListener('click', async () => {
  $('error').hidden = true;
  try {
    let name = 'agent';
    for (let i = 2; tokenNames.includes(name); i++) name = `agent-${i}`;
    const s = await call('POST', '/api/v2/authorization/subjects', { name, canWrite: false, canUploadModel: false, notes: 'MCP agent' });
    agentToken = s.accessToken;
    await showMcpCommands();
    await loadTokens();
  } catch (err) { showError(err); }
});

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const isAdmin = document.querySelector('input[name=userAdmin]:checked').value === 'yes';
    await call('POST', '/api/admin/users', { email: $('userEmail').value, isAdmin });
    $('userEmail').value = '';
    await loadUsers();
  } catch (err) { showError(err); }
});

document.addEventListener('change', async (e) => {
  const box = e.target.closest('[data-admin-user]');
  if (!box) return;
  try {
    await call('POST', '/api/admin/users', { email: box.dataset.adminUser, isAdmin: box.checked });
  } catch (err) {
    box.checked = !box.checked;
    showError(err);
  }
});

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy-token]');
  if (c) {
    try {
      await copyText(c.dataset.copyToken);
      c.textContent = 'Copied';
      setTimeout(() => { c.textContent = 'Copy'; }, 1500);
    } catch (err) { showError(err); }
    return;
  }
  const t = e.target.closest('[data-del-token]');
  const u = e.target.closest('[data-del-user]');
  try {
    if (t && confirm(`Delete token “${t.dataset.name}”? Devices using it stop syncing.`)) {
      await call('DELETE', `/api/v2/authorization/subjects/${encodeURIComponent(t.dataset.delToken)}`);
      await loadTokens();
    }
    if (u && confirm(`Remove ${u.dataset.delUser}?`)) {
      await call('DELETE', `/api/admin/users/${encodeURIComponent(u.dataset.delUser)}`);
      await loadUsers();
    }
  } catch (err) { showError(err); }
});

// --- following a Nightscout server ---------------------------------------

const COLLECTION_NAMES = { entries: 'Glucose', treatments: 'Treatments', devicestatus: 'Loop status', profile: 'Profiles', food: 'Food', heartrate: 'Heart rate' };
let follow = null;
let followTimer = null;

function since (t) {
  const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

function renderFollow () {
  const f = follow;
  let html;
  if (!f.url) {
    html = '<span class="tag tag-neutral">Not following</span> This server takes uploads from AAPS directly.';
  } else if (!f.following) {
    html = `<span class="tag tag-neutral">Stopped</span> Not following <span class="mono">${esc(f.url)}</span>. This server takes uploads from AAPS directly.`;
  } else {
    const st = f.status || {};
    const state = st.lastError
      ? `<span class="tag tag-warn">Error</span> ${esc(st.lastError.message)}`
      : st.syncing ? '<span class="tag tag-accent">Copying…</span>'
        : st.lastSync ? `<span class="tag tag-accent">Up to date</span> checked ${since(st.lastSync)}` : '<span class="tag tag-accent">Starting…</span>';
    html = `Following <span class="mono">${esc(f.url)}</span> · ${state}${st.copied ? ` · ${st.copied.toLocaleString()} copied since start` : ''}`;
  }
  if (f.source === 'environment') html += '<br><span class="text-muted">Set by FOLLOW_URL on the server; saving here replaces it.</span>';
  else if (f.updatedBy) html += `<br><span class="text-muted">Set by ${esc(f.updatedBy)} ${since(f.updatedAt)}.</span>`;
  $('followStatus').innerHTML = html;

  if (document.activeElement !== $('followUrl') && !$('followUrl').dataset.edited) $('followUrl').value = f.url || '';
  $('followToken').placeholder = f.tokenSet ? 'saved (enter a new one to change it)' : 'readable-0123456789abcdef';
  $('followToken').required = !f.tokenSet;
  $('followSave').textContent = f.following ? 'Check and save' : 'Check and follow';
  $('followStop').hidden = !f.following || f.source !== 'settings';
  $('followRemove').hidden = f.source !== 'settings';

  $('followTableWrap').hidden = !f.url;
  $('followTable').innerHTML = f.collections.map((c) => `<tr><td>${COLLECTION_NAMES[c.collection] || esc(c.collection)}</td><td>${c.copiedUntil ? `${esc(new Date(c.copiedUntil).toLocaleString())} <span class="text-muted">(${since(c.copiedUntil)})</span>` : '<span class="text-muted">not yet</span>'}</td></tr>`).join('');

  // Refresh while copying, so progress shows.
  clearTimeout(followTimer);
  if (f.following) followTimer = setTimeout(() => loadFollow().catch(showError), f.status?.syncing ? 3000 : 30000);
}

async function loadFollow () {
  follow = await call('GET', '/api/admin/follow');
  renderFollow();
}

$('followUrl').addEventListener('input', () => { $('followUrl').dataset.edited = '1'; });

$('followForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;
  const btn = $('followSave');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    follow = await call('PUT', '/api/admin/follow', { url: $('followUrl').value, token: $('followToken').value || undefined, enabled: true });
    $('followToken').value = '';
    delete $('followUrl').dataset.edited;
    renderFollow();
  } catch (err) {
    btn.textContent = label;
    showError(err);
  } finally {
    btn.disabled = false;
  }
});

$('followStop').addEventListener('click', async () => {
  if (!confirm('Stop following? This server then takes uploads from AAPS again.')) return;
  try {
    follow = await call('PUT', '/api/admin/follow', { url: follow.url, enabled: false });
    renderFollow();
  } catch (err) { showError(err); }
});

$('followRemove').addEventListener('click', async () => {
  if (!confirm('Remove the Nightscout server and its access token from this server?')) return;
  try {
    follow = await call('DELETE', '/api/admin/follow');
    $('followUrl').value = follow.url || '';
    renderFollow();
  } catch (err) { showError(err); }
});

// --- sport mode ---------------------------------------------------------------

const MGDL_PER_MMOL = 18.0182;
let sport = null;

function renderSport () {
  const c = sport.config;
  const mmol = $('sportUnits').value === 'mmol/L';
  const target = (v) => (mmol ? `${(v / MGDL_PER_MMOL).toFixed(1)} mmol/L` : `${Math.round(v)} mg/dL`);
  $('sportStatus').innerHTML = c
    ? `<span class="tag tag-accent">On</span> Sport switches to ${c.profile ? esc(c.profile) : 'the profile in use'} at ${c.percentage}%${c.target != null ? `, temp target ${target(c.target)}` : ', no temp target'}.`
      + (c.updatedBy ? `<br><span class="text-muted">Set by ${esc(c.updatedBy)} ${since(c.updatedAt)}.</span>` : '')
    : '<span class="tag tag-neutral">Off</span> Not set up: the glucose page has no Sport button.';
  $('sportProfile').innerHTML = ['<option value="">Profile in use</option>', ...sport.profiles.map((n) => `<option>${esc(n)}</option>`)].join('');
  if (c) {
    $('sportPct').value = c.percentage;
    $('sportTarget').value = c.target == null ? '' : mmol ? (c.target / MGDL_PER_MMOL).toFixed(1) : Math.round(c.target);
    $('sportProfile').value = c.profile || '';
  }
  $('sportRemove').hidden = !c;
}

async function loadSport () {
  sport = await call('GET', '/api/admin/sport');
  $('sportUnits').value = /^mg/i.test(sport.units || '') ? 'mg/dL' : 'mmol/L';
  if (!sport.config) $('sportTarget').value = $('sportUnits').value === 'mmol/L' ? '7.8' : '140';
  renderSport();
}

$('sportUnits').addEventListener('change', () => {
  const v = Number($('sportTarget').value);
  if ($('sportTarget').value && v) $('sportTarget').value = $('sportUnits').value === 'mmol/L' ? (v / MGDL_PER_MMOL).toFixed(1) : Math.round(v * MGDL_PER_MMOL);
});

$('sportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;
  const raw = $('sportTarget').value.trim();
  const target = raw ? Number(raw) * ($('sportUnits').value === 'mmol/L' ? MGDL_PER_MMOL : 1) : null;
  try {
    sport = await call('PUT', '/api/admin/sport', {
      percentage: Number($('sportPct').value),
      target: target == null ? null : Math.round(target * 10) / 10,
      profile: $('sportProfile').value || null,
    });
    renderSport();
  } catch (err) { showError(err); }
});

$('sportRemove').addEventListener('click', async () => {
  if (!confirm('Remove sport mode? The Sport button disappears from the glucose page; a running sport mode stays on until it ends.')) return;
  try {
    sport = await call('DELETE', '/api/admin/sport');
    renderSport();
  } catch (err) { showError(err); }
});

async function main () {
  const session = await call('GET', '/api/session');
  if (!session.isAdmin) {
    document.querySelectorAll('section').forEach((s) => { s.hidden = true; });
    throw new Error('Only admins can manage access.');
  }
  if (session.inBrowser) {
    // No server: tokens and people are Nightscout's, and there is nothing to follow into.
    for (const id of ['tokensSection', 'usersSection', 'followSection', 'mcpWhereField', 'mcpServerText', 'mcpAgentText', 'mcpCreateRow']) $(id).hidden = true;
    $('mcpStaticText').hidden = false;
    showStaticMcpCommands();
    await loadSport();
    return;
  }
  await Promise.all([showMcpCommands(), loadTokens(), loadUsers(), loadFollow(), loadSport()]);
}

setupTheme($('themeToggle'));
main().catch(showError);
