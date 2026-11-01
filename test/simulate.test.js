import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { signInUser } from '../src/web/session.js';
import { changedProfile, historyWithChanges, parseChanges } from '../src/oref/simulate.js';
import { glucoseStats } from '../src/oref/period.js';
import { loadSettingsTimeline } from '../src/oref/settings.js';
import { saveTestProfile, validProfile } from '../src/oref/testprofile.js';
import { localApi } from '../public/localapi.js';
import { loopkSettings, nightscoutSource } from '../src/data/nightscout/index.js';

const MIN = 60000;
const HOUR = 60 * MIN;
// The loop run the what-ifs decide again: glucose rising to 170 mg/dL.
const T = Date.UTC(2026, 9, 20, 12);
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const at = (seconds, value) => ({ time: `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:00`, timeAsSeconds: seconds, value });
const PROFILE = {
  dia: 5, units: 'mg/dl', timezone: 'UTC',
  basal: [at(0, 1)], sens: [at(0, 50)], carbratio: [at(0, 10)], target_low: [at(0, 100)], target_high: [at(0, 100)],
};
// SMBs whatever the carbs, so the what-ifs have SMBs to change.
const SMB_ALWAYS = { enableSMB_always: true };

let s;
let writer;
let reader;
let cookie;

/** Glucose (mg/dL) at t: 110, rising by 5 per 5 minutes in the hour before T, then falling back. */
function glucoseAt (t) {
  if (t <= T - HOUR) return 110;
  if (t <= T) return 110 + Math.round((t - (T - HOUR)) / (5 * MIN)) * 5;
  return Math.max(110, 170 - Math.round((t - T) / (5 * MIN)) * 3);
}

before(async () => {
  s = await startServer();
  writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const user = await signInUser(s.ctx.data, s.ctx.config, { email: 'admin@example.com' });
  cookie = `${s.ctx.auth.sessionCookieName()}=${s.ctx.auth.signSession(user)}`;
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'AAPS', device: 'phone', utcOffset: 0, ...doc }).expect(201);
  // The profile as AAPS uploads an effective profile switch.
  await post('treatments', {
    date: T - 3 * 24 * HOUR, eventType: 'Note', originalProfileName: 'Default', originalPercentage: 100, originalTimeshift: 0,
    profileJson: JSON.stringify(PROFILE),
  });
  for (let t = T - 40 * HOUR; t <= T + 3 * HOUR; t += 5 * MIN) {
    await post('entries', { type: 'sgv', date: t, sgv: glucoseAt(t), device: 'G7' });
  }
  await post('treatments', { eventType: 'Correction Bolus', date: T - 45 * MIN, insulin: 1 });
  // The loop's runs: every 5 minutes for the last 4 hours and an hour after T, without SMBs.
  for (let t = T - 4 * HOUR; t <= T + HOUR; t += 5 * MIN) {
    const run = {
      algorithm: 'SMB', runningDynamicIsf: false, bg: glucoseAt(t), eventualBG: glucoseAt(t), targetBG: 100, insulinReq: 0,
      sensitivityRatio: 1, variable_sens: 50, reason: 'COB: 0, Dev: 0, BGI: 0, ISF: 50, CR: 10, Target: 100; no change',
      deliverAt: new Date(t).toISOString(), timestamp: new Date(t).toISOString(),
    };
    await post('devicestatus', { date: t, device: 'openaps://phone', openaps: { suggested: run } });
  }
});
after(() => s.close());

/**
 * The simulator as a browser opening the page now answers it
 * (public/localworker.js): over loopk's API v3 and its stored settings,
 * read with the reader's token.
 */
async function inBrowser (req) {
  const data = await nightscoutSource({ url: s.url, token: reader.accessToken, settings: loopkSettings });
  try {
    return await localApi(data, { url: s.url, upstream: (path) => data.loader.client.get(path) })(req);
  } finally {
    await data.close();
  }
}
const answer = (req) => ({
  async expect (status) {
    const r = await inBrowser(req);
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r;
  },
});
const run = (changes) => answer({ method: 'POST', path: '/api/simulate/run', body: { time: T, changes } });
const period = (changes, k) => answer({ method: 'POST', path: '/api/simulate/period', body: { from: T - 2 * HOUR, to: T + HOUR, changes, ...(k ? { k } : {}) } });
const settingsAt = (t) => answer({ path: `/api/simulate/settings?at=${t}` });

