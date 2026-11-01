import crypto from 'node:crypto';

// Sealing for a server that keeps nothing: a caller's credentials travel in
// their own cookie or JWT, encrypted (AES-256-GCM) with a key derived from
// SESSION_KEY, so only this server can read them and nobody can change them.

const derive = (secret, info) => Buffer.from(crypto.hkdfSync('sha256', secret, '', info, 32));

export class Sealer {
  constructor (secret) {
    this.key = derive(secret, 'loopk sealed credentials');
    /** A key for signing JWTs, from the same secret. */
    this.jwtSecret = derive(secret, 'loopk jwt').toString('base64url');
  }

  /** `value` (JSON) encrypted, as base64url: iv | ciphertext | tag. */
  seal (value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64url');
  }

  /** The value sealed in `text`, or null if it is not one this server sealed. */
  open (text) {
    try {
      const raw = Buffer.from(String(text), 'base64url');
      if (raw.length < 29) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }
}
