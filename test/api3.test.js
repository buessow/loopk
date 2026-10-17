import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';

let s;
let admin;
let reader;

before(async () => {
  s = await startServer();
  admin = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'follower', { canWrite: false });
});
after(() => s.close());

const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const sgv = (date, value, extra = {}) => ({ date, sgv: value, type: 'sgv', device: 'xDrip', app: 'AAPS', utcOffset: 0, direction: 'Flat', ...extra });

test('token exchange returns a JWT like Nightscout', async () => {
  const res = await request(s.app).get(`/api/v2/authorization/request/${admin.accessToken}`).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.sub, 'aaps');
  assert.ok(res.body.exp > res.body.iat);
  await request(s.app).get('/api/v2/authorization/request/nope-0000').expect(401);
});

test('requests without or with a bad bearer token get 401', async () => {
  await request(s.app).get('/api/v3/status').set('Authorization', 'Bearer ').expect(401);
  await request(s.app).get('/api/v3/status').set('Authorization', 'Bearer garbage').expect(401);
});

test('status reports permissions per collection', async () => {
  const res = await request(s.app).get('/api/v3/status').set(auth(admin)).expect(200);
  assert.equal(res.body.result.apiVersion, '3.0.3-alpha');
  assert.equal(res.body.result.apiPermissions.entries, 'crud');
  assert.equal(res.body.result.apiPermissions.heartrate, 'crud');
  const ro = await request(s.app).get('/api/v3/status').set(auth(reader)).expect(200);
  assert.equal(ro.body.result.apiPermissions.treatments, 'r');
});

test('create, deduplicate, read, patch and soft-delete an entry', async () => {
  const date = Date.now() - 60000;
  const created = await request(s.app).post('/api/v3/entries').set(auth(admin)).send(sgv(date, 120)).expect(201);
  const id = created.body.identifier;
  assert.ok(id);
  assert.ok(created.body.lastModified);

  const dup = await request(s.app).post('/api/v3/entries').set(auth(admin)).send(sgv(date, 121)).expect(200);
  assert.equal(dup.body.identifier, id);
  assert.equal(dup.body.isDeduplication, true);

  const read = await request(s.app).get(`/api/v3/entries/${id}`).set(auth(admin)).expect(200);
  assert.equal(read.body.result.sgv, 121);
  assert.equal(read.body.result.subject, 'aaps');
  assert.ok(read.headers['last-modified']);

  await request(s.app).patch(`/api/v3/entries/${id}`).set(auth(admin)).send({ noise: 1 }).expect(200);
  const patched = await request(s.app).get(`/api/v3/entries/${id}`).set(auth(admin)).expect(200);
  assert.equal(patched.body.result.noise, 1);
  assert.equal(patched.body.result.modifiedBy, 'aaps');

  const bad = await request(s.app).patch(`/api/v3/entries/${id}`).set(auth(admin)).send({ date: date + 1 }).expect(400);
  assert.match(bad.body.message, /cannot be modified by the client/);

  await request(s.app).delete(`/api/v3/entries/${id}`).set(auth(admin)).expect(200);
  await request(s.app).get(`/api/v3/entries/${id}`).set(auth(admin)).expect(410);
  const hist = await request(s.app).get('/api/v3/entries/history/0').set(auth(admin)).expect(200);
  assert.ok(hist.body.result.some((d) => d.identifier === id && d.isValid === false));
});

test('validation errors match Nightscout messages', async () => {
  const res = await request(s.app).post('/api/v3/treatments').set(auth(admin))
    .send({ date: Date.now(), eventType: 'Note', utcOffset: 0 }).expect(400);
  assert.equal(res.body.message, 'Bad or missing app field');
  await request(s.app).post('/api/v3/treatments').set(auth(admin)).send({}).expect(400);
});

test('readable token cannot create', async () => {
  const res = await request(s.app).post('/api/v3/entries').set(auth(reader)).send(sgv(Date.now(), 99)).expect(403);
  assert.equal(res.body.message, 'Missing permission api:entries:create');
});

