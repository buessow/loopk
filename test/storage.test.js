import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { SCHEMAS } from '../src/db/schema.js';
import { CollectionStore, docToColumns } from '../src/db/collection.js';

let s;

before(async () => {
  s = await startServer();
});
after(() => s.close());

const PG_TYPES = {
  text: 'text', double: 'double precision', bigint: 'bigint', int: 'integer',
  bool: 'boolean', ts: 'timestamp with time zone', textArray: 'ARRAY', json: 'jsonb', jsonString: 'jsonb',
};

test('schema.js matches the tables', async () => {
  for (const [table, fields] of Object.entries(SCHEMAS)) {
    const { rows } = await s.ctx.pool.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [table]);
    const actual = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    const expected = Object.fromEntries(fields.map(([, col, type]) => [col, PG_TYPES[type]]));
    expected.extra = 'jsonb';
    assert.deepEqual(actual, expected, table);
  }
});

const common = (identifier) => ({
  identifier, date: 1760000000000, utcOffset: 120, created_at: '2025-10-09T08:53:20.000Z',
  app: 'AAPS', device: 'phone', srvCreated: 1, srvModified: 2, isValid: true,
});

async function roundTrip (table, doc) {
  const store = new CollectionStore(s.ctx.pool, table);
  await store.insert(doc);
  return store.findOne(doc.identifier);
}

test('devicestatus round-trips, with predictions in rows', async () => {
  const doc = {
    ...common('ds1'),
    uploaderBattery: 80,
    pump: { clock: '2025-10-09T08:53:00Z', reservoir: 120.5, battery: { percent: 60 }, status: { status: 'normal' }, extended: { ActiveProfile: 'Default', BaseBasalRate: 0.8 } },
    openaps: {
      iob: { iob: 1.2, basaliob: -0.1, time: '2025-10-09T08:53:00Z' },
      suggested: { bg: 120, eventualBG: 110, reason: 'ok', predBGs: { IOB: [120, 118, 116], ZT: [120, 115] } },
      enacted: { rate: 0.5, duration: 30, received: true, predBGs: { COB: [100.5] } },
    },
    configuration: { pump: 'Omnipod', insulin: 5, apsConfiguration: { maxIob: 3 } },
    somethingNew: { a: [1, 2] },
  };
  assert.deepEqual(await roundTrip('devicestatus', doc), doc);
  const { rows } = await s.ctx.pool.query(
    "SELECT source, curve, \"values\" FROM devicestatus_predictions WHERE devicestatus_identifier = 'ds1' ORDER BY 1, 2");
  assert.deepEqual(rows, [
    { source: 'enacted', curve: 'COB', values: [100.5] },
    { source: 'suggested', curve: 'IOB', values: [120, 118, 116] },
    { source: 'suggested', curve: 'ZT', values: [120, 115] },
  ]);
  const { rows: [row] } = await s.ctx.pool.query("SELECT extra, suggested_eventual_bg FROM devicestatus WHERE identifier = 'ds1'");
  assert.deepEqual(row.extra, { somethingNew: { a: [1, 2] } });
  assert.equal(row.suggested_eventual_bg, 110);
});

