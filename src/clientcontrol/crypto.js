// The cryptography of AAPS 4.0's client control (aaps-dev
// core/nssdk/.../utils/ClientControl*Crypto.kt, MasterDocSigning.kt), byte
// for byte, with WebCrypto, so it runs in the browser and in Node alike.
// Secrets come in as bytes and are imported as non-extractable keys for one
// use each; nothing here keeps them.

const encoder = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export const PBKDF2_ITERATIONS = 200000;
const KEY_INFO = 'aaps-clientcontrol-key-v1';
const SETTINGS_PREFIX = 'aaps-settings-v1';

export const toHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex (hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('not hex');
  return Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
}

/** Standard Base64 with padding, as Kotlin's Base64.Default writes it. */
export const toB64 = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};

export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A non-extractable HMAC-SHA256 key of the secret bytes. */
export function hmacKey (secret) {
  return subtle().importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** The signature of `text`: HMAC-SHA256, lower-case hex. `key` is a secret's bytes or its hmacKey. */
export async function sign (key, text) {
  const k = key instanceof Uint8Array ? await hmacKey(key) : key;
  return toHex(await subtle().sign('HMAC', k, encoder.encode(text)));
}

/** Whether `signature` is that of `text`, compared without an early exit. */
export async function verify (key, text, signature) {
  const expected = await sign(key, text);
  if (typeof signature !== 'string' || signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// --- the signed texts (SignedEnvelope, AckEnvelope, KeyExchangeEnvelope) ---

export const envelopeText = (e) => `${e.clientId}|${e.counter}|${e.timestamp}|${e.validUntil}|${e.wantsAck}|${e.type}|${e.payload}`;
export const ackText = (a) => `${a.clientId}|${a.commandCounter}|${a.phase}|${a.status}|${a.reason ?? ''}|${a.payload ?? ''}|${a.timestamp}`;
export const keyExchangeText = (k) => `${k.clientId}|${k.clientPublicKey}|${k.masterPublicKey}|${k.tokenIv ?? ''}|${k.token ?? ''}|${k.timestamp}`;

// --- the PIN offer (ClientControlPairingCrypto) -----------------------------

async function pinKey (pin, salt) {
  const base = await subtle().importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** `plaintext` wrapped with the PIN: ciphertext with the GCM tag appended. */
export async function wrap (plaintext, pin, salt, iv) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), plaintext));
}

/** The plaintext of a wrapped blob, or null for a wrong PIN or a changed blob. */
export async function unwrap (wrapped, pin, salt, iv) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), wrapped));
  } catch {
    return null;
  }
}

/** The PairingPayload of an offer (PairingOffer) if `pin` opens it and it is complete, else null. */
export async function openOffer (offer, pin, now = Date.now()) {
  let salt, iv, wrapped;
  try {
    [salt, iv, wrapped] = [fromB64(offer.kdfSaltB64), fromB64(offer.ivB64), fromB64(offer.wrappedB64)];
  } catch {
    return null;
  }
  const plain = await unwrap(wrapped, pin, salt, iv);
  if (!plain) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  if (!payload?.masterInstallId || !payload.clientId || !payload.secretHex) return null;
  if (payload.expiresAt > 0 && payload.expiresAt < now) return null;
  return payload;
}

// --- the key exchange (ClientControlKeyExchangeCrypto) ----------------------

/** A P-256 ECDH key pair: the private key stays in WebCrypto; the public key is Base64 of its raw point. */
export async function newKeyPair () {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: toB64(await subtle().exportKey('raw', pair.publicKey)) };
}

/**
 * The keys both sides come to: HKDF-SHA256 over the ECDH secret, salted with
 * the old pairing secret. { secret (the new pairing secret), tokenKey }, 32 bytes each.
 */
export async function deriveKeys (privateKey, otherPublicKey, oldSecret, clientId, clientPublicKey, masterPublicKey) {
  const other = await subtle().importKey('raw', fromB64(otherPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: other }, privateKey, 256);
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const info = encoder.encode(`${KEY_INFO}|${clientId}|${clientPublicKey}|${masterPublicKey}`);
  const keys = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: oldSecret, info }, base, 512));
  return { secret: keys.slice(0, 32), tokenKey: keys.slice(32) };
}

/** The token the master sealed for this client, or null. */
export async function openToken (tokenKey, ivB64, sealedB64) {
  try {
    const key = await subtle().importKey('raw', tokenKey, 'AES-GCM', false, ['decrypt']);
    return new TextDecoder().decode(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, fromB64(sealedB64)));
  } catch {
    return null;
  }
}

// --- the master's signature on its settings docs (MasterDocSigning) --------

/** Whether `signature` (Base64, raw r||s) is the master's ECDSA P-256 signature of the doc's signed text. */
export async function verifyMasterDoc (publicKey, identifier, signed, signature) {
  try {
    const key = await subtle().importKey('raw', fromB64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signature), encoder.encode(`${SETTINGS_PREFIX}|${identifier}|${signed}`));
  } catch {
    return false;
  }
}
