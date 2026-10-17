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
}

async function loadTokens () {
  const list = await call('GET', '/api/v2/authorization/subjects');
  $('tokens').innerHTML = list.map((s) => `<tr>
    <td>${esc(s.name)}</td><td>${s.canWrite ? 'Read &amp; write' : 'Read'}</td>
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
    const canWrite = document.querySelector('input[name=tokenAccess]:checked').value === 'write';
    await call('POST', '/api/v2/authorization/subjects', { name: $('tokenName').value, canWrite });
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

async function main () {
  const session = await call('GET', '/api/session');
  if (!session.isAdmin) {
    document.querySelectorAll('section').forEach((s) => { s.hidden = true; });
    throw new Error('Only admins can manage access.');
  }
  await Promise.all([loadTokens(), loadUsers()]);
}

main().catch(showError);
