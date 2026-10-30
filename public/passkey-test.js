// The passkey test page (passkey-test.html): creates a passkey, encrypts a
// made-up token with its PRF secret and decrypts it again, logging each step
// so the result on a device can be copied and reported.

import { createPasskey, loadVault, open, saveVault, seal, support, unlock } from './passkey-vault.js';

const $ = (id) => document.getElementById(id);
const t0 = performance.now();

function log (text) {
  $('log').textContent += `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${text}\n`;
}

function result (id, ok, text) {
  $(id).className = ok ? 'pk-ok' : 'pk-bad';
  $(id).textContent = text;
}

const describe = (err) => `${err.name || 'Error'}: ${err.message}`;

async function run (id, label, fn) {
  log(`${label} …`);
  try {
    const text = await fn();
    result(id, true, text);
    log(`${label}: ${text}`);
  } catch (err) {
    result(id, false, describe(err));
    log(`${label} failed: ${describe(err)}`);
  }
}

async function showSupport () {
  const s = await support();
  const yes = (v) => (v == null ? 'unknown' : v ? 'yes' : 'no');
  $('support').innerHTML = '';
  $('support').append(...[
    `WebAuthn: ${yes(s.webauthn)}`,
    `Secure context (https or localhost): ${yes(s.secureContext)}`,
    `Built-in authenticator (Face ID, fingerprint, PIN): ${yes(s.platform)}`,
    `PRF, as the browser reports it: ${yes(s.prf)}${s.capabilities ? '' : ' (this browser does not report its capabilities; step 1 shows it)'}`,
  ].map((line) => Object.assign(document.createElement('div'), { textContent: line })));
  log(`${navigator.userAgent}`);
  log(`site ${location.host}; support ${JSON.stringify({ ...s, capabilities: undefined })}`);
  const vault = loadVault();
  if (vault) log(`stored vault: passkey ${vault.credentialId.slice(0, 12)}…, ${vault.sealed ? 'token encrypted' : 'no token yet'}`);
}

function wire () {
  $('create').addEventListener('click', () => run('createStatus', 'Create passkey', async () => {
    const c = await createPasskey({ name: 'loopk token (test)' });
    saveVault({ credentialId: c.credentialId });
    log(`passkey ${c.credentialId.slice(0, 12)}…, ${c.authenticator || 'attachment unknown'}, PRF enabled ${c.prfEnabled}, secret at creation ${c.secret ? 'yes' : 'no'}`);
    if (c.prfEnabled === false) throw new Error('Passkey created, but its password manager does not support PRF');
    return c.prfEnabled ? 'Passkey created, PRF on' : 'Passkey created; PRF unknown until step 2';
  }));

  $('seal').addEventListener('click', () => run('sealStatus', 'Encrypt', async () => {
    const vault = loadVault();
    if (!vault) throw new Error('Create a passkey first (step 1)');
    const { secret } = await unlock(vault.credentialId);
    const sealed = await seal(secret, $('token').value);
    saveVault({ ...vault, sealed });
    log(`encrypted ${$('token').value.length} characters into ${sealed.data.length} (kept in this browser)`);
    return 'Encrypted and kept in this browser';
  }));

  $('open').addEventListener('click', () => run('openStatus', 'Decrypt', async () => {
    const vault = loadVault();
    if (!vault?.sealed) throw new Error('Nothing encrypted yet (step 2)');
    const { secret } = await unlock(vault.credentialId);
    const text = await open(secret, vault.sealed);
    return `Decrypted: ${text}`;
  }));

  $('forget').addEventListener('click', () => {
    saveVault(null);
    log('stored vault forgotten (the passkey stays in your password manager)');
  });

  $('copyLog').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('log').textContent);
      $('copyLog').textContent = 'Copied';
    } catch (err) {
      log(`copy failed: ${describe(err)}`);
    }
  });
}

wire();
showSupport().catch((err) => log(`support check failed: ${describe(err)}`));
