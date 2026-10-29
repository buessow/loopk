// The "AI Test" profile on the Profiles page (GET /api/simulate/test-profile,
// src/oref/testprofile.js) next to a profile of the store: one row per
// schedule, as text, in the AI Test profile's glucose unit.

const MGDL_PER_MMOL = 18;
const isMmol = (units) => /^mmol/i.test(units || '');
const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
const num = (v) => String(Math.round(v * 100) / 100);

/** [[seconds, value]] as "00:00 0.8 · 06:00 1.1". */
export const scheduleText = (list) => (list || []).map(([s, v]) => `${hm(s)} ${num(v)}`).join(' · ');

/** A glucose schedule from units `from` into units `to`. */
function inUnits (list, from, to) {
  if (!list || isMmol(from) === isMmol(to)) return list;
  return list.map(([s, v]) => [s, isMmol(to) ? v / MGDL_PER_MMOL : v * MGDL_PER_MMOL]);
}

/**
 * Rows [label, AI Test, other, differs] for the AI Test profile `test` and a
 * profile of the store `other` (or null), glucose in the AI Test's unit.
 */
export function compareRows (test, other) {
  const glucose = isMmol(test.units) ? 'mmol/L' : 'mg/dL';
  const rows = [
    ['DIA (h)', num(test.dia), other ? num(other.dia) : ''],
    ['Basal (U/h)', scheduleText(test.basal), scheduleText(other?.basal)],
    [`ISF (${glucose} per U)`, scheduleText(test.isf), scheduleText(inUnits(other?.isf, other?.units, test.units))],
    ['Carb ratio (g per U)', scheduleText(test.ic), scheduleText(other?.ic)],
    [`Target low (${glucose})`, scheduleText(test.targetLow), scheduleText(inUnits(other?.targetLow, other?.units, test.units))],
    [`Target high (${glucose})`, scheduleText(test.targetHigh), scheduleText(inUnits(other?.targetHigh, other?.units, test.units))],
  ];
  return rows.map(([label, a, b]) => [label, a, b, !!other && a !== b]);
}

/** The profile to compare with first: the one it was based on, else the store's default, else the first. */
export function compareDefault (view) {
  const names = (view.stores || []).map((p) => p.name);
  return [view.profile?.basedOn, view.defaultProfile, names[0]].find((n) => n && names.includes(n)) ?? null;
}
