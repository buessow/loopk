import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { Follower } from '../src/sync/follower.js';
import { signInUser } from '../src/web/session.js';

/** A Nightscout server as far as following it goes: token exchange, API v3 history, /storage socket. */
async function fakeNightscout ({ headerOnly = false } = {}) {
  const docs = Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate'].map((c) => [c, []]));
  let jwt = 'jwt-1';
  const ns = { docs, requests: [], pageSize: 1000 };
  const app = express();
  app.get('/api/v2/authorization/request/:token', (req, res) => {
    if (req.params.token !== 'follow-token') return res.status(401).end();
    res.json({ token: jwt });
  });
  app.get('/api/v3/entries', (req, res) => {
    if (req.get('authorization') !== `Bearer ${jwt}`) return res.status(401).json({ status: 401 });
    res.json({ status: 200, result: docs.entries.slice(0, 1) });
  });
  const history = (req, res, after) => {
    ns.requests.push(req.path);
    if (req.get('authorization') !== `Bearer ${jwt}`) return res.status(401).json({ status: 401 });
    const limit = Math.min(Number(req.query.limit), ns.pageSize);
    const result = docs[req.params.col].filter((d) => d.srvModified > after).sort((a, b) => a.srvModified - b.srvModified).slice(0, limit);
    res.json({ status: 200, result });
  };
  app.get('/api/v3/:col/history/:lastModified', (req, res) => {
    if (headerOnly) return res.status(400).json({ status: 400, message: 'Bad or missing Last-Modified header/parameter' });
    return history(req, res, Number(req.params.lastModified));
  });
  app.get('/api/v3/:col/history', (req, res) => {
    const lastModified = new Date(req.get('last-modified')).getTime();
    if (!Number.isFinite(lastModified)) return res.status(400).json({ status: 400, message: 'Bad or missing Last-Modified header/parameter' });
    return history(req, res, lastModified);
  });
  const server = http.createServer(app);
  const io = new Server(server);
  ns.storage = io.of('/storage');
  ns.storage.on('connection', (socket) => socket.on('subscribe', (msg, cb) => { socket.join('all'); cb?.({ success: true }); }));
  await new Promise((resolve) => server.listen(0, resolve));
  ns.url = `http://localhost:${server.address().port}`;
  ns.expireJwt = () => { jwt = `jwt-${Number(jwt.split('-')[1]) + 1}`; };
  ns.close = () => { io.close(); return new Promise((resolve) => server.close(resolve)); };
  return ns;
}

let ns;
let s;
const T = Date.parse('2026-10-01T10:00:00.000Z');
const entry = (id, minutes, srvModified) => ({ identifier: id, date: T + minutes * 60000, sgv: 100 + minutes, type: 'sgv', srvCreated: srvModified, srvModified });

before(async () => {
  ns = await fakeNightscout();
  s = await startServer({ FOLLOW_URL: ns.url, FOLLOW_TOKEN: 'follow-token' });
});
after(async () => {
  await s.ctx.follower?.stop();
  await s.close();
  await ns.close();
});

