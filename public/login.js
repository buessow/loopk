// The sign-in page. On the full server: Google. On the static server
// (STATIC): the Nightscout address and an access token, checked by reading
// the server from this browser (local.js), and kept in a passkey if the
// browser can (passkey-vault.js), so a later visit only needs the passkey.
// The token goes to the Nightscout server only.

import { STATIC, dropLocal, localCredentials, request, useLocal } from './local.js';
import { createPasskey, loadVault, open, saveVault, seal, support, unlock } from './passkey-vault.js';

const $ = (id) => document.getElementById(id);
const messages = {
  denied: 'This Google account has no access. Ask an administrator to add it.',
  state: 'The sign-in attempt expired. Please try again.',
  unverified: 'This Google account has no verified email address.',
  access_denied: 'Sign-in was cancelled.',
};

function showError (text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

function googleSignIn () {
  const err = new URLSearchParams(location.search).get('error');
  if (err) showError(messages[err] || `Sign-in failed (${err}).`);
  fetch('/api/session').then((r) => r.json()).then((s) => {
    if (s.user) location.href = '/';
    else if (s.googleConfigured === false) showError('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }).catch(() => {});
}

/** The address as typed, as an origin with a path: https:// unless it says otherwise, no trailing slash. */
function address (text) {
  const t = text.trim();
  const url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** Signs this tab in with `credentials`, checked by reading the server; throws a readable error. */
async function connect (credentials) {
  useLocal(credentials);
  const res = await request('/api/session');
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  dropLocal();
  const message = body.message || `HTTP ${res.status}`;
  if (/Failed to fetch|NetworkError|Load failed|could not read/i.test(message)) {
    throw new Error(`The browser could not read ${credentials.url}: is the address right, and does Nightscout allow it (ENABLE with cors)?`);
  }
  throw new Error(message);
}

/** Keeps the address and token in a new passkey; throws if the browser cannot. */
async function keep (credentials) {
  const host = new URL(credentials.url).host;
  const made = await createPasskey({ name: `loopk ${host}` });
  const secret = made.secret ?? (await unlock(made.credentialId)).secret;
  saveVault({ credentialId: made.credentialId, host, sealed: await seal(secret, JSON.stringify(credentials)) });
}

function staticSignIn () {
  if (localCredentials()) location.href = '/';
  for (const id of ['google', 'googleNote']) $(id).hidden = true;
  $('nsForm').hidden = false;
  const vault = loadVault();
  if (vault?.sealed) {
    $('vaultRow').hidden = false;
    $('vaultHost').textContent = vault.host || 'Your Nightscout server';
  }
  support().then((can) => { $('keepField').hidden = !(can.webauthn && can.secureContext); }).catch(() => {});

  $('unlock').addEventListener('click', async () => {
    showError('');
    try {
      const { secret } = await unlock(vault.credentialId);
      await connect(JSON.parse(await open(secret, vault.sealed)));
      location.href = '/';
    } catch (err) {
      showError(err.name === 'NotAllowedError' ? 'The passkey was not used.' : err.message);
    }
  });
  $('forget').addEventListener('click', () => {
    saveVault(null);
    $('vaultRow').hidden = true;
  });

  let signedIn = false;
  $('nsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (signedIn) {
      location.href = '/';
      return;
    }
    showError('');
    $('nsGo').disabled = true;
    try {
      let url;
      try {
        url = address($('nsUrl').value);
      } catch {
        throw new Error('That is not a web address.');
      }
      const credentials = { url, token: $('nsToken').value.trim() };
      await connect(credentials);
      if (!$('keepField').hidden && $('keep').checked) {
        try {
          await keep(credentials);
        } catch (err) {
          // Signed in all the same, for this tab.
          console.warn('loopk: the token is not kept in a passkey', err);
          showError(`Signed in, but the token is not kept in a passkey (${err.name === 'NotAllowedError' ? 'the passkey was not made' : err.message}): you will enter it again in a new tab.`);
          signedIn = true;
          $('nsGo').textContent = 'Continue';
          $('nsGo').disabled = false;
          return;
        }
      }
      location.href = '/';
    } catch (err) {
      showError(err.message);
      $('nsGo').disabled = false;
    }
  });
}

if (STATIC) staticSignIn();
else googleSignIn();