test('a what-if decides the recorded run again, as recorded and with changes', async () => {
  const { body } = await run({ settings: SMB_ALWAYS }).expect(200);
  assert.equal(body.time, T);
  assert.equal(body.recorded.algorithm, 'SMB');
  assert.equal(body.recorded.bg, 170);
  assert.equal(typeof body.reproduces, 'boolean');
  assert.equal(body.baseline.bg, 170);
  assert.ok(body.baseline.iob > 0, 'the bolus 45 minutes before counts');
  // Unchanged settings: no SMB without enableSMB_always and no carbs; with it, an SMB.
  assert.equal(body.baseline.smb, 0);
  assert.ok(body.changed.smb > 0);
  assert.deepEqual(body.settings.changed, SMB_ALWAYS);
});

test('a larger SMB limit does not lower the SMB, max IOB 0 stops it', async () => {
  const base = (await run({ settings: { ...SMB_ALWAYS, maxSMBBasalMinutes: 15, maxUAMSMBBasalMinutes: 15 } }).expect(200)).body.changed;
  const more = (await run({ settings: { ...SMB_ALWAYS, maxSMBBasalMinutes: 120, maxUAMSMBBasalMinutes: 120 } }).expect(200)).body.changed;
  assert.ok(base.smb > 0);
  assert.ok(more.smb >= base.smb, `${more.smb} >= ${base.smb}`);
  const none = (await run({ settings: { ...SMB_ALWAYS, max_iob: 0 } }).expect(200)).body.changed;
  assert.equal(none.smb, 0);
  assert.ok(none.limits.some((l) => l.kind === 'maxIob'));
});

test('profile, temp target and algorithm changes reach the decision', async () => {
  const { body } = await run({ settings: SMB_ALWAYS, profile: { targetMgdl: 150 }, algorithm: 'AUTO_ISF' }).expect(200);
  assert.equal(body.changed.algorithm, 'AUTO_ISF');
  assert.equal(body.changed.targetBG, 150);
  const tt = (await run({ tempTarget: { targetMgdl: 160, minutes: 60 } }).expect(200)).body;
  assert.equal(tt.changed.targetBG, 160);
  assert.equal(tt.baseline.targetBG, 100);
});

test('a what-if checks its input and needs a run near the time', async () => {
  await run({ settings: { max_iob: 'lots' } }).expect(400);
  await run({ settings: { no_such_setting: 1 } }).expect(400);
  await run({ algorithm: 'MAGIC' }).expect(400);
  await answer({ method: 'POST', path: '/api/simulate/run', body: { time: T - 10 * 24 * HOUR } }).expect(404);
  await request(s.app).get('/api/simulate/stored').expect(401);
});

test('a period dosed unchanged keeps the glucose, more insulin lowers it', async () => {
  const unchanged = (await period({}).expect(200)).body;
  assert.equal(unchanged.errors, 0);
  // the loop decides as recorded: no SMBs, so the simulated glucose is the actual
  assert.equal(unchanged.simulated.insulin.smbCount, 0);
  assert.equal(unchanged.simulated.mean, unchanged.actual.mean);
  for (const [, actual, sim] of unchanged.series.glucose) assert.equal(sim, actual);

  const started = Date.now();
  const smbs = (await period({ settings: SMB_ALWAYS }).expect(200)).body;
  assert.ok(Date.now() - started < 10000, 'fast');
  assert.ok(smbs.simulated.insulin.smb > 0);
  assert.ok(smbs.simulated.mean < smbs.actual.mean);
  // never above the actual glucose, at every k
  for (const [, actual, sim, low, high] of smbs.series.glucose) {
    assert.ok(sim <= actual && low <= actual && high <= actual);
    assert.ok(high <= sim && sim <= low, 'a larger share lowers more');
  }
  assert.deepEqual(smbs.ks, [0.3, 0.45, 0.6]);
});