test('search supports filters, sort$desc, limit and fields', async () => {
  const base = Date.now() - 3600000;
  for (let i = 0; i < 5; i++) {
    await request(s.app).post('/api/v3/entries').set(auth(admin)).send(sgv(base + i * 300000, 100 + i, { device: 'search' })).expect(201);
  }
  const res = await request(s.app)
    .get(`/api/v3/entries?sort$desc=date&type=sgv&device=search&date$gt=${base}&limit=3&fields=sgv,date`)
    .set(auth(admin)).expect(200);
  assert.deepEqual(res.body.result.map((d) => d.sgv), [104, 103, 102]);
  assert.deepEqual(Object.keys(res.body.result[0]).sort(), ['date', 'sgv']);

  const cmp = await request(s.app).get(`/api/v3/entries?device=search&sgv$gte=103&sort=date`).set(auth(admin)).expect(200);
  assert.deepEqual(cmp.body.result.map((d) => d.sgv), [103, 104]);
  const inOp = await request(s.app).get('/api/v3/entries?device$in=search|other&sgv$lt=102').set(auth(admin)).expect(200);
  assert.equal(inOp.body.result.length, 2);
  const re = await request(s.app).get('/api/v3/entries?device$re=^sea').set(auth(admin)).expect(200);
  assert.equal(re.body.result.length, 5);

  await request(s.app).get('/api/v3/entries?sort=date&sort$desc=date').set(auth(admin)).expect(400);
  await request(s.app).get('/api/v3/entries?limit=0').set(auth(admin)).expect(400);
  await request(s.app).get('/api/v3/entries?sgv$foo=1').set(auth(admin)).expect(400);
});

test('treatments use created_at filters (as AAPS getTreatmentsNewerThan)', async () => {
  const t = Date.now() - 1000;
  await request(s.app).post('/api/v3/treatments').set(auth(admin))
    .send({ date: t, eventType: 'Meal Bolus', carbs: 20, insulin: 2, app: 'AAPS', device: 'AAPS', utcOffset: 60 }).expect(201);
  const res = await request(s.app)
    .get(`/api/v3/treatments?sort=created_at&created_at$gt=${new Date(t - 5000).toISOString()}&limit=10`)
    .set(auth(admin)).expect(200);
  assert.equal(res.body.result.length, 1);
  assert.equal(res.body.result[0].created_at, new Date(t).toISOString());
  assert.equal(res.body.result[0].utcOffset, 60);
});

test('history returns changes since a timestamp with Last-Modified and ETag', async () => {
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const created = await request(s.app).post('/api/v3/devicestatus').set(auth(admin))
    .send({ date: Date.now(), device: 'openaps://phone', app: 'AAPS', utcOffset: 0, openaps: { iob: { iob: 1.2 } } }).expect(201);
  const res = await request(s.app).get(`/api/v3/devicestatus/history/${since}`).set(auth(admin)).expect(200);
  assert.equal(res.body.result.length, 1);
  assert.match(res.headers.etag, new RegExp(`^W/"${created.body.lastModified}"$`));

  const lm = await request(s.app).get('/api/v3/lastModified').set(auth(admin)).expect(200);
  assert.ok(lm.body.result.collections.devicestatus >= created.body.lastModified);
  assert.ok(lm.body.result.collections.entries);
});

test('heartrate collection (AAPS fork extension)', async () => {
  const t = Date.now();
  const res = await request(s.app).post('/api/v3/heartrate').set(auth(admin))
    .send({ created_at: new Date(t).toISOString(), date: t, duration: 60000, beatsPerMinute: 72, device: 'watch', app: 'AAPS', utcOffset: 0 })
    .expect(201);
  const hist = await request(s.app).get(`/api/v3/heartrate/history/${t - 1000}?limit=12`).set(auth(admin)).expect(200);
  assert.equal(hist.body.result[0].identifier, res.body.identifier);
});

test('csv output via extension', async () => {
  const res = await request(s.app).get('/api/v3/entries.csv?limit=2&fields=date,sgv').set(auth(admin)).expect(200);
  assert.match(res.headers['content-type'], /csv/);
  assert.match(res.text, /^date,sgv|^sgv,date/);
});
