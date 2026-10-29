import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDefault, compareRows, scheduleText } from '../public/testprofile-model.js';

const aiTest = { dia: 6, units: 'mmol', basal: [[0, 0.8], [21600, 1.1]], isf: [[0, 3]], ic: [[0, 10]], targetLow: [[0, 5.5]], targetHigh: [[0, 6]] };
const store = { name: 'P', dia: 5, units: 'mg/dl', basal: [[0, 0.8], [21600, 1.1]], isf: [[0, 54]], ic: [[0, 9]], targetLow: [[0, 99]], targetHigh: [[0, 108]] };

test('a schedule reads as times and values', () => {
  assert.equal(scheduleText([[0, 0.8], [23400, 1.125]]), '00:00 0.8 · 06:30 1.13');
});

test('the AI Test profile compares with a store profile in its own glucose unit', () => {
  const rows = compareRows(aiTest, store);
  const row = (label) => rows.find((r) => r[0].startsWith(label));
  assert.deepEqual(row('Basal'), ['Basal (U/h)', '00:00 0.8 · 06:00 1.1', '00:00 0.8 · 06:00 1.1', false]);
  assert.deepEqual(row('ISF'), ['ISF (mmol/L per U)', '00:00 3', '00:00 3', false]);
  assert.deepEqual(row('Carb ratio'), ['Carb ratio (g per U)', '00:00 10', '00:00 9', true]);
  assert.deepEqual(row('DIA'), ['DIA (h)', '6', '5', true]);
  assert.ok(compareRows(aiTest, null).every((r) => r[2] === '' && !r[3]));
});

test('it compares with the profile it came from, else the default', () => {
  const stores = [{ name: 'A' }, { name: 'B' }];
  assert.equal(compareDefault({ profile: { basedOn: 'B' }, defaultProfile: 'A', stores }), 'B');
  assert.equal(compareDefault({ profile: { basedOn: 'Gone' }, defaultProfile: 'A', stores }), 'A');
  assert.equal(compareDefault({ profile: {}, stores }), 'A');
  assert.equal(compareDefault({ profile: {}, stores: [] }), null);
});
