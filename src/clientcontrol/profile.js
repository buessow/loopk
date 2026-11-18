// AAPS's local profiles as one synced preference, `local_profile_data`
// (aaps-dev ProfileRepositoryImpl profilesToJson/parsePayload): JSON
// { lastChange, profiles: [{ name, mgdl, ic, isf, basal, targetLow,
// targetHigh }] }, each schedule [{ time, timeAsSeconds, value }] in the
// profile's units. AAPS reads a schedule only if every entry starts on the
// hour, and the low and high targets only if they change at the same times.
// There is no DIA: AAPS 4.0 keeps it with the insulin.

import { convert, isMmol, toStoreSchedule } from '../oref/testprofile.js';

export const PROFILE_KEY = 'local_profile_data';

/** The profiles in a `local_profile_data` value: { lastChange, profiles }. Throws if it can't be read. */
export function parseProfileData (value) {
  if (!value) return { lastChange: 0, profiles: [] };
  let doc;
  try {
    doc = JSON.parse(value);
  } catch {
    throw new Error('AAPS\'s profiles could not be read');
  }
  if (!Array.isArray(doc?.profiles)) throw new Error('AAPS\'s profiles could not be read');
  return { lastChange: Number(doc.lastChange) || 0, profiles: doc.profiles };
}

/** Throws unless each entry of the schedule `list` ([[s, v]]) starts on the hour, as AAPS needs. */
function onTheHour (list, what) {
  const off = list.find(([s]) => s % 3600 !== 0);
  if (off) {
    const m = Math.floor(off[0] / 60);
    throw new Error(`AAPS takes schedules by the hour only: the ${what} of AI Test changes at ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
}

/** The value of `list` at `s` seconds from midnight. */
const at = (list, s) => list.reduce((v, [t, x]) => (t <= s ? x : v), list[0][1]);

/** The low and high targets on the same times: AAPS reads them only as pairs. */
function targetPairs (low, high) {
  const times = [...new Set([...low, ...high].map(([s]) => s))].sort((a, b) => a - b);
  return { low: times.map((s) => [s, at(low, s)]), high: times.map((s) => [s, at(high, s)]) };
}

/**
 * The `local_profile_data` value with the profile `to` set to the schedules
 * of `test` (the AI Test profile), in the units of `to` (or of AAPS's other
 * profiles when it adds `to`). Returns { value, lastModified, adds }; the
 * lastModified is newer than the current one, so the master takes it.
 */
export function profileDataWith (current, test, to, now = Date.now()) {
  const { lastChange, profiles } = parseProfileData(current);
  const names = { basal: 'basal', ic: 'carb ratio', isf: 'ISF', targetLow: 'low target', targetHigh: 'high target' };
  for (const [kind, what] of Object.entries(names)) {
    if (!Array.isArray(test[kind]) || !test[kind].length) throw new Error(`AI Test has no ${what}`);
    onTheHour(test[kind], what);
  }
  const existing = profiles.find((p) => p.name === to);
  const mgdl = typeof existing?.mgdl === 'boolean' ? existing.mgdl
    : typeof profiles[0]?.mgdl === 'boolean' ? profiles[0].mgdl
      : !isMmol(test.units);
  const units = mgdl ? 'mg/dl' : 'mmol';
  const glucose = (list) => convert(list, test.units, units);
  const targets = targetPairs(glucose(test.targetLow), glucose(test.targetHigh));
  const entry = {
    name: to,
    mgdl,
    ic: toStoreSchedule(test.ic),
    isf: toStoreSchedule(glucose(test.isf)),
    basal: toStoreSchedule(test.basal),
    targetLow: toStoreSchedule(targets.low),
    targetHigh: toStoreSchedule(targets.high),
  };
  const lastModified = Math.max(now, lastChange + 1);
  const list = existing ? profiles.map((p) => (p.name === to ? entry : p)) : [...profiles, entry];
  return { value: JSON.stringify({ lastChange: lastModified, profiles: list }), lastModified, adds: !existing };
}