test('the browser simulates over the API as over the database', async () => {
  const direct = localApi({ ...s.ctx.data, access: { sub: 'watch', permissions: ['*:*:read'] } }, { url: s.url, upstream: async () => [] });
  const body = { time: T, changes: { settings: SMB_ALWAYS } };
  assert.deepEqual((await run(body.changes).expect(200)).body, (await direct({ method: 'POST', path: '/api/simulate/run', body })).body);
  const periodBody = { from: T - 2 * HOUR, to: T + HOUR, changes: {} };
  assert.deepEqual((await period({}).expect(200)).body, (await direct({ method: 'POST', path: '/api/simulate/period', body: periodBody })).body);
  assert.deepEqual((await settingsAt(T).expect(200)).body, (await direct({ path: `/api/simulate/settings?at=${T}` })).body);
  // The server no longer simulates.
  await request(s.app).post('/api/simulate/run').set(auth(reader)).send(body).expect(404);
  await request(s.app).post('/api/simulate/period').set(auth(reader)).send(periodBody).expect(404);
});

test('the browser answers the API itself on a Nightscout server', async () => {
  const upstream = async (path) => [{ path }];
  const browser = (access) => localApi({ ...s.ctx.data, access }, { url: 'https://ns.example.com', upstream });
  const reading = browser({ sub: 'watch', permissions: ['*:*:read'] });
  const session = (await reading({ path: '/api/session' })).body;
  assert.equal(session.user.email, 'watch@ns.example.com');
  assert.equal(session.isAdmin, false);
  assert.equal(session.inBrowser, true);
  // Bad input, a reader saving settings, what it does not answer, and API v3 sent on.
  assert.equal((await reading({ method: 'POST', path: '/api/simulate/run', body: { time: 'soon' } })).status, 400);
  assert.equal((await reading({ method: 'PUT', path: '/api/simulate/settings', body: { values: { max_iob: 3 } } })).status, 403);
  assert.equal((await reading({ path: '/api/reports/hours' })).status, 404);
  assert.deepEqual((await reading({ path: '/api/v3/entries?limit=1' })).body.result, [{ path: '/api/v3/entries?limit=1' }]);
  assert.equal((await browser({ sub: 'admin', permissions: ['*'] })({ path: '/api/session' })).body.isAdmin, true);
});

test('a stored profile can stand in for the one recorded', async () => {
  const half = { ...PROFILE, basal: [at(0, 0.5)], sens: [at(0, 100)] };
  await request(s.app).post('/api/v3/profile').set(auth(writer))
    .send({ date: T - 2 * 24 * HOUR, defaultProfile: 'Default', app: 'test', store: { Half: half } }).expect(201);
  const settings = (await settingsAt(T).expect(200)).body;
  assert.deepEqual(settings.profiles.toSorted(), ['Default', 'Half']);
  const { body } = await run({ profile: { name: 'Half' } }).expect(200);
  // Half's ISF instead of the recorded one
  assert.match(body.baseline.reason, /ISF: 50,/);
  assert.match(body.changed.reason, /ISF: 100,/);
  await run({ profile: { name: 'Nope' } }).expect(400);
});

