import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, fromB64url, open, seal } from '../public/passkey-vault.js';

const secret = (n) => new Uint8Array(32).fill(n);

test('a token sealed with a passkey secret opens with the same secret only', async () => {
  const sealed = await seal(secret(7), 'token-abc');
  assert.equal(sealed.v, 1);
  assert.equal(await open(secret(7), sealed), 'token-abc');
  await assert.rejects(open(secret(8), sealed));
});

test('each seal uses a fresh iv', async () => {
  const [a, b] = await Promise.all([seal(secret(1), 'x'), seal(secret(1), 'x')]);
  assert.notEqual(a.iv, b.iv);
});

test('base64url round-trips bytes', () => {
  const bytes = Uint8Array.from([0, 251, 255, 62, 63]);
  assert.deepEqual(fromB64url(b64url(bytes)), bytes);
  assert.doesNotMatch(b64url(bytes), /[+/=]/);
});
