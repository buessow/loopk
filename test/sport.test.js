import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { signInUser } from '../src/web/session.js';
import { baseSwitch } from '../src/sport/mode.js';

let s;
let writer;
let reader;
let cookie;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const MIN = 60000;
const HOUR = 60 * MIN;
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });
const profile = (basal, sens) => ({
  dia: 5, units: 'mmol', timezone: 'Europe/Zurich', basal: [entry('00:00', basal)], sens: [entry('00:00', sens)],
  carbratio: [entry('00:00', 9)], target_low: [entry('00:00', 5.5)], target_high: [entry('00:00', 6.5)],
});
const DEFAULT = profile(0.9, 5.5);

before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const user = await signInUser(s.ctx.data, s.ctx.config, { email: 'admin@example.com' });
  cookie = `${s.ctx.auth.sessionCookieName()}=${s.ctx.auth.signSession(user)}`;
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'AAPS', device: 'phone', utcOffset: 120, ...doc }).expect(201);
  await post('profile', { date: Date.now() - 2 * HOUR, defaultProfile: 'Default', units: 'mmol', store: { Default: DEFAULT, Sport: profile(0.5, 8) } });
  // The switch AAPS made last, as it uploads it.
  await post('treatments', {
    date: Date.now() - HOUR, eventType: 'Profile Switch', profile: 'Default', originalProfileName: 'Default',
    percentage: 100, timeshift: 0, duration: 0, durationInMilliseconds: 0, profileJson: JSON.stringify(DEFAULT),
  });
});
after(() => s.close());

const admin = (method, body) => request(s.app)[method]('/api/admin/sport').set('Cookie', cookie).send(body);
const sport = (path = '', body) => (path
  ? request(s.app).post(`/api/sport/${path}`).set('Cookie', cookie).send(body)
  : request(s.app).get('/api/sport').set('Cookie', cookie));
const latest = async (eventType) => (await request(s.app).get('/api/v3/treatments').set(auth(reader))
  .query({ eventType$eq: eventType, sort$desc: 'date', limit: 1 }).expect(200)).body.result[0];

test('until an admin sets it up, sport mode is off and cannot be switched on', async () => {
  const session = await request(s.app).get('/api/session').set('Cookie', cookie).expect(200);
  assert.equal(session.body.sport, false);
  const { body } = await sport().expect(200);
  assert.equal(body.configured, false);
  assert.equal(body.active, false);
  const res = await sport('start', {}).expect(409);
  assert.match(res.body.message, /not set up/);
});

test('admins set sport mode up, with checked values and the profiles to choose from', async () => {
  const view = await admin('get').expect(200);
  assert.deepEqual(view.body.profiles, ['Default', 'Sport']);
  assert.equal(view.body.config, null);

  assert.match((await admin('put', { percentage: 5, duration: 60 }).expect(400)).body.message, /percentage/);
  assert.match((await admin('put', { percentage: 70, duration: 5 }).expect(400)).body.message, /duration/);
  assert.match((await admin('put', { percentage: 70, duration: 60, target: 400 }).expect(400)).body.message, /temp target/);
  assert.match((await admin('put', { percentage: 70, duration: 60, profile: 'Nope' }).expect(400)).body.message, /no profile Nope/);
  await request(s.app).put('/api/admin/sport').set(auth(reader)).send({ percentage: 70, duration: 60 }).expect(403);

  const { body } = await admin('put', { percentage: 70, duration: 90, target: 140 }).expect(200);
  assert.equal(body.config.percentage, 70);
  assert.equal(body.config.updatedBy, 'admin@example.com');
  assert.equal((await request(s.app).get('/api/session').set('Cookie', cookie).expect(200)).body.sport, true);
});

