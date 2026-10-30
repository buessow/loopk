import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, tokenFor } from './helpers.js';
import { glucose, localTime, pageLink, summarize } from '../src/mcp/data.js';
import { linkGuide } from '../src/mcp/server.js';
import { simulateLink, toolChanges } from '../src/mcp/simulate.js';
import { parseView } from '../public/view.js';
import { COLUMNS } from '../src/reports/index.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const t0 = Date.UTC(2026, 9, 24, 4);
const auth = (t) => ({ Authorization: `Bearer ${t.jwt}` });
const entry = (time, value) => ({ time, timeAsSeconds: Number(time.slice(0, 2)) * 3600, value });

let s;
let reader;
let client;

before(async () => {
  s = await startServer({ TIME_ZONE: 'Europe/Zurich', PUBLIC_URL: 'https://loopk.example/' });
  const writer = await tokenFor(s.ctx, 'aaps');
  reader = await tokenFor(s.ctx, 'agent', { canWrite: false });
  const post = (col, doc) => request(s.app).post(`/api/v3/${col}`).set(auth(writer))
    .send({ app: 'test', device: 'test', utcOffset: 0, ...doc }).expect(201);

  await post('profile', {
    date: t0 - 24 * HOUR,
    defaultProfile: 'P',
    store: {
      P: {
        units: 'mmol', dia: 5, timezone: 'Europe/Zurich', basal: [entry('00:00', 1)], sens: [entry('00:00', 5.4)],
        carbratio: [entry('00:00', 9)], target_low: [entry('00:00', 5.5)], target_high: [entry('00:00', 6.5)],
      },
    },
  });
  // Rescue carbs at 72 mg/dL, 2 U of SMB for them, a rise to 126 and a low of 54 within the hour.
  const curve = [[-60, 90], [0, 72], [30, 126], [70, 54], [80, 54], [120, 99], [180, 108]];
  for (let i = 0; i < curve.length - 1; i++) {
    const [m0, v0] = curve[i];
    const [m1, v1] = curve[i + 1];
    for (let m = m0; m < m1; m += 5) await post('entries', { type: 'sgv', date: t0 + m * MIN, sgv: Math.round(v0 + (v1 - v0) * (m - m0) / (m1 - m0)), device: 'G7 Native' });
  }
  await post('treatments', { eventType: 'Meal Bolus', date: t0, carbs: 20 });
  await post('treatments', { eventType: 'Temporary Target', date: t0 + 5 * MIN, duration: 60, targetBottom: 144, targetTop: 144, reason: 'Hypo', units: 'mg/dl' });
  const reason = 'COB: 20, Dev: 1.0, ISF: 5.6, CR: 9, Target: 6.1, minPredBG 7.0, minGuardBG 5.0, IOBpredBG 3.0, COBpredBG 12.0; Eventual BG 12.0 >= 6.1, insulinReq 0.9; maxBolus 0.5. Microbolusing 0.5U.';
  for (const m of [10, 15, 20, 25]) {
    await post('treatments', { eventType: 'Correction Bolus', date: t0 + m * MIN, insulin: 0.5, type: 'SMB', isSMB: true });
    const run = {
      bg: 90, eventualBG: 216, targetBG: 110, variable_sens: 100, insulinReq: 0.9, COB: 20, IOB: 0.5, units: 0.5, rate: -1, duration: -1,
      algorithm: 'SMB', runningDynamicIsf: false, reason, predBGs: { IOB: [90, 81, 72], COB: [90, 108, 126] }, consoleError: ['Autosens ratio: 1.0'],
    };
    await post('devicestatus', { date: t0 + m * MIN, device: 'openaps://phone', openaps: { suggested: run, enacted: { ...run, smb: 0.5 } } });
  }

  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp?token=${reader.accessToken}`)));
});
after(async () => {
  await client?.close();
  await s.close();
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError ? r.content[0].text : null, body: r.isError ? null : (r.content[0].text.startsWith('{') ? JSON.parse(r.content[0].text) : r.content[0].text) };
};
const range = { from: new Date(t0 - HOUR).toISOString(), to: new Date(t0 + 3 * HOUR).toISOString() };

test('the MCP server lists its tools, read-only but for the test profile, and the AAPS guide', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'get_algorithm_guide', 'get_glucose', 'get_heart_rate', 'get_loop_runs', 'get_loop_settings', 'get_misses', 'get_profile',
    'get_profile_usage', 'get_statistics', 'get_status', 'get_test_profile', 'get_treatments', 'set_test_profile', 'simulate_period', 'simulate_run',
  ]);
  assert.deepEqual(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ['set_test_profile']);
  const { contents: [guide] } = await client.readResource({ uri: 'loopk://docs/aaps-algorithms' });
  assert.match(guide.text, /^# How AAPS doses/);
  assert.equal((await call('get_algorithm_guide')).body, guide.text);
});

test('the MCP server needs read access', async () => {
  await request(s.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
  await request(s.app).get(`/mcp?token=${reader.accessToken}`).expect(405);
});

test('statistics give mean, GMI and time in ranges in the asked unit', async () => {
  const { body } = await call('get_statistics', range);
  assert.equal(body.units, 'mmol/L');
  assert.equal(body.readings, 48);
  assert.equal(body.timeInRangesPercent.low, round1(100 * 6 / 48));
  assert.equal(body.timeInRangesPercent.veryLow, 0);
  assert.ok(body.gmiPercent > 5 && body.gmiPercent < 6);
  assert.equal(body.insulin.bolusUnits, 2);
  assert.equal(body.carbs.totalGrams, 20);
  const mg = (await call('get_statistics', { ...range, units: 'mg/dL', group_by: 'hour_of_day' })).body;
  assert.equal(Math.round(mg.meanGlucose / 18 * 10) / 10, body.meanGlucose);
  // 03:00 to 07:00 UTC is 05:00 to 09:00 in Zurich (summer time).
  assert.deepEqual(mg.hoursOfDay.map((h) => h.hour), [5, 6, 7, 8]);
});

test('glucose and treatments come with local times', async () => {
  const g = (await call('get_glucose', range)).body;
  assert.deepEqual(g.readings[0], ['2026-10-24T05:00:00+02:00', 5, null]);
  const t = (await call('get_treatments', { ...range, units: 'mg/dL' })).body.treatments;
  assert.deepEqual(t.find((x) => x.event === 'Temporary Target'), { time: '2026-10-24T06:05:00+02:00', event: 'Temporary Target', minutes: 60, target: [144, 144], reason: 'Hypo' });
  assert.deepEqual(t.filter((x) => x.smb).map((x) => x.insulin), [0.5, 0.5, 0.5, 0.5]);
});

test('misses find the SMBs for rescue carbs before the low', async () => {
  const { body } = await call('get_misses', range);
  const [miss] = body.misses;
  assert.equal(body.misses.length, 1);
  assert.equal(miss.kind, 'low');
  assert.equal(miss.glucose, 3);
  assert.deepEqual(miss.flags, ['SMBs after rescue carbs']);
  assert.match(miss.summary, /^Low of 3 mmol\/L after 2 U of SMB in the hour before/);
  assert.equal(miss.expected.minGuardBG, 5);
});

test('loop runs show what the algorithm computed, with curves and console on request', async () => {
  const hour = { from: new Date(t0).toISOString(), to: new Date(t0 + HOUR).toISOString() };
  const { body } = await call('get_loop_runs', { ...hour, curves: true, console: true });
  assert.equal(body.runs.length, 4);
  const [run] = body.runs;
  assert.equal(run.time, '2026-10-24T06:10:00+02:00');
  assert.equal(run.bg, 5);
  assert.equal(run.minPredBG, 7);
  assert.equal(run.minGuardBG, 5);
  assert.equal(run.temp, null);
  assert.equal(run.smbGiven, 0.5);
  assert.deepEqual(run.limits, [{ kind: 'smbSize', value: 0.5 }]);
  assert.deepEqual(run.predictionCurves.IOB, [5, 4.5, 4]);
  assert.deepEqual(run.console, ['Autosens ratio: 1.0']);
  assert.deepEqual(body.algorithmPeriods.map((p) => p.algorithm), ['SMB']);
  // The console log only for short periods.
  assert.equal((await call('get_loop_runs', range)).body.runs.length, 4);
  assert.match((await call('get_loop_runs', { ...range, console: true })).error, /At most 3 hours/);
});

test('the profile reads in the asked unit, the status has the latest values', async () => {
  const p = (await call('get_profile', { at: new Date(t0).toISOString(), units: 'mg/dL' })).body;
  assert.deepEqual(p.isfPerUnit, [['00:00', 97]]);
  assert.deepEqual(p.basalUnitsPerHour, [['00:00', 1]]);
  const st = (await call('get_status')).body;
  // The last reading, 107 mg/dL.
  assert.equal(st.glucose.value, 5.9);
  assert.equal(st.loop.algorithm, 'SMB');
  assert.equal(st.profile.name, 'P');
  assert.ok('last24Hours' in st);
});

test('glucose, statistics, misses and loop runs link to the glucose page showing them', async () => {
  const page = 'https://loopk.example/?start=2026-10-24T05:00%2B02:00&duration=4h';
  assert.equal((await call('get_glucose', range)).body.link, page);
  assert.equal((await call('get_statistics', range)).body.link, page);
  assert.equal((await call('get_loop_runs', range)).body.link, `${page}&show=basal,loop`);
  // A miss as the page's list selects it: from the hour before the low to 30 minutes after it.
  const [miss] = (await call('get_misses', range)).body.misses;
  assert.equal(miss.link, 'https://loopk.example/?start=2026-10-24T06:05%2B02:00&duration=125m&show=basal,loop');
  // Statistics cover the readings there are.
  assert.equal((await call('get_statistics', { from: '2025-11-01T00:00Z', to: range.to })).body.link, page);
});

test('the instructions tell the agent how to link to the glucose page', () => {
  const instructions = client.getInstructions();
  assert.match(instructions, /Link the person to what you discuss/);
  assert.match(instructions, /https:\/\/loopk\.example\/\?start=<.*>&duration=<.*>&show=<.*>/);
  // The format it describes is the page's.
  const t = Date.UTC(2026, 9, 24, 4);
  assert.deepEqual(parseView('?start=2026-10-24T06:00%2B02:00&duration=90m&show=basal,loop'), { start: t, duration: 90 * MIN, show: ['basal', 'loop'] });
  assert.equal(linkGuide(''), '');
});

test('a link to a period longer than the page shows is its last 30 days, none without a public URL', () => {
  const to = Date.parse(range.to);
  assert.equal(pageLink('https://loopk.example', { from: to - 90 * 24 * HOUR, to, timeZone: 'Europe/Zurich' }),
    'https://loopk.example/?start=2026-09-24T09:00%2B02:00&duration=30d');
  assert.equal(pageLink('', { from: t0, to }), null);
});

test('the loop settings list their values, sources and AAPS\'s defaults', async () => {
  const { body } = await call('get_loop_settings', { at: new Date(t0).toISOString() });
  assert.equal(body.values.maxSMBBasalMinutes, 30);
  assert.equal(body.sources.maxSMBBasalMinutes, 'default');
  assert.equal(body.defaults.max_iob, body.values.max_iob);
  assert.equal(body.at, '2026-10-24T06:00:00+02:00');
});

test('what-ifs explain what they can\'t simulate', async () => {
  assert.match((await call('simulate_run', { time: new Date(t0 - 5 * HOUR).toISOString() })).error, /No loop run within 5 minutes/);
  assert.match((await call('simulate_run', { time: new Date(t0).toISOString(), changes: { settings: { max_iob: true } } })).error, /max_iob must be a number/);
  assert.match((await call('simulate_period', { from: range.from, to: new Date(t0 + 15 * 24 * HOUR).toISOString() })).error, /At most 14 days/);
});

test('what-if changes come in the agent\'s unit and link to the simulate page', () => {
  assert.deepEqual(toolChanges({ profile: { target: 6, percentage: 90 }, tempTarget: { target: 8 } }, 'mmol/L'), {
    profile: { percentage: 90, targetMgdl: 108 },
    tempTarget: { targetMgdl: 144, minutes: 60 },
  });
  assert.deepEqual(toolChanges({ tempTarget: null, settings: { max_iob: 3 } }, 'mg/dL'), { tempTarget: null, settings: { max_iob: 3 } });
  assert.equal(simulateLink('https://loopk.example', { run: 1000 }), 'https://loopk.example/simulate?run=1000');
  assert.equal(simulateLink('https://loopk.example', { from: 1000, to: 2000 }), 'https://loopk.example/simulate?from=1000&to=2000');
  assert.equal(simulateLink(null, { run: 1000 }), null);
});

test('bad arguments are tool errors the agent can read', async () => {
  assert.match((await call('get_glucose', { from: 'yesterday' })).error, /^from is not a time/);
  assert.match((await call('get_glucose', { from: range.to, to: range.from })).error, /from must be before to/);
  assert.match((await call('get_glucose', { timeZone: 'Mars/Base' })).error, /Unknown time zone/);
});

test('values are converted and summed as an agent reads them', () => {
  assert.equal(glucose(126, 'mmol/L'), 7);
  assert.equal(glucose(126.4, 'mg/dL'), 126);
  assert.equal(localTime(Date.UTC(2026, 9, 25, 12), 'Europe/Zurich'), '2026-10-25T13:00:00+01:00');
  const row = (values) => COLUMNS.map((c) => values[c] ?? 0);
  const stats = summarize([row({ readings: 12, sgvSum: 12 * 180, sgvSquares: 12 * 180 * 180, target: 12, bolus: 1, basal: 1 })], 'mg/dL');
  assert.equal(stats.meanGlucose, 180);
  assert.equal(stats.sdGlucose, 0);
  assert.equal(stats.gmiPercent, 7.6);
  assert.equal(stats.coveragePercent, 100);
  assert.equal(stats.insulin.totalPerDay, 48);
});

function round1 (v) {
  return Math.round(v * 10) / 10;
}

test('an agent writes the AI Test profile from a stored one, glucose in its unit', async () => {
  assert.equal((await call('get_test_profile')).body.exists, false);
  const { body } = await call('set_test_profile', { isf: [['00:00', 3], ['12:00', 2.5]], target_low: [['00:00', 5]], note: 'stronger ISF' });
  assert.equal(body.basedOn, 'P');
  assert.deepEqual(body.isfPerUnit, [['00:00', 3], ['12:00', 2.5]]);
  // kept from P
  assert.deepEqual(body.basalUnitsPerHour, [['00:00', 1]]);
  assert.deepEqual(body.targetHigh, [['00:00', 6.5]]);
  assert.equal(body.updatedBy, 'agent');
  assert.equal(body.link, 'https://loopk.example/profiles');
  // in mg/dL the same profile
  const mgdl = (await call('get_test_profile', { units: 'mg/dL' })).body;
  assert.deepEqual(mgdl.isfPerUnit[0], ['00:00', 54]);
  // a later change keeps the rest
  const later = (await call('set_test_profile', { dia_hours: 6 })).body;
  assert.equal(later.diaHours, 6);
  assert.deepEqual(later.isfPerUnit[1], ['12:00', 2.5]);
  assert.match((await call('set_test_profile', { basal: [['06:00', 1]] })).error, /must start at 00:00/);
  assert.match((await call('set_test_profile', { based_on: 'Nope' })).error, /No stored profile named Nope/);
  await s.ctx.data.pool.query('DELETE FROM test_profiles');
});
