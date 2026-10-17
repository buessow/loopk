import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { signInUser } from '../src/web/session.js';

let s;

before(async () => {
  s = await startServer({ ALLOWED_EMAILS: 'friend@example.com' });
});
after(() => s.close());

test('only admins, allow-listed and added accounts may sign in', async () => {
  const { pool, config } = s.ctx;
  const admin = await signInUser(pool, config, { email: 'Admin@Example.com', name: 'A' });
  assert.equal(admin.is_admin, true);
  const friend = await signInUser(pool, config, { email: 'friend@example.com' });
  assert.equal(friend.is_admin, false);
  assert.equal(await signInUser(pool, config, { email: 'stranger@example.com' }), null);
});

test('session cookie gives the web UI access to the API', async () => {
  const { auth, pool, config } = s.ctx;
  const user = await signInUser(pool, config, { email: 'friend@example.com' });
  const cookie = `${auth.sessionCookieName()}=${auth.signSession(user)}`;

  await request(s.app).get('/api/session').expect(401);
  const session = await request(s.app).get('/api/session').set('Cookie', cookie).expect(200);
  assert.equal(session.body.user.email, 'friend@example.com');
  assert.equal(session.body.isAdmin, false);

  await request(s.app).get('/api/v3/entries').set('Cookie', cookie).expect(200);
  await request(s.app).post('/api/v3/entries').set('Cookie', cookie)
    .send({ date: Date.now(), sgv: 1, type: 'sgv', app: 'x', utcOffset: 0 }).expect(403);
  await request(s.app).get('/api/v2/authorization/subjects').set('Cookie', cookie).expect(403);
  await request(s.app).get('/api/admin/users').set('Cookie', cookie).expect(403);
  await request(s.app).get('/api/v2/authorization/subjects').expect(401);
});

test('tokens read, or read and write, but never manage access', async () => {
  const reader = await tokenFor(s.ctx, 'viewer', { canWrite: false });
  const writer = await tokenFor(s.ctx, 'aaps');
  const doc = { date: Date.now(), sgv: 100, type: 'sgv', app: 'x', utcOffset: 0 };
  const bearer = (t) => ({ Authorization: `Bearer ${t.jwt}` });

  await request(s.app).get('/api/v3/entries').set(bearer(reader)).expect(200);
  await request(s.app).post('/api/v3/entries').set(bearer(reader)).send(doc).expect(403);
  await request(s.app).post('/api/v3/entries').set(bearer(writer)).send(doc).expect(201);
  for (const t of [reader, writer]) {
    await request(s.app).get('/api/v2/authorization/subjects').set(bearer(t)).expect(403);
    await request(s.app).post('/api/admin/users').set(bearer(t)).send({ email: 'x@example.com', isAdmin: true }).expect(403);
  }
  const exchanged = await request(s.app).get(`/api/v2/authorization/request/${reader.accessToken}`).expect(200);
  assert.deepEqual(exchanged.body.permissionGroups, [['api:*:read']]);
});

test('admin manages tokens and people', async () => {
  const { auth, pool, config } = s.ctx;
  const user = await signInUser(pool, config, { email: 'admin@example.com' });
  const cookie = `${auth.sessionCookieName()}=${auth.signSession(user)}`;

  const created = await request(s.app).post('/api/v2/authorization/subjects').set('Cookie', cookie)
    .send({ name: 'AAPS phone', canWrite: true }).expect(200);
  assert.match(created.body.accessToken, /^aapsphone-[0-9a-f]{16}$/);
  assert.equal(created.body.canWrite, true);
  await request(s.app).post('/api/v2/authorization/subjects').set('Cookie', cookie).send({ name: 'x', canWrite: 'yes' }).expect(400);
  const changed = await request(s.app).put(`/api/v2/authorization/subjects/${created.body._id}`).set('Cookie', cookie).send({ canWrite: false }).expect(200);
  assert.equal(changed.body.canWrite, false);
  await request(s.app).post('/api/v2/authorization/subjects').set('Cookie', cookie).send({ name: 'AAPS phone' }).expect(409);
  const list = await request(s.app).get('/api/v2/authorization/subjects').set('Cookie', cookie).expect(200);
  assert.ok(list.body.some((t) => t.name === 'AAPS phone' && t.canWrite === false));

  const added = await request(s.app).post('/api/admin/users').set('Cookie', cookie).send({ email: 'New@Example.com' }).expect(200);
  assert.equal(added.body.isAdmin, false);
  assert.ok(await signInUser(pool, config, { email: 'new@example.com' }));
  // Made an admin by an admin; stays one when signing in again.
  await request(s.app).post('/api/admin/users').set('Cookie', cookie).send({ email: 'new@example.com', isAdmin: true }).expect(200);
  assert.equal((await signInUser(pool, config, { email: 'new@example.com' })).is_admin, true);
  // An admin cannot lock themselves out.
  await request(s.app).post('/api/admin/users').set('Cookie', cookie).send({ email: 'admin@example.com', isAdmin: false }).expect(409);
  await request(s.app).delete('/api/admin/users/admin@example.com').set('Cookie', cookie).expect(409);
  await request(s.app).delete(`/api/v2/authorization/subjects/${created.body._id}`).set('Cookie', cookie).expect(200);
});

test('google routes report missing configuration', async () => {
  await request(s.app).get('/auth/google').expect(503);
  const login = await request(s.app).get('/login').expect(200);
  assert.match(login.text, /Sign in with Google/);
});

test('AUTH_DISABLED signs the browser in as a local admin, but not API tokens', async () => {
  const local = await startServer({ AUTH_DISABLED: 'true' });
  try {
    const session = await request(local.app).get('/api/session').expect(200);
    assert.equal(session.body.user.email, 'local@localhost');
    assert.equal(session.body.isAdmin, true);
    await request(local.app).get('/api/v3/entries').expect(200);
    await request(local.app).get('/api/v3/entries').set('Authorization', 'Bearer bad').expect(401);
  } finally {
    await local.close();
  }
});
