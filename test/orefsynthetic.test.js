import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { differences, fromKotlin, generateCases, parseKotlin, portDecision } from './orefsynthetic.js';

// AAPS's own determine_basal (commit 423a4502f2) on synthetic cases of
// seed 2, as scripts/oref-cases.js has AAPS run them: the first 600, and
// the 93 of 30,000 (2 of them among the 600) where the port once wrote "-0"
// for a value Java's Math.round makes 0.
const results = readFileSync(new URL('./fixtures/orefsynthetic.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map(parseKotlin);
const index = (id) => Number(id.split('-')[1]);
const generated = generateCases(2, Math.max(...results.map((r) => index(r.id))) + 1);
const cases = results.map((r) => generated[index(r.id)]);

test('the synthetic cases are the ones AAPS ran', () => {
  assert.equal(results.length, 691);
  assert.deepEqual(results.map((r) => r.id), cases.map((c) => c.id));
});

test('the port decides the synthetic runs as AAPS does, reason included', () => {
  const failed = [];
  for (const [i, c] of cases.entries()) {
    const diffs = differences(fromKotlin(results[i].result), portDecision(c));
    if (diffs.length) failed.push({ id: c.id, algorithm: c.algorithm, diffs });
  }
  assert.deepEqual(failed, []);
});

test('the synthetic cases reach SMBs, low suspends, carbs required and stale glucose', () => {
  const count = (f) => results.filter((r) => f(r.result)).length;
  assert.ok(count((r) => r.units > 0) >= 30);
  assert.ok(count((r) => /minGuardBG -?[\d.]+ < /.test(r.reason)) >= 100);
  assert.ok(count((r) => r.carbsReq > 0) >= 50);
  assert.ok(count((r) => /too old/.test(r.reason)) >= 10);
});
