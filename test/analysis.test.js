import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startServer, tokenFor } from './helpers.js';
import { signInUser } from '../src/web/session.js';
import { uniqueRuns, timeFormatter } from '../src/analysis/prompt.js';
import { ClaudeReviewer, apiErrorMessage } from '../src/analysis/claude.js';

let s;
let reader;
let cookie;
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 1, 1, 12);
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });

// Stands in for Claude: records the request and streams a fixed answer.
const calls = [];
const fakeReviewer = {
  available: true,
  async review ({ system, messages, onText }) {
    calls.push({ system, messages, user: messages[0].content });
    onText('**Verdict**: About right');
    onText(' – the loop held off.');
    return { text: '', stopReason: 'end_turn' };
  },
};

before(async () => {
  s = await startServer();
  s.ctx.reviewer = fakeReviewer;
  const writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'watch', { canWrite: false });
  const user = await signInUser(s.ctx.pool, s.ctx.config, { email: 'admin@example.com' });
  cookie = `${s.ctx.auth.sessionCookieName()}=${s.ctx.auth.signSession(user)}`;
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);

  await post('profile', {
    date: t0 - 24 * HOUR,
    defaultProfile: 'P',
    store: {
      P: {
        units: 'mmol', dia: 5, basal: [entry('00:00', 0.9), entry('06:00', 1.1)], sens: [entry('00:00', 5.1)],
        carbratio: [entry('00:00', 9)], target_low: [entry('00:00', 5.5)], target_high: [entry('00:00', 6.5)],
      },
    },
  });
  for (let m = -60; m < 180; m += 5) await post('entries', { type: 'sgv', date: t0 + m * MIN, sgv: 150 + m / 5 });
  await post('treatments', { eventType: 'Meal Bolus', date: t0 + 10 * MIN, insulin: 4, carbs: 40 });
  await post('treatments', { eventType: 'Temp Basal', date: t0 + 30 * MIN, durationInMilliseconds: 30 * MIN, absolute: 2.5, rate: 2.5 });
  const run = { bg: 160, eventualBG: 120, targetBG: 100, IOB: 3.2, COB: 30, rate: 2.5, duration: 30, sensitivityRatio: 1.1, reason: 'COB: 30, Dev: 1, ISF: 5.1', algorithm: 'SMB', runningDynamicIsf: true, consoleError: ['Autosens ratio: 1.1'] };
  // The same run uploaded twice, as some phones do.
  await post('devicestatus', { date: t0 + 30 * MIN, device: 'openaps://phone', openaps: { suggested: run, enacted: run } });
  await post('devicestatus', { date: t0 + 30 * MIN + 2000, device: 'openaps://phone', openaps: { suggested: run, enacted: run } });
  await post('devicestatus', { date: t0 + 35 * MIN, device: 'openaps://phone', openaps: { suggested: { ...run, rate: -1, duration: -1, reason: 'no temp required', algorithm: 'AUTO_ISF' } }, configuration: { aps: 'AUTO_ISF', apsConfiguration: { use_dynamic_sensitivity: false } } });
});
after(() => s.close());

const ask = (body) => request(s.app).post('/api/analysis').set('Cookie', cookie).send(body);