const count = async (table, where = 'TRUE') => (await s.ctx.data.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

test('copies documents, cleaned up, and remembers where it got to', async () => {
  ns.docs.entries.push(entry('e1', 0, 1000), entry('e2', 5, 1001), entry('e3', 10, 1002));
  ns.docs.treatments.push(
    { identifier: 't1', created_at: '2026-10-01T10:00:00Z', eventType: 'Note', notes: 'hi', NSCLIENT_ID: 'x', srvModified: 1500 },
    { identifier: 't2', eventType: 'HeartRate', heartRate: 61, samplingStart: '2026-10-01T10:00:00Z', samplingEnd: '2026-10-01T10:05:00Z', created_at: '2026-10-01T10:05:01Z', srvModified: 1501 });
  ns.docs.food.push({ identifier: 'f1', date: T, created_at: new Date(T).toISOString(), beatsPerMinute: 70, duration: 300000, srvModified: 1600 });

  await s.ctx.follower.syncAll();
  assert.equal(await count('entries'), 3);
  const note = await s.ctx.follower.stores.treatments.findOne('t1');
  assert.equal(note.created_at, '2026-10-01T10:00:00.000Z');
  assert.equal(note.NSCLIENT_ID, undefined);
  assert.equal(note.srvModified, 1500);
  assert.equal(await count('treatments'), 1);
  assert.equal(await count('heartrate'), 2);
  assert.equal(await count('food'), 0);
  const { rows } = await s.ctx.data.pool.query("SELECT last_modified FROM follow_state WHERE collection = 'entries'");
  assert.equal(Number(rows[0].last_modified), 1002);
});

test('copies changes and soft deletes; asks only for what is new', async () => {
  ns.requests.length = 0;
  ns.docs.entries[0] = { ...ns.docs.entries[0], isValid: false, srvModified: 2000 };
  await s.ctx.follower.syncAll();
  assert.equal(await count('entries', 'is_valid = false'), 1);
  assert.ok(ns.requests.includes('/api/v3/entries/history/1002'));
});

test('pages through history, also when a page ends amid equal srvModified', async () => {
  ns.pageSize = 2;
  const follower = new Follower(s.ctx, { url: ns.url, token: 'follow-token', pageSize: 2 });
  ns.docs.entries.push(entry('p1', 20, 3000), entry('p2', 25, 3001), entry('p3', 30, 3001), entry('p4', 35, 3002));
  await follower.syncAll();
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.ok(await follower.stores.entries.findOne(id), id);
  ns.pageSize = 1000;
});

test('exchanges the access token again when the JWT has expired', async () => {
  ns.expireJwt();
  ns.docs.entries.push(entry('j1', 40, 4000));
  await s.ctx.follower.syncAll();
  assert.ok(await s.ctx.follower.stores.entries.findOne('j1'));
});

test('falls back to Last-Modified history for older Nightscout servers', async () => {
  const legacy = await fakeNightscout({ headerOnly: true });
  try {
    legacy.docs.entries.push(entry('legacy', 42, T));
    const follower = new Follower(s.ctx, { url: legacy.url, token: 'follow-token' });
    await follower.sync('entries');
    assert.ok(await follower.stores.entries.findOne('legacy'));
    assert.equal(follower.historyMode, 'header');
    assert.ok(legacy.requests.includes('/api/v3/entries/history'));
  } finally {
    await legacy.close();
  }
});

test('a change announced on the socket is copied right away', async () => {
  s.ctx.follower.connectSocket();
  await new Promise((resolve) => s.ctx.follower.socket.on('connect', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  ns.docs.entries.push(entry('live', 45, 5000));
  ns.storage.to('all').emit('create', { colName: 'entries', doc: { identifier: 'live' } });
  for (let i = 0; i < 50 && !(await s.ctx.follower.stores.entries.findOne('live')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await s.ctx.follower.stores.entries.findOne('live'));
});

test('while following, the API accepts reads but no data changes', async () => {
  const writer = await tokenFor(s.ctx, 'aaps');
  const bearer = { Authorization: `Bearer ${writer.jwt}` };
  await request(s.app).get('/api/v3/entries').set(bearer).expect(200);
  const res = await request(s.app).post('/api/v3/entries').set(bearer).send(entry('x', 50, 1)).expect(403);
  assert.match(res.body.message, /follows/);
  await request(s.app).delete('/api/v3/entries/e2').set(bearer).expect(403);
});

test('a cursor belongs to the server it was copied from', async () => {
  assert.ok(await s.ctx.follower.cursor('entries') > 0);
  const other = new Follower(s.ctx, { url: 'http://other.example.com', token: 'x' });
  assert.equal(await other.cursor('entries'), 0);
});

test('admins set the server to follow on the Access page', async () => {
  const { auth, data, config } = s.ctx;
  const { pool } = data;
  const cookieOf = async (email) => `${auth.sessionCookieName()}=${auth.signSession(await signInUser(data, config, { email }))}`;
  await pool.query("INSERT INTO users (email) VALUES ('viewer@example.com')");
  const viewer = await cookieOf('viewer@example.com');
  const admin = await cookieOf('admin@example.com');
  const put = (body) => request(s.app).put('/api/admin/follow').set('Cookie', admin).send(body);

  await request(s.app).get('/api/admin/follow').set('Cookie', viewer).expect(403);
  let res = await request(s.app).get('/api/admin/follow').set('Cookie', admin).expect(200);
  assert.equal(res.body.source, 'environment');
  assert.equal(res.body.url, ns.url);
  assert.equal(res.body.collections.find((c) => c.collection === 'entries').copiedUntil > 0, true);

  assert.match((await put({ url: ns.url, token: 'wrong' }).expect(400)).body.message, /did not accept the access token/);
  assert.match((await put({ url: 'http://localhost:1', token: 'x' }).expect(400)).body.message, /Could not reach/);
  assert.match((await put({ url: 'ftp://example.com', token: 'x' }).expect(400)).body.message, /https/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM follow_config')).rows[0].n, 0);

  res = await put({ url: ns.url + '/', token: 'follow-token' }).expect(200);
  assert.equal(res.body.source, 'settings');
  assert.equal(res.body.following, true);
  assert.equal(res.body.url, ns.url);
  assert.equal(res.body.tokenSet, true);
  assert.equal(res.body.updatedBy, 'admin@example.com');
  assert.ok(!JSON.stringify(res.body).includes('follow-token'));
  assert.equal(s.ctx.follower.url, ns.url);

  // Stopped, the API takes uploads again; following again keeps the saved token.
  const writer = await tokenFor(s.ctx, 'aaps-2');
  res = await put({ url: ns.url, enabled: false }).expect(200);
  assert.equal(res.body.following, false);
  assert.equal(s.ctx.follower, null);
  await request(s.app).post('/api/v3/entries').set({ Authorization: `Bearer ${writer.jwt}` }).send({ date: T + 3600000, sgv: 120, type: 'sgv', app: 'test', utcOffset: 0 }).expect(201);
  res = await put({ url: ns.url }).expect(200);
  assert.equal(res.body.following, true);
  assert.match((await put({ url: 'http://other.example.com' }).expect(400)).body.message, /access token/);

  res = await request(s.app).delete('/api/admin/follow').set('Cookie', admin).expect(200);
  assert.equal(res.body.source, 'environment');
  assert.equal(s.ctx.follower.url, ns.url);
});
