// The "AI Test" profile: a profile an agent edits through the MCP tools
// (set_test_profile) to simulate with (profile.name "AI Test"). It is kept in
// its own table, not in the profile collection, so AAPS never receives it.
// An admin can copy it into a profile of the profile store on the Profiles
// page; that writes a new profile document, as Nightscout's profile editor
// does, which AAPS takes with "Receive profile store" on.
//
// A profile here has the shape of loadProfileStore (simulate.js): { dia,
// units, timezone, basal, ic, isf, targetLow, targetHigh }, schedules as
// [[seconds from midnight, value]] in the profile's units, at 100%.

import { resolveIdentifier } from '../api3/tools.js';
import { MMOLL_TO_MGDL } from './format.js';
import { SimulationError, loadProfileStore } from './simulate.js';

export const TEST_PROFILE = 'AI Test';
const DAY_SECONDS = 86400;
const MAX_ENTRIES = 48;
// The schedules of a profile, by the name a store uses for each.
export const KINDS = { basal: 'basal', ic: 'carbratio', isf: 'sens', targetLow: 'target_low', targetHigh: 'target_high' };
const LIMITS = {
  basal: [0, 10, 'U/h'],
  ic: [1, 200, 'g per U'],
  isf: [0.5, 1000, 'glucose per U'],
  targetLow: [2, 400, 'glucose'],
  targetHigh: [2, 400, 'glucose'],
};

export const isMmol = (units) => /^mmol/i.test(units || '');
const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;

/** A schedule of a profile store ([{ time, timeAsSeconds, value }]) as [[seconds, value]]. */
export function fromStoreSchedule (list) {
  return (list || []).map((e) => [Number(e.timeAsSeconds ?? (Number(String(e.time).slice(0, 2)) * 3600 + Number(String(e.time).slice(3, 5)) * 60)), Number(e.value)])
    .sort((a, b) => a[0] - b[0]);
}

/** [[seconds, value]] as a profile store's schedule. */
export const toStoreSchedule = (list) => list.map(([s, value]) => ({ time: hm(s), timeAsSeconds: s, value }));

/** A profile of a profile store document as a test profile's shape. */
export function fromStore (name, p) {
  const out = { name, dia: Number(p.dia), units: p.units, timezone: p.timezone ?? null };
  for (const [kind, key] of Object.entries(KINDS)) out[kind] = fromStoreSchedule(p[key]);
  return out;
}

/** Checks a test profile; returns it in a canonical shape or throws a SimulationError. */
export function validProfile (p) {
  if (!p || typeof p !== 'object') throw new SimulationError('A profile must be an object');
  if (!Number.isFinite(p.dia) || p.dia < 2 || p.dia > 10) throw new SimulationError('DIA must be 2 to 10 hours');
  const mmol = isMmol(p.units);
  const out = { dia: p.dia, units: mmol ? 'mmol' : 'mg/dl', timezone: p.timezone ?? null };
  for (const kind of Object.keys(KINDS)) {
    const list = p[kind];
    if (!Array.isArray(list) || !list.length || list.length > MAX_ENTRIES) throw new SimulationError(`${kind} must list 1 to ${MAX_ENTRIES} [time, value] entries`);
    let [lo, hi, unit] = LIMITS[kind];
    // glucose limits are in mg/dL; mmol/L profiles get them / 18
    if (mmol && unit.startsWith('glucose') && kind !== 'isf') [lo, hi] = [lo / MMOLL_TO_MGDL, hi / MMOLL_TO_MGDL];
    if (mmol && kind === 'isf') [lo, hi] = [0.05, 1000 / MMOLL_TO_MGDL];
    if (mmol && kind.startsWith('target')) lo = Math.max(lo, 2);
    let last = -1;
    for (const e of list) {
      const [s, v] = Array.isArray(e) ? e : [];
      if (!Number.isInteger(s) || s < 0 || s >= DAY_SECONDS || s % 60) throw new SimulationError(`${kind}: times must be whole minutes of the day`);
      if (s <= last) throw new SimulationError(`${kind}: times must go up`);
      if (last < 0 && s !== 0) throw new SimulationError(`${kind}: the first entry must start at 00:00`);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new SimulationError(`${kind}: values must be ${round(lo)} to ${round(hi)} ${unit}${unit.startsWith('glucose') ? ` (${mmol ? 'mmol/L' : 'mg/dL'})` : ''}`);
      last = s;
    }
    out[kind] = list.map(([s, v]) => [s, v]);
  }
  for (const [i, [s, low]] of out.targetLow.entries()) {
    const high = valueAt(out.targetHigh, s);
    if (high < low) throw new SimulationError(`The high target at ${hm(out.targetLow[i][0])} is below the low target`);
  }
  return out;
}

