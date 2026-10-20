const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `${res.status}`);
  return json;
}

function showError (err) {
  $('error').textContent = err.message;
  $('error').hidden = false;
  $('error').scrollIntoView({ block: 'nearest' });
}

async function loadTokens () {
  const list = await call('GET', '/api/v2/authorization/subjects');
  $('tokens').innerHTML = list.map((s) => `<tr>
    <td>${esc(s.name)}</td><td>${s.canUploadModel ? 'Upload model' : s.canWrite ? 'Read &amp; write' : 'Read'}</td>
    <td class="mono">${esc(s.accessToken)}</td>
    <td style="text-align:right"><button class="btn btn-ghost" data-del-token="${esc(s._id)}" data-name="${esc(s.name)}">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="4" class="text-muted">No tokens yet.</td></tr>';
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

async function main () {
  const session = await call('GET', '/api/session');
  if (!session.isAdmin) {
    document.querySelectorAll('section').forEach((s) => { s.hidden = true; });
    throw new Error('Only admins can manage access.');
  }
  await Promise.all([loadTokens(), loadUsers(), loadFollow()]);
}

main().catch(showError);