test('a review streams Claude\'s answer about the selected period', async () => {
  const res = await ask({ from: t0, to: t0 + HOUR, tz: 'UTC', units: 'mg/dL', question: 'Pizza at noon' }).expect(200);
  assert.match(res.headers['content-type'], /^text\/markdown/);
  assert.equal(res.text, '**Verdict**: About right – the loop held off.');

  const { system, user } = calls.at(-1);
  assert.match(system, /How AAPS doses/);
  assert.match(user, /The person selected Sun 1 Feb 12:00 – Sun 1 Feb 13:00 \(UTC\)/);
  assert.match(user, /The person adds: Pizza at noon/);
  // The answer uses the page's glucose unit and starts with a plain explanation.
  assert.match(user, /The person reads glucose in mg\/dL\. Write every glucose value, target, glucose change and ISF in your answers and marks in mg\/dL/);
  assert.match(user, /2\. \*\*In plain words\*\*: 3 to 6 sentences/);
  // Readings from 6 h before (here from 11:00) to 3 h after, the window marked.
  assert.match(user, /\n \| Sun 1 Feb 11:00 \| 138 \| 7\.7 \|/);
  assert.match(user, /\n\* \| Sun 1 Feb 12:00 \| 150 \| 8\.3 \|/);
  assert.match(user, /\n \| Sun 1 Feb 14:55 \| 185 \|/);
  assert.match(user, /Meal Bolus \| 4 U, 40 g carbs/);
  assert.match(user, /Temp Basal \| 2\.5 U\/h for 30 min/);
  assert.match(user, /Basal \(U\/h\): 00:00 0\.9, 06:00 1\.1/);
  assert.match(user, /ISF \(mmol per U\): 00:00 5\.1/);
  assert.match(user, /APS: AUTO_ISF/);
  assert.match(user, /APS settings: \{"use_dynamic_sensitivity":false\}/);
  // The algorithm as each run reported it, also when it changed.
  assert.match(user, /- Sun 1 Feb 12:30 to Sun 1 Feb 12:30: SMB, dynamic ISF true\n- Sun 1 Feb 12:35 to Sun 1 Feb 12:35: AUTO_ISF, dynamic ISF true/);
  // consoleError is the algorithm's normal output.
  assert.match(user, /#### Sun 1 Feb 12:30\nAutosens ratio: 1\.1/);
  assert.doesNotMatch(user, /ERROR/);
  // The duplicate upload is dropped; "no temp" (-1) shows as empty.
  assert.match(user, /### Loop runs \(2\)/);
  assert.match(user, /\* \| Sun 1 Feb 12:30 \| 160 \| 120 \| 100 \| 3\.2 \|  \| 30 \|  \| 1\.1 \|  \| 2\.5 \| 30 \|  \| yes \| COB: 30/);
  assert.match(user, /\* \| Sun 1 Feb 12:35 \| 160 \| 120 \| 100 \| 3\.2 \|  \| 30 \|  \| 1\.1 \|  \|  \|  \|  \|  \| no temp required/);
});

test('a review needs a person signed in, not an access token', async () => {
  await request(s.app).post('/api/analysis').send({ from: t0, to: t0 + HOUR }).expect(401);
  await request(s.app).post('/api/analysis').set(auth(reader)).send({ from: t0, to: t0 + HOUR }).expect(403);
});

test('a review checks the period and that it has readings', async () => {
  await ask({ from: t0 + HOUR, to: t0 }).expect(400);
  await ask({ from: t0, to: t0 + 13 * HOUR }).expect(400);
  await ask({ from: t0, to: t0 + HOUR, tz: 'Nowhere/Else' }).expect(400);
  await ask({ from: t0, to: t0 + HOUR, units: 'mg' }).expect(400);
  await ask({ from: t0, to: t0 + HOUR, question: 'x'.repeat(2001) }).expect(400);
  const res = await ask({ from: t0 - 48 * HOUR, to: t0 - 47 * HOUR }).expect(422);
  assert.match(res.body.message, /no glucose readings/);
});

test('without an API key reviews are unavailable', async () => {
  s.ctx.reviewer = { available: false };
  try {
    const res = await ask({ from: t0, to: t0 + HOUR }).expect(503);
    assert.match(res.body.message, /Access page/);
  } finally {
    s.ctx.reviewer = fakeReviewer;
  }
});

test('loop runs uploaded twice within a minute count once', () => {
  const runs = [{ date: 0, reason: 'a' }, { date: 2000, reason: 'a' }, { date: 4000, reason: 'b' }, { date: 300000, reason: 'b' }];
  assert.deepEqual(uniqueRuns(runs).map((r) => r.date), [0, 4000, 300000]);
});

test('times are shown in the person\'s time zone', () => {
  assert.equal(timeFormatter('Europe/Zurich')(Date.UTC(2026, 6, 1, 22, 5)), 'Thu 2 Jul 00:05');
});

test('admins set the Anthropic API key on the Access page', async () => {
  const { auth, pool, config } = s.ctx;
  await pool.query("INSERT INTO users (email) VALUES ('viewer@example.com') ON CONFLICT DO NOTHING");
  const viewer = `${auth.sessionCookieName()}=${auth.signSession(await signInUser(pool, config, { email: 'viewer@example.com' }))}`;
  // A reviewer as the server makes it, with a stand-in for the Anthropic client.
  const reviewer = new ClaudeReviewer(pool, { apiKey: 'sk-env-1234' }, {
    createClient: async (apiKey) => ({
      models: {
        async retrieve (model) {
          if (apiKey !== 'sk-good-5678') throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
          return { id: model };
        },
      },
    }),
  });
  await reviewer.load();
  s.ctx.reviewer = reviewer;
  try {
    const put = (body) => request(s.app).put('/api/admin/claude').set('Cookie', cookie).send(body);
    await request(s.app).get('/api/admin/claude').set('Cookie', viewer).expect(403);
    await request(s.app).put('/api/admin/claude').set('Cookie', viewer).send({ apiKey: 'sk-good-5678' }).expect(403);

    let res = await request(s.app).get('/api/admin/claude').set('Cookie', cookie).expect(200);
    assert.deepEqual([res.body.keySet, res.body.keyEnd, res.body.source, res.body.model], [true, '1234', 'environment', 'claude-opus-5-5']);

    res = await put({ apiKey: 'sk-bad' }).expect(400);
    assert.equal(res.body.message, 'Anthropic did not accept this API key');
    await put({}).expect(400);

    res = await put({ apiKey: ' sk-good-5678 ' }).expect(200);
    assert.deepEqual([res.body.keyEnd, res.body.source, res.body.updatedBy], ['5678', 'settings', 'admin@example.com']);
    assert.equal(JSON.stringify(res.body).includes('sk-good'), false);
    assert.equal(reviewer.setting.apiKey, 'sk-good-5678');
    // Kept across restarts.
    const restarted = new ClaudeReviewer(pool, {});
    await restarted.load();
    assert.equal(restarted.setting.apiKey, 'sk-good-5678');

    // Removing it falls back to ANTHROPIC_API_KEY, or turns reviews off without it.
    res = await request(s.app).delete('/api/admin/claude').set('Cookie', cookie).expect(200);
    assert.deepEqual([res.body.keyEnd, res.body.source], ['1234', 'environment']);
    reviewer.envKey = '';
    await reviewer.load();
    assert.equal(reviewer.available, false);
    await ask({ from: t0, to: t0 + HOUR }).expect(503);
    // The glucose page shows "Ask Claude" only with a key.
    assert.equal((await request(s.app).get('/api/session').set('Cookie', cookie).expect(200)).body.claude, false);
    await put({ apiKey: 'sk-good-5678' }).expect(200);
    assert.equal((await request(s.app).get('/api/session').set('Cookie', cookie).expect(200)).body.claude, true);
  } finally {
    s.ctx.reviewer = fakeReviewer;
  }
});

test('an API error shows only its message', async () => {
  const { APIError } = await import('@anthropic-ai/sdk');
  const body = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' }, request_id: 'req_1' };
  assert.equal(apiErrorMessage(APIError.generate(400, body, undefined, new Headers())), 'Your credit balance is too low.');
  assert.equal(apiErrorMessage(new Error('socket hang up')), 'socket hang up');

  s.ctx.reviewer = { available: true, async review () { throw APIError.generate(400, body, undefined, new Headers()); } };
  try {
    const res = await ask({ from: t0, to: t0 + HOUR }).expect(200);
    assert.equal(res.text, '\n\n**The review failed:** Your credit balance is too low.');
  } finally {
    s.ctx.reviewer = fakeReviewer;
  }
});

test('a follow-up question sends the conversation after the records', async () => {
  const conversation = [
    { role: 'assistant', text: '**Verdict**: About right (1).' },
    { role: 'user', text: 'Why no SMB at 12:30?' },
  ];
  const res = await ask({ from: t0, to: t0 + HOUR, tz: 'UTC', units: 'mg/dL', question: 'Pizza at noon', conversation }).expect(200);
  assert.equal(res.text, '**Verdict**: About right – the loop held off.');
  const { messages } = calls.at(-1);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  // The records exactly as in the first request, so they are cached.
  assert.equal(messages[0].content, calls.at(-2).messages[0].content);
  assert.deepEqual(messages.slice(1).map((m) => m.content), ['**Verdict**: About right (1).', 'Why no SMB at 12:30?']);
});

test('a conversation must alternate answers and questions and end with a question', async () => {
  const a = { role: 'assistant', text: 'Answer' };
  const q = { role: 'user', text: 'Question?' };
  for (const conversation of [[a], [q, a], [a, a], [a, { role: 'user', text: ' ' }], [a, { role: 'user', text: 'x'.repeat(2001) }],
    Array.from({ length: 22 }, (_, i) => (i % 2 ? q : a)), 'text']) {
    await ask({ from: t0, to: t0 + HOUR, conversation }).expect(400);
  }
  await ask({ from: t0, to: t0 + HOUR, conversation: Array.from({ length: 20 }, (_, i) => (i % 2 ? q : a)) }).expect(200);
});
