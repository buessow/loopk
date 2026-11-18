// loopk paired with AAPS in this browser: AAPS 4.0's client control
// (src/clientcontrol), with the pairing secret sealed by the person's passkey
// and kept only here, never on a server. Each change asks for the passkey,
// opens the secret into a key for that change, and drops it.
//
// The commands go to the Nightscout server AAPS uploads to: the one this tab
// reads (local.js), or else loopk's own server, with the session.

import { ClientControl, ControlError } from '../src/clientcontrol/client.js';
import { NightscoutClient } from '../src/sync/client.js';
import { STATIC, localCredentials } from './local.js';
import { createPasskey, loadVault, open, seal, support, unlock } from './passkey-vault.js';
import { fromHex, toHex } from '../src/clientcontrol/crypto.js';

const KEY = 'loopk.aaps';
// Another key from the passkey's secret than the token vault's.
const INFO = 'loopk aaps pairing';

function loadRecord () {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

/** The pairing record in localStorage, behind a Web Lock so no two tabs use one counter. */
const store = {
  credentialId: null,
  load: loadRecord,
  save (rec) {
    if (!rec) return localStorage.removeItem(KEY);
    localStorage.setItem(KEY, JSON.stringify({ ...rec, credentialId: rec.credentialId || this.credentialId }));
  },
  lock: (fn) => (navigator.locks ? navigator.locks.request(KEY, fn) : fn()),
};

/** Where AAPS's Nightscout is from this tab: { url, token }, or null on the static pages without one. */
function server () {
  const local = localCredentials();
  if (local) return local;
  return STATIC ? null : { url: location.origin, token: null };
}

function control () {
  const at = server();
  if (!at) throw new ControlError('Sign in with your Nightscout address and a token first.');
  return { cc: new ClientControl({ client: new NightscoutClient({ url: at.url, token: at.token || undefined }), store }), url: at.url };
}

/**
 * Runs fn(vault) with the passkey's secret: the pairing's passkey, the token
 * vault's, or a new one. The vault seals and opens bytes; the secret is wiped after.
 */
async function withPasskey (fn) {
  let credentialId = loadRecord()?.credentialId || loadVault()?.credentialId || null;
  let secret = null;
  if (!credentialId) {
    const made = await createPasskey({ name: 'loopk' });
    if (made.prfEnabled === false) throw new ControlError('This passkey cannot seal secrets (no PRF): use another password manager or browser.');
    ({ credentialId, secret } = made);
  }
  if (!secret) ({ credentialId, secret } = await unlock(credentialId));
  store.credentialId = credentialId;
  const vault = {
    seal: async (bytes) => seal(secret, toHex(bytes), INFO),
    open: async (sealed) => fromHex(await open(secret, sealed, INFO)),
  };
  try {
    return await fn(vault);
  } finally {
    secret.fill(0);
  }
}

/** Whether this browser can keep a pairing: passkeys with PRF (null: it does not say). */
export async function canPair () {
  const s = await support();
  return s.webauthn && s.secureContext && s.prf !== false;
}

/** The pairing record of this browser, or null. */
export const pairing = loadRecord;

/** Pairs with the AAPS master that shows `pin`. */
export async function pair (pin) {
  const { cc, url } = control();
  return withPasskey((vault) => cc.pair(pin.replace(/\s/g, ''), vault, { url }));
}

/** Forgets the pairing in this browser; removing the client in AAPS ends it there. */
export async function unpair () {
  await store.lock(async () => store.save(null));
}

/** { paired, role, listed, verified, signedAt, lastAnswer, error? } */
export async function status () {
  const rec = loadRecord();
  if (!rec) return { paired: false };
  const at = server();
  if (!at || at.url !== rec.url) return { paired: true, role: rec.role, name: rec.name, error: `Paired with AAPS through ${rec.url}, not the server this tab reads.` };
  return control().cc.status();
}

/** Copies the AI Test profile `test` into AAPS's local profile `to`: { adds, confirmed }. */
export async function copyProfile (test, to) {
  const rec = loadRecord();
  const at = server();
  if (!at || at.url !== rec?.url) throw new ControlError(`loopk is paired with AAPS through ${rec?.url}; this tab reads another server.`);
  const { cc } = control();
  return withPasskey((vault) => cc.copyProfile(test, to, vault));
}