test('treatments keep profileJson and bolusCalculatorResult as structured data', async () => {
  const profile = {
    dia: 5, units: 'mmol', timezone: 'Europe/Zurich',
    basal: [{ time: '00:00', timeAsSeconds: 0, value: 0.8 }, { time: '06:00', timeAsSeconds: 21600, value: 1 }],
    sens: [{ time: '00:00', timeAsSeconds: 0, value: 2.5 }],
    custom: 'x',
  };
  const doc = {
    ...common('t1'), eventType: 'Effective Profile Switch', profile: 'Default', duration: 0,
    originalProfileName: 'Default', originalPercentage: 100, originalTimeshift: 0,
    profileJson: JSON.stringify(profile),
    bolusCalculatorResult: JSON.stringify({ glucoseValue: 7, wasCOBUsed: true }),
  };
  const back = await roundTrip('treatments', doc);
  assert.deepEqual(JSON.parse(back.profileJson), profile);
  assert.deepEqual(JSON.parse(back.bolusCalculatorResult), { glucoseValue: 7, wasCOBUsed: true });
  assert.deepEqual({ ...back, profileJson: 0, bolusCalculatorResult: 0 }, { ...doc, profileJson: 0, bolusCalculatorResult: 0 });
  const { rows } = await s.ctx.pool.query("SELECT kind, count(*)::int AS n FROM treatment_profile_schedules GROUP BY kind ORDER BY kind");
  assert.deepEqual(rows, [{ kind: 'basal', n: 2 }, { kind: 'sens', n: 1 }]);
});

test('profile stores round-trip', async () => {
  const schedule = [{ time: '00:00', timeAsSeconds: 0, value: 5.5 }];
  const doc = {
    ...common('p1'), defaultProfile: 'Default', startDate: '2025-10-09T08:53:20.000Z', units: 'mmol',
    store: {
      Default: { dia: 5, carbratio: schedule, sens: schedule, basal: schedule, target_low: schedule, target_high: schedule, units: 'mmol', timezone: 'UTC' },
      // Strings where numbers are expected: kept as-is in extra.
      Legacy: { dia: '4', basal: [{ time: '00:00', value: '0.7' }] },
    },
  };
  assert.deepEqual(await roundTrip('profile', doc), doc);
  const { rows } = await s.ctx.pool.query("SELECT name, dia, extra FROM profile_stores ORDER BY name");
  assert.deepEqual(rows, [
    { name: 'Default', dia: 5, extra: null },
    { name: 'Legacy', dia: null, extra: { dia: '4', basal: [{ time: '00:00', value: '0.7' }] } },
  ]);
});

test('values of the wrong type and nulls are kept in extra', () => {
  const { values, extra } = docToColumns(SCHEMAS.entries, { identifier: 'e', sgv: '120', direction: null, date: 1.5 });
  assert.deepEqual(values, { identifier: 'e' });
  assert.deepEqual(extra, { sgv: '120', direction: null, date: 1.5 });
});

test('patch merges into the stored document', async () => {
  const store = new CollectionStore(s.ctx.pool, 'treatments');
  await store.insert({ ...common('t2'), eventType: 'Note', notes: 'a', foo: 1 });
  const patched = await store.patch('t2', { notes: 'b', bar: true, srvModified: 3 });
  assert.equal(patched.notes, 'b');
  assert.equal(patched.foo, 1);
  assert.equal(patched.bar, true);
  assert.equal(await store.lastModified(), 3);
  assert.equal(await store.patch('missing', { notes: 'x' }), null);
});

test('bulkUpsert inserts and replaces documents, keeping their server timestamps', async () => {
  const store = new CollectionStore(s.ctx.pool, 'devicestatus');
  const doc = (id, eventual) => ({
    ...common(id), srvCreated: 100, srvModified: 200,
    openaps: { suggested: { eventualBG: eventual, algorithm: 'SMB', consoleLog: ['a', 'b'], predBGs: { IOB: [1, 2] } } },
  });
  await store.bulkUpsert([doc('b1', 100), doc('b2', 110), doc('b1', 101)]);
  assert.deepEqual(await store.findOne('b1'), doc('b1', 101));
  await store.bulkUpsert([{ ...doc('b2', 120), openaps: { suggested: { eventualBG: 120 } } }]);
  const b2 = await store.findOne('b2');
  assert.equal(b2.openaps.suggested.predBGs, undefined);
  assert.equal(b2.srvModified, 200);
  const { rows } = await s.ctx.pool.query("SELECT suggested_console_log FROM devicestatus WHERE identifier = 'b1'");
  assert.deepEqual(rows[0].suggested_console_log, ['a', 'b']);
});