test('the AI Test profile is simulated with, and an admin copies it into a profile', async () => {
  await run({ profile: { name: 'AI Test' } }).expect(400);
  const flat = (v) => [[0, v]];
  await saveTestProfile(s.ctx.data, {
    profile: { dia: 6, units: 'mg/dl', basal: flat(0.8), isf: flat(100), ic: flat(12), targetLow: flat(110), targetHigh: flat(110) },
    basedOn: 'Default', note: 'weaker ISF',
  }, 'agent');
  // offered on the simulate page and used like a stored profile
  const settings = (await settingsAt(T).expect(200)).body;
  assert.equal(settings.profiles[0], 'AI Test');
  const { body } = await run({ profile: { name: 'AI Test' } }).expect(200);
  assert.match(body.changed.reason, /ISF: 100,/);

  const view = (await request(s.app).get('/api/simulate/test-profile').set(auth(reader)).expect(200)).body;
  assert.equal(view.profile.note, 'weaker ISF');
  assert.deepEqual(view.stores.map((p) => [p.name, p.inStore]), [['Half', true], ['Default', false]]);
  assert.equal(view.follows, null);

  // only admins copy, into a profile the store has
  await request(s.app).post('/api/simulate/test-profile/copy').set(auth(reader)).send({ to: 'Half' }).expect(403);
  await request(s.app).post('/api/simulate/test-profile/copy').set('Cookie', cookie).send({ to: 'Nope' }).expect(404);
  await request(s.app).post('/api/simulate/test-profile/copy').set('Cookie', cookie).send({ to: 'Half' }).expect(200);
  // AAPS reads the new profile store: Half has the AI Test schedules
  const [doc] = (await request(s.app).get('/api/v3/profile?sort$desc=date&limit=1').set(auth(reader)).expect(200)).body.result;
  assert.equal(doc.store.Half.dia, 6);
  assert.deepEqual(doc.store.Half.sens, [{ time: '00:00', timeAsSeconds: 0, value: 100 }]);
  assert.deepEqual(doc.store.Half.basal, [{ time: '00:00', timeAsSeconds: 0, value: 0.8 }]);
  assert.equal(doc.store.Half.timezone, 'UTC');
  // a profile known only from a switch is added to the store, the others kept
  await request(s.app).post('/api/simulate/test-profile/copy').set('Cookie', cookie).send({ to: 'Default' }).expect(200);
  const added = (await request(s.app).get('/api/v3/profile?sort$desc=date&limit=1').set(auth(reader)).expect(200)).body.result[0];
  assert.deepEqual(Object.keys(added.store).sort(), ['Default', 'Half']);
  assert.equal(added.store.Default.dia, 6);
  assert.deepEqual(added.store.Default.sens, [{ time: '00:00', timeAsSeconds: 0, value: 100 }]);
  assert.equal(added.store.Default.timezone, 'UTC');

  await request(s.app).delete('/api/simulate/test-profile').set('Cookie', cookie).expect(200);
  assert.equal((await request(s.app).get('/api/simulate/test-profile').set(auth(reader)).expect(200)).body.profile, null);
});

test('a test profile needs whole schedules that start at midnight', () => {
  const ok = { dia: 5, units: 'mmol', basal: [[0, 1]], isf: [[0, 3]], ic: [[0, 10]], targetLow: [[0, 5.5]], targetHigh: [[0, 6]] };
  assert.equal(validProfile(ok).units, 'mmol');
  assert.throws(() => validProfile({ ...ok, basal: [[3600, 1]] }), /must start at 00:00/);
  assert.throws(() => validProfile({ ...ok, basal: [[0, 1], [0, 2]] }), /times must go up/);
  assert.throws(() => validProfile({ ...ok, isf: [[0, 100]] }), /isf: values must be/);
  assert.throws(() => validProfile({ ...ok, targetHigh: [[0, 5]] }), /below the low target/);
  assert.throws(() => validProfile({ ...ok, dia: 1 }), /DIA/);
});

test('a period lists every miss and the decisions of the simulated loop', async () => {
  const { body } = await period({ settings: SMB_ALWAYS }).expect(200);
  assert.ok(Array.isArray(body.misses.actualList) && Array.isArray(body.misses.simulatedList));
  assert.equal(body.misses.actualList.length, body.misses.actual);
  const runs = body.series.runs;
  assert.ok(runs.length > 30);
  assert.ok(runs.some((r) => r.smb > 0));
  for (const r of runs) assert.ok(r.t >= T - 2 * HOUR && r.t <= T + HOUR && r.bg > 0);
});

test('a period checks its length', async () => {
  const post = (body) => answer({ method: 'POST', path: '/api/simulate/period', body });
  await post({ from: T, to: T - HOUR }).expect(400);
  await post({ from: T - 15 * 24 * HOUR, to: T }).expect(400);
  await post({ from: T - HOUR, to: T, k: 7 }).expect(400);
});

