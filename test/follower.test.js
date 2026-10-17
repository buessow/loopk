import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { Follower } from '../src/sync/follower.js';

/** A Nightscout server as far as following it goes: token exchange, API v3 history, /storage socket. */
async function fakeNightscout () {
  const docs = Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate'].map((c) => [c, []]));
  let jwt = 'jwt-1';
  const ns = { docs, requests: [], pageSize: 1000 };
  const app = express();
  app.get('/api/v2/authorization/request/:token', (req, res) => {
    if (req.params.token !== 'follow-token') return res.status(401).end();
    res.json({ token: jwt });
  });
  app.get('/api/v3/:col/history/:lastModified', (req, res) => {
    ns.requests.push(req.path);
    if (req.get('authorization') !== `Bearer ${jwt}`) return res.status(401).json({ status: 401 });
    const after = Number(req.params.lastModified);
    const limit = Math.min(Number(req.query.limit), ns.pageSize);
    const result = docs[req.params.col].filter((d) => d.srvModified > after).sort((a, b) => a.srvModified - b.srvModified).slice(0, limit);
    res.json({ status: 200, result });
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
  await s.ctx.follower.stop();
  await s.close();
  await ns.close();
});

const count = async (table, where = 'TRUE') => (await s.ctx.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

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
  const { rows } = await s.ctx.pool.query("SELECT last_modified FROM follow_state WHERE collection = 'entries'");
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