test('switching sport mode on writes a profile switch and an Activity temp target for AAPS', async () => {
  const sent = [];
  const listen = (e) => sent.push(e.doc.eventType);
  s.ctx.bus.on('storage-socket-create', listen);
  // Only people signed in who may write treatments.
  await request(s.app).post('/api/sport/start').set(auth(writer)).send({}).expect(403);

  const { body } = await sport('start', { duration: 45, utcOffset: 120 }).expect(200);
  s.ctx.bus.off('storage-socket-create', listen);
  assert.equal(body.active, true);
  assert.equal(body.percentage, 70);
  assert.equal(body.profile, 'Default');
  assert.equal(body.target, 140);
  assert.ok(Math.abs(body.until - Date.now() - 45 * MIN) < 5000);
  assert.deepEqual(sent, ['Profile Switch', 'Temporary Target']);

  const ps = await latest('Profile Switch');
  assert.equal(ps.profile, 'Default (70%)');
  assert.equal(ps.originalProfileName, 'Default');
  assert.equal(ps.percentage, 70);
  assert.equal(ps.duration, 45);
  assert.equal(ps.durationInMilliseconds, 45 * MIN);
  assert.equal(ps.app, 'loopk');
  assert.equal(ps.enteredBy, 'admin@example.com');
  assert.deepEqual(JSON.parse(ps.profileJson).basal, DEFAULT.basal);
  const tt = await latest('Temporary Target');
  assert.equal(tt.reason, 'Activity');
  assert.equal(tt.targetBottom, 140);
  assert.equal(tt.targetTop, 140);
  assert.equal(tt.units, 'mg/dl');
  assert.equal(tt.duration, 45);
});

test('switching sport mode off goes back to the profile before and ends the temp target', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { body } = await sport('stop', { utcOffset: 120 }).expect(200);
  assert.equal(body.active, false);
  assert.equal(body.target, null);
  const ps = await latest('Profile Switch');
  assert.equal(ps.profile, 'Default');
  assert.equal(ps.percentage, 100);
  assert.equal(ps.duration, 0);
  assert.equal(ps.notes, 'Sport mode ended');
  assert.equal(ps.device, 'loopk');
  const tt = await latest('Temporary Target');
  assert.equal(tt.duration, 0);
  assert.match((await sport('stop', {}).expect(409)).body.message, /not on/);
});

test('a named profile is switched to instead of the one in use', async () => {
  await admin('put', { percentage: 100, duration: 60, profile: 'Sport' }).expect(200);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { body } = await sport('start', {}).expect(200);
  assert.equal(body.profile, 'Sport');
  const ps = await latest('Profile Switch');
  assert.equal(ps.profile, 'Sport');
  assert.equal(ps.duration, 60);
  assert.equal(JSON.parse(ps.profileJson).sens[0].value, 8);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Off again: back to Default, which was in use before.
  await sport('stop', {}).expect(200);
  assert.equal((await latest('Profile Switch')).profile, 'Default');
  await admin('delete').expect(200);
  assert.equal((await sport().expect(200)).body.configured, false);
});

test('with no limit, the profile switch lasts until sport mode is ended', async () => {
  assert.equal((await admin('put', { percentage: 60, target: 140 }).expect(200)).body.config.duration, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { body } = await sport('start', {}).expect(200);
  assert.equal(body.active, true);
  assert.equal(body.until, null);
  const ps = await latest('Profile Switch');
  assert.equal(ps.profile, 'Default (60%)');
  assert.equal(ps.duration, 0);
  assert.equal(ps.durationInMilliseconds, 0);
  // AAPS has no temp target without an end: 24 hours, ended with sport mode.
  assert.equal((await latest('Temporary Target')).duration, 24 * 60);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sport('stop', {}).expect(200);
  assert.equal((await latest('Profile Switch')).profile, 'Default');
  assert.equal((await latest('Temporary Target')).duration, 0);
  await admin('delete').expect(200);
});

test('the switch sport mode replaces skips its own and ended temporary switches', () => {
  const now = 10 * HOUR;
  const permanent = { date: HOUR, duration: 0, profile: 'A' };
  const ended = { date: 2 * HOUR, duration: 30, profile: 'B (80%)' };
  const running = { date: 9 * HOUR, duration: 120, profile: 'C' };
  const own = { date: 9.5 * HOUR, duration: 60, app: 'loopk', device: 'loopk-sport' };
  assert.equal(baseSwitch([own, ended, permanent], now), permanent);
  assert.equal(baseSwitch([own, running, ended, permanent], now), running);
  assert.equal(baseSwitch([], now), null);
});
