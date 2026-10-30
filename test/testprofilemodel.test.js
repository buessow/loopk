import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDelta } from '../public/testprofile-model.js';

const aiTest = { dia: 6, units: 'mmol', basal: [[0, 0.8], [21600, 1.1]], isf: [[0, 3.3]], ic: [[0, 10]], targetLow: [[0, 5.5]], targetHigh: [[0, 6]] };
const store = { name: 'P', dia: 5, units: 'mg/dl', isf: [[0, 54]], ic: [[0, 8], [43200, 10]], targetLow: [[0, 99]], targetHigh: [[0, 108]] };
const round = (list) => list.map((v) => (v == null ? null : Math.round(v)));

test('the AI Test profile differs from a profile per hour, in percent, glucose in either unit', () => {
  const d = testDelta(aiTest, [[0, 1]], store);
  assert.equal(round(d.basal)[0], -20);
  assert.equal(round(d.basal)[6], 10);
  assert.ok(round(d.isf).every((v) => v === 10));
  assert.equal(round(d.ic)[0], 25);
  assert.equal(round(d.ic)[12], 0);
  assert.ok(round(d.target).every((v) => v === 0));
  assert.deepEqual(d.dia, { test: 6, other: 5 });
});

test('without the profile\'s store entry only the basal differs', () => {
  const d = testDelta(aiTest, [[0, 0.8]], null);
  assert.equal(round(d.basal)[0], 0);
  assert.ok(d.isf.every((v) => v == null) && d.ic.every((v) => v == null));
  assert.equal(d.dia.other, null);
});
