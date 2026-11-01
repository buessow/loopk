// The sign-in page: Google, or, on a server that keeps nothing, an access
// token on the Nightscout server. The token can be kept in a passkey on this
// device (passkey-vault.js), which gives it back after Face ID, a
// fingerprint or the device PIN; the server gets it on each sign-in only.

import { support, createPasskey, unlock, seal, open, loadVault, saveVault } from './passkey-vault.js';

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

const err = new URLSearchParams(location.search).get('error');
if (err) showError(messages[err] || `Sign-in failed (${err}).`);

/** Signs in with { url, token }; throws the server's reason. */
async function signIn (credentials) {
  const res = await fetch('/auth/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

async function keepInPasskey (credentials) {
  const made = await createPasskey({ name: `loopk ${new URL(credentials.url).host}` });
  // Some authenticators give the secret only when the passkey is used.
  const secret = made.secret ?? (await unlock(made.credentialId)).secret;
  saveVault({ credentialId: made.credentialId, sealed: await seal(secret, JSON.stringify(credentials)) });
}

async function setupTokenSignIn (session) {
  $('google').hidden = true;
  $('googleNote').hidden = true;
  $('tokenSignIn').hidden = false;
  const fixed = session.nightscout;
  if (fixed) $('tokenNote').textContent = `This server keeps nothing: it shows the data of ${fixed} with an access token there.`;
  $('urlField').hidden = !!fixed;
  $('nsUrl').required = !fixed;

  const can = await support().catch(() => ({}));
  $('keepField').hidden = !(can.webauthn && can.secureContext);
  const vault = loadVault();
  const kept = vault?.sealed && vault.credentialId;
  $('passkeySignIn').hidden = !kept;
  $('forget').hidden = !kept;

  $('passkeySignIn').addEventListener('click', async () => {
    showError('');
    try {
      const { secret } = await unlock(vault.credentialId);
      await signIn(JSON.parse(await open(secret, vault.sealed)));
      location.href = '/';
    } catch (e) {
      showError(e.name === 'NotAllowedError' ? 'The passkey was not used.' : `${e.message} Enter a token to sign in.`);
    }
  });

  $('forget').addEventListener('click', () => {
    saveVault(null);
    $('passkeySignIn').hidden = true;
    $('forget').hidden = true;
  });

  $('tokenForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showError('');
    $('tokenSubmit').disabled = true;
    try {
      const { url } = await signIn({ url: fixed || $('nsUrl').value, token: $('nsToken').value });
      if ($('keep').checked) {
        try {
          await keepInPasskey({ url, token: $('nsToken').value.trim() });
        } catch (e) {
          showError(`Signed in, but the token is not kept in a passkey: ${e.message}`);
          setTimeout(() => { location.href = '/'; }, 4000);
          return;
        }
      }
      location.href = '/';
    } catch (e) {
      showError(e.message);
      $('tokenSubmit').disabled = false;
    }
  });
}

fetch('/api/session').then((r) => r.json()).then((s) => {
  if (s.user) location.href = '/';
  else if (s.keepsNothing) setupTokenSignIn(s);
  else if (s.googleConfigured === false) showError('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
}).catch(() => {});
