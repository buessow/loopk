// The simulator's requests, without HTTP, over a data source: the browser's
// worker answers them (public/localapi.js); the server's routes (routes.js)
// answer the ones that save, and hand the worker loopk's stored settings
// (stored). Bad input throws a SimulationError with its HTTP status.

import { loadHistory } from './inputs.js';
import { simulatePeriod, MAX_PERIOD } from './period.js';
import { SimulationError, loadProfileStore, parseChanges, simulateRun } from './simulate.js';
import { DEFAULTS, loadSettings, saveSettings, validSetting } from './settings.js';
import { TEST_PROFILE, fromStore, loadTestProfile, newestStore } from './testprofile.js';

const HOUR = 3600000;

/** A time in ms or ISO 8601. */
export function parseTime (v, name) {
  const t = typeof v === 'string' && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  if (!Number.isFinite(t)) throw new SimulationError(`${name} must be a time (ms or ISO 8601)`);
  return t;
}

export function simulateApi (data, { follows = () => null } = {}) {
  return {
    /** POST /run { time, changes } */
    run (body = {}) {
      return simulateRun(data, { time: parseTime(body.time, 'time'), changes: parseChanges(body.changes) });
    },

    /** POST /period { from, to, changes, k } */
    period (body = {}) {
      const from = parseTime(body.from, 'from');
      const to = parseTime(body.to, 'to');
      if (!(from < to)) throw new SimulationError('from must be before to');
      if (to - from > MAX_PERIOD) throw new SimulationError(`At most ${MAX_PERIOD / 24 / HOUR} days at once`);
      if (body.k != null && !(typeof body.k === 'number' && body.k > 0 && body.k <= 3)) throw new SimulationError('k must be a number above 0, at most 3');
      return simulatePeriod(data, { from, to: Math.min(to, Date.now()), changes: parseChanges(body.changes), k: body.k ?? undefined });
    },

    /** GET /settings?at= */
    async settings (query = {}) {
      const at = query.at ? parseTime(query.at, 'at') : Date.now();
      const history = await loadHistory(data, { from: at - HOUR, to: at });
      const settings = await loadSettings(data, { to: at, tempTargets: history.tempTargets });
      const profile = history.profiles.at(-1) || null;
      const [stored, test] = await Promise.all([loadProfileStore(data, at), loadTestProfile(data)]);
      const profiles = [...(test ? [TEST_PROFILE] : []), ...stored.map((p) => p.name).filter((n) => n !== TEST_PROFILE)];
      return { at, ...settings, defaults: DEFAULTS, profile: profile && { ...profile, timeZone: undefined }, profiles };
    },

    /** PUT /settings { values, validFrom }, by whom (for admins only). */
    async saveSettings (body = {}, by = null) {
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SimulationError('values must be an object of settings');
      for (const [key, value] of Object.entries(values)) {
        if (!validSetting(key, value)) throw new SimulationError(`Not a loop setting value: ${key} = ${JSON.stringify(value)}`);
      }
      const validFrom = body.validFrom != null ? parseTime(body.validFrom, 'validFrom') : Date.now();
      await saveSettings(data, values, { validFrom, by });
      return loadSettings(data, { to: Math.max(validFrom, Date.now()) });
    },

    /** GET /stored: the loop settings entered and the AI Test profile, as the browser's source reads them (loopkSettings). */
    async stored () {
      const [loopSettings, test] = await Promise.all([data.loopSettings.list(), data.testProfiles.get(TEST_PROFILE)]);
      const testProfiles = test
        ? { [TEST_PROFILE]: { profile: test.profile, basedOn: test.based_on, note: test.note, by: test.updated_by, updatedAt: new Date(test.updated_at).getTime() } }
        : {};
      return { loopSettings, testProfiles };
    },

    // GET /test-profile. stores: every profile to compare with, those of
    // the newest profile store (which a copy can go into) with inStore,
    // then those known only from AAPS's profile switches
    async testProfile () {
      const [test, doc, known] = await Promise.all([loadTestProfile(data), newestStore(data), loadProfileStore(data, Date.now())]);
      const inStore = Object.entries(doc?.store || {}).map(([name, p]) => ({ ...fromStore(name, p), inStore: true }));
      const others = known.filter((p) => !doc?.store?.[p.name]).map((p) => ({ ...p, inStore: false }));
      return { name: TEST_PROFILE, profile: test, stores: [...inStore, ...others], defaultProfile: doc?.defaultProfile ?? null, storeDate: doc?.date ?? null, follows: follows() };
    },
  };
}
