// The "AI Test" profile on the Profiles page (GET /api/simulate/test-profile,
// src/oref/testprofile.js) against a profile of the page: its basal per hour
// of day, and how much it differs from that profile, per hour.

import { hourlyProfile } from './profiles-model.js';

const MGDL_PER_MMOL = 18;
const isMmol = (units) => /^mmol/i.test(units || '');

/** A glucose schedule from units `from` into units `to`. */
function inUnits (list, from, to) {
  if (!list || isMmol(from) === isMmol(to)) return list;
  return list.map(([s, v]) => [s, isMmol(to) ? v / MGDL_PER_MMOL : v * MGDL_PER_MMOL]);
}

/** Per hour, how much `a` is above `b` (%), null where either is unknown or b is 0. */
function percent (a, b) {
  return a.map((v, h) => (v == null || b[h] == null || !b[h] ? null : 100 * (v / b[h] - 1)));
}

/**
 * The AI Test profile `test` against a profile: `schedule` is its basal
 * ([[seconds, U/h]], the version shown), `other` its store entry (ISF, carb
 * ratio, targets and DIA; null if unknown). Per hour of day, how much the AI
 * Test's basal, ISF, carb ratio and low target are above the profile's (%),
 * null where the profile's is unknown; and both DIAs (h).
 */
export function testDelta (test, schedule, other) {
  const hourly = (list) => (list?.length ? hourlyProfile(list) : new Array(24).fill(null));
  const glucose = (kind) => hourly(inUnits(other?.[kind], other?.units, test.units));
  return {
    basal: percent(hourly(test.basal), hourly(schedule)),
    isf: percent(hourly(test.isf), glucose('isf')),
    ic: percent(hourly(test.ic), hourly(other?.ic)),
    target: percent(hourly(test.targetLow), glucose('targetLow')),
    dia: { test: test.dia, other: other?.dia ?? null },
  };
}