const round = (v) => Math.round(v * 100) / 100;
const valueAt = (list, s) => [...list].reverse().find(([t]) => t <= s)?.[1];

/** The test profile: { name, ...profile, basedOn, note, updatedAt, updatedBy }, or null. */
export async function loadTestProfile (data) {
  const r = await data.testProfiles.get(TEST_PROFILE);
  return r ? { name: r.name, ...r.profile, basedOn: r.based_on, note: r.note, updatedAt: r.updated_at.getTime(), updatedBy: r.updated_by } : null;
}

/** Saves the test profile (checked by validProfile) and returns it as loadTestProfile does. */
export async function saveTestProfile (data, { profile, basedOn = null, note = null }, by = null) {
  const p = validProfile(profile);
  if (note != null && (typeof note !== 'string' || note.length > 2000)) throw new SimulationError('note must be text of at most 2000 characters');
  await data.testProfiles.save(TEST_PROFILE, { profile: p, basedOn, note, by });
  return loadTestProfile(data);
}

export async function deleteTestProfile (data) {
  await data.testProfiles.remove(TEST_PROFILE);
}

/** The newest profile store document, or null. */
export async function newestStore (data) {
  const [doc] = await data.collection('profile').findMany({ sort: { date: -1 }, limit: 1, onlyValid: true });
  return doc || null;
}

/** A schedule's glucose values from units `from` to units `to`, rounded as profiles are. */
function convert (list, from, to) {
  if (isMmol(from) === isMmol(to)) return list;
  return isMmol(to)
    ? list.map(([s, v]) => [s, Math.round(v / MMOLL_TO_MGDL * 10) / 10])
    : list.map(([s, v]) => [s, Math.round(v * MMOLL_TO_MGDL)]);
}

/**
 * Copies the test profile into the profile `to` of the newest profile store
 * document: a new document with that profile's schedules and DIA replaced,
 * in its units, the other profiles kept. A profile known only from AAPS's
 * profile switches (such as one made on the phone) is added to the store,
 * with the other settings of the store's default profile. Returns the new
 * document.
 */
export async function copyTestProfile (ctx, { to, by, now = Date.now(), utcOffset = 0 }) {
  if (ctx.follower) throw new SimulationError(`This server follows ${ctx.follower.url} and accepts no changes`, 409);
  const test = await loadTestProfile(ctx.data);
  if (!test) throw new SimulationError(`There is no ${TEST_PROFILE} profile to copy`, 404);
  const doc = await newestStore(ctx.data) || { store: {} };
  let target = doc.store?.[to];
  if (!target) {
    const known = await loadProfileStore(ctx.data, now);
    if (!known.some((p) => p.name === to)) throw new SimulationError(`There is no profile ${to}`, 404);
    const { units, timezone, carbs_hr: carbsHr, delay } = doc.store?.[doc.defaultProfile] || Object.values(doc.store || {})[0] || {};
    target = { units: units || test.units, timezone: timezone || test.timezone || 'UTC', ...(carbsHr != null ? { carbs_hr: carbsHr } : {}), ...(delay != null ? { delay } : {}) };
  }
  const units = target.units || doc.units || test.units;
  const entry = { ...target, dia: test.dia };
  for (const [kind, key] of Object.entries(KINDS)) {
    entry[key] = toStoreSchedule(kind === 'isf' || kind.startsWith('target') ? convert(test[kind], test.units, units) : test[kind]);
  }
  const { identifier, _id, srvCreated, srvModified, ...rest } = doc;
  const copy = {
    defaultProfile: to,
    ...rest,
    date: now,
    created_at: new Date(now).toISOString(),
    startDate: new Date(now).toISOString(),
    utcOffset,
    app: 'loopk',
    enteredBy: by,
    store: { ...doc.store, [to]: entry },
    srvCreated: now,
    srvModified: now,
  };
  resolveIdentifier(copy);
  const stored = await ctx.data.collection('profile').insert(copy);
  ctx.bus?.emit('storage-socket-create', { colName: 'profile', doc: stored });
  ctx.bus?.emit('data-received', { colName: 'profile' });
  return stored;
}
