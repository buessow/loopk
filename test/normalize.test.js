import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, legacyHeartRate, toMillis } from '../src/sync/normalize.js';

test('times in s, ms, µs and strings', () => {
  assert.equal(toMillis(1658343840), 1658343840000);
  assert.equal(toMillis(1658343840000), 1658343840000);
  assert.equal(toMillis(1693131715000000), 1693131715000);
  assert.equal(toMillis('2020-10-22T21:08:43Z'), Date.parse('2020-10-22T21:08:43Z'));
  assert.equal(toMillis('1586978220000'), 1586978220000);
  assert.equal(toMillis('1970-01-20T04:39:04.140Z'), null);
  assert.equal(toMillis(undefined), null);
});

test('API v1 treatment: dates, server timestamps, obsolete fields', () => {
  const v1 = { identifier: 'abc', eventType: 'Temp Basal', created_at: '2021-04-25T23:34:15Z', NSCLIENT_ID: '1619393655143', absolute: 1.7 };
  const t = Date.parse('2021-04-25T23:34:15Z');
  assert.deepEqual(normalize('treatments', v1), {
    identifier: 'abc', eventType: 'Temp Basal', absolute: 1.7,
    date: t, created_at: '2021-04-25T23:34:15.000Z', srvModified: t, srvCreated: t,
  });
});

test('API v3 documents keep their server timestamps', () => {
  const doc = { identifier: 'x', date: 1703845456604, created_at: '2023-12-29T10:24:16.604Z', srvCreated: 1703845455717, srvModified: 1703845500000 };
  assert.deepEqual(normalize('treatments', doc), doc);
});

test('entries get created_at; documents without a time are dropped', () => {
  const e = normalize('entries', { identifier: 'e', date: 1556575024000, sgv: 120, sysTime: 'x' });
  assert.equal(e.created_at, new Date(1556575024000).toISOString());
  assert.equal(e.sysTime, undefined);
  assert.equal(normalize('entries', { identifier: 'e', sgv: 1 }), null);
});

test('device status: tick as string, received spelled right, empty objects dropped', () => {
  const d = normalize('devicestatus', {
    identifier: 'd', created_at: '2021-09-22T21:07:18Z', configuration: {}, pump: {},
    openaps: { suggested: { tick: -3 }, enacted: { tick: 2, recieved: true } },
  });
  assert.deepEqual(d.openaps, { suggested: { tick: '-3' }, enacted: { tick: '+2', received: true } });
  assert.equal(d.configuration, undefined);
  assert.equal(d.pump, undefined);
});

test('profiles: numbers stored as strings', () => {
  const p = normalize('profile', {
    identifier: 'p', created_at: '2019-04-29T20:35:27.788Z', mills: '1586978220000',
    store: { Default: { dia: '5', basal: [{ time: '00:00', value: '0.56', timeAsSeconds: '0' }] } },
  });
  assert.equal(p.mills, 1586978220000);
  assert.deepEqual(p.store.Default, { dia: 5, basal: [{ time: '00:00', value: 0.56, timeAsSeconds: 0 }] });
  const t = normalize('treatments', { identifier: 't', date: 1700000000000, profileJson: JSON.stringify({ sens: [{ value: '2' }] }) });
  assert.deepEqual(JSON.parse(t.profileJson), { sens: [{ value: 2 }] });
});

test('heart rate stored in microseconds', () => {
  const h = normalize('heartrate', { identifier: 'h', date: 1693131715000000, created_at: '+055623-03-17T21:16:40.000Z', duration: 300000000, beatsPerMinute: 45 });
  assert.equal(h.date, 1693131715000);
  assert.equal(h.duration, 300000);
  assert.equal(h.created_at, new Date(1693131715000).toISOString());
});

test('legacy heart rate from treatments and the activity collection', () => {
  assert.deepEqual(legacyHeartRate({
    identifier: 'a', eventType: 'HeartRate', heartRate: 52, deviceId: '006-B3906-00_WF', isValid: true,
    samplingStart: '2023-08-26T12:51:00.000Z', samplingEnd: '2023-08-26T12:56:00.000Z', created_at: '2023-08-26T12:56:12.671Z',
  }), {
    identifier: 'a', date: Date.parse('2023-08-26T12:51:00.000Z'), created_at: '2023-08-26T12:51:00.000Z',
    duration: 300000, beatsPerMinute: 52, device: '006-B3906-00_WF', isValid: true,
    srvCreated: Date.parse('2023-08-26T12:56:00.000Z'), srvModified: Date.parse('2023-08-26T12:56:00.000Z'),
  });
  // samplingStart written as seconds-since-epoch milliseconds (1970): start from date (seconds).
  const r = legacyHeartRate({ identifier: 'b', heartRate: 55, samplingStart: '1970-01-20T04:39:04.140Z', created_at: '2022-07-20T19:09:01.184Z', date: 1658343840 });
  assert.equal(r.date, 1658343840000);
  assert.equal(r.duration, Date.parse('2022-07-20T19:09:01.184Z') - 1658343840000);
  assert.equal(legacyHeartRate({ identifier: 'c', heartRate: 60, test: true, created_at: '2022-07-20T19:09:01Z' }), null);
  assert.equal(legacyHeartRate({ identifier: 'c', heartRate: 60, deviceId: '006-B3110-00_DF-Sim', created_at: '2022-07-20T19:09:01Z' }), null);
});
