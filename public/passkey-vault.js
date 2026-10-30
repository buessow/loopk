// A token vault unlocked by a passkey: the passkey's PRF extension gives a
// secret only it can produce again (after Face ID, a fingerprint or the
// device PIN); a key derived from that secret encrypts the token, which this
// browser keeps encrypted. The server takes no part and stores nothing.
//
// Steps: createPasskey() once, unlock() for the secret, seal() the token
// with it and store the result; later unlock() and open() it again.

const VAULT_KEY = 'loopk.vault';
const encoder = new TextEncoder();

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** The PRF input: fixed, so the same passkey always gives the same secret for the vault. */
async function prfSalt () {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('loopk token vault v1')));
}

/** What this browser offers: WebAuthn, a platform authenticator, and PRF where it says so. */
export async function support () {
  const webauthn = typeof window !== 'undefined' && !!window.PublicKeyCredential;
  const out = { webauthn, secureContext: !!globalThis.isSecureContext, platform: null, prf: null, capabilities: null };
  if (!webauthn) return out;
  out.platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => null) ?? null;
  const caps = await PublicKeyCredential.getClientCapabilities?.().catch(() => null);
  if (caps) {
    out.capabilities = caps;
    out.prf = caps['extension:prf'] ?? null;
  }
  return out;
}

/**
 * Creates a passkey for the vault on this site. Returns its id (base64url),
 * whether the authenticator turned PRF on, and the PRF secret if it already
 * gave one (some do only at sign-in).
 */
export async function createPasskey ({ name = 'loopk token' } = {}) {
  const salt = await prfSalt();
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'loopk' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const prf = cred.getClientExtensionResults().prf || {};
  return {
    credentialId: b64url(cred.rawId),
    prfEnabled: prf.enabled ?? null,
    secret: prf.results?.first ? new Uint8Array(prf.results.first) : null,
    authenticator: cred.authenticatorAttachment ?? null,
  };
}

/** Signs in with the passkey (`credentialId`, or any of this site's) and returns its PRF secret. */
export async function unlock (credentialId) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      ...(credentialId ? { allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }] } : {}),
      extensions: { prf: { eval: { first: await prfSalt() } } },
    },
  });
  const first = cred.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error('The passkey gave no PRF secret: this browser or password manager does not support PRF.');
  return { credentialId: b64url(cred.rawId), secret: new Uint8Array(first) };
}

/** The AES-GCM key derived from a PRF secret. */
async function keyFrom (secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('loopk token vault') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** `text` encrypted with the PRF secret: { v, iv, data } (base64url). */
export async function seal (secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(secret), encoder.encode(text));
  return { v: 1, iv: b64url(iv), data: b64url(data) };
}

/** The text of a sealed vault; throws if the secret is not the one it was sealed with. */
export async function open (secret, sealed) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(sealed.iv) }, await keyFrom(secret), fromB64url(sealed.data));
  return new TextDecoder().decode(plain);
}

/** The vault this browser keeps: { credentialId, sealed? }, or null. */
export function loadVault () {
  try { return JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { return null; }
}

export function saveVault (vault) {
  if (vault) localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  else localStorage.removeItem(VAULT_KEY);
}