test('settings entered by an admin become the baseline from their time', async () => {
  const before = (await settingsAt(T).expect(200)).body;
  assert.equal(before.values.enableSMB_always, false);
  assert.equal(before.sources.enableSMB_always, 'default');
  assert.equal(before.profile.isf[0][1], 50);
  await request(s.app).put('/api/simulate/settings').set(auth(reader)).send({ values: SMB_ALWAYS }).expect(403);
  await request(s.app).put('/api/simulate/settings').set('Cookie', cookie).send({ values: { max_iob: 'x' } }).expect(400);
  await request(s.app).put('/api/simulate/settings').set('Cookie', cookie).send({ values: SMB_ALWAYS, validFrom: T - HOUR }).expect(200);
  const after = (await settingsAt(T).expect(200)).body;
  // what the browser reads of them
  const stored = (await request(s.app).get('/api/simulate/stored').set(auth(reader)).expect(200)).body;
  assert.deepEqual(stored.loopSettings.map((r) => [r.setting, r.value, r.validFrom]), [['enableSMB_always', true, T - HOUR]]);
  assert.equal(after.values.enableSMB_always, true);
  assert.equal(after.sources.enableSMB_always, 'entered');
  const earlier = (await settingsAt(T - 2 * HOUR).expect(200)).body;
  assert.equal(earlier.values.enableSMB_always, false);
  // the what-if starts from them
  const { body } = await run({}).expect(200);
  assert.ok(body.baseline.smb > 0);
  // replays and periods take the settings in effect at each run
  const timeline = await loadSettingsTimeline(s.ctx.data, { from: T - 2 * HOUR, to: T });
  assert.equal(timeline.at(T - 2 * HOUR).values.enableSMB_always, false);
  assert.equal(timeline.at(T - HOUR).values.enableSMB_always, true);
  assert.equal(timeline.last.values.enableSMB_always, true);
  await s.ctx.data.pool.query('DELETE FROM loop_settings');
});

test('changes are checked and applied to the profile as a switch would', () => {
  assert.throws(() => parseChanges({ profile: { percentage: 1000 } }), /percentage/);
  assert.throws(() => parseChanges({ tempTarget: { targetMgdl: 50 } }), /tempTarget/);
  assert.throws(() => parseChanges({ sensitivityRatio: 9 }), /sensitivityRatio/);
  assert.deepEqual(parseChanges({ tempTarget: null }), { tempTarget: null });
  const eps = { percentage: 100, units: 'mmol', basal: [[0, 1]], isf: [[0, 3]], ic: [[0, 10]], targetLow: [[0, 5.5]], targetHigh: [[0, 5.5]] };
  const p = changedProfile(eps, { percentage: 200, isfFactor: 0.5, targetMgdl: 108 });
  assert.deepEqual(p.basal, [[0, 2]]);
  assert.deepEqual(p.isf, [[0, 0.75]]);
  assert.deepEqual(p.ic, [[0, 5]]);
  assert.deepEqual(p.targetLow, [[0, 6]]);
});

test('a temp target change ends the running one and sets its own', () => {
  const history = { profiles: [], tempTargets: [{ timestamp: T - HOUR, duration: 2 * HOUR, low: 80, high: 80 }, { timestamp: T + 30 * MIN, duration: HOUR, low: 90, high: 90 }] };
  const set = historyWithChanges(history, { tempTarget: { targetMgdl: 140, minutes: 30 } }, T, T + HOUR);
  assert.deepEqual(set.tempTargets.map((t) => [t.timestamp, t.duration, t.low]), [[T - HOUR, HOUR, 80], [T, 30 * MIN, 140], [T + 30 * MIN, HOUR, 90]]);
  const cancelled = historyWithChanges(history, { tempTarget: null }, T, T + HOUR);
  assert.deepEqual(cancelled.tempTargets.map((t) => [t.timestamp, t.duration]), [[T - HOUR, HOUR]]);
});

test('glucose statistics count the five ranges and episodes', () => {
  const readings = [50, 60, 65, 100, 150, 200, 260, 270, 100].map((value, i) => ({ timestamp: T + i * 5 * MIN, value }));
  const st = glucoseStats(readings);
  assert.equal(st.readings, 9);
  assert.equal(Math.round(st.ranges.veryLow * 9 / 100), 1);
  assert.equal(Math.round(st.ranges.low * 9 / 100), 2);
  assert.equal(Math.round(st.ranges.target * 9 / 100), 3);
  assert.equal(st.lows70, 1);
  assert.equal(st.lows54, 1);
  assert.equal(st.minutesBelow70, 15);
});
