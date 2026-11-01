// loopk's own settings over a Nightscout server: the loop settings and AI
// Test profile entered for the simulator, and sport mode. A source that
// keeps nothing keeps them on that server, as one document each in its
// settings collection, so every caller and every restart sees them.
// Tokens that may not read settings there see none; saving needs one that
// may change them (an admin token on Nightscout). The rows come back as the
// Postgres stores return them (postgres/state.js).
//
// loopkSettings: the same stores read from a loopk server's own (GET
// /api/simulate/stored), for the browser's worker on that server, which
// leaves saving to the server's routes.

const IDS = { loopSettings: 'loopk-loop-settings', testProfiles: 'loopk-test-profiles', sport: 'loopk-sport' };
// Read again after this long, for changes another caller made.
const FRESH = 60000;
const NONE = /HTTP (401|403|404|410)\b/;

export function upstreamSettings (client) {
  const read = new Map();
  // A document's date, which Nightscout does not let a change alter.
  const dates = new Map();

  async function get (kind) {
    const hit = read.get(kind);
    if (hit && Date.now() - hit.at < FRESH) return hit.value;
    let value = null;
    try {
      const doc = await client.get(`/api/v3/settings/${IDS[kind]}`);
      value = doc?.loopk ?? null;
      if (doc?.date) dates.set(kind, doc.date);
    } catch (err) {
      if (!NONE.test(err.message)) throw err;
    }
    read.set(kind, { at: Date.now(), value });
    return value;
  }

  async function put (kind, value) {
    if (!dates.has(kind)) await get(kind);
    const date = dates.get(kind) ?? Date.now();
    try {
      await client.put(`/api/v3/settings/${IDS[kind]}`, { identifier: IDS[kind], app: 'loopk', date, utcOffset: 0, loopk: value });
      dates.set(kind, date);
    } catch (err) {
      if (/HTTP (401|403)\b/.test(err.message)) throw new Error(`Saving needs a token that may change settings on ${client.url}, which keeps loopk's`);
      throw err;
    }
    read.set(kind, { at: Date.now(), value });
  }

  return settingStores(get, put);
}

/** The stores of a loopk server's settings, read only (saving is the server's). */
export function loopkSettings (client) {
  let read = null;
  const get = async (kind) => {
    if (!read || Date.now() - read.at >= FRESH) read = { at: Date.now(), value: client.get('/api/simulate/stored') };
    try {
      return (await read.value)[kind] ?? null;
    } catch (err) {
      read = null;
      throw err;
    }
  };
  const put = () => { throw new Error(`loopk's settings are saved on ${client.url}`); };
  return {
    ...settingStores(get, put),
    /** The server saved settings: read them again. */
    settingsChanged: () => { read = null; },
  };
}

/** The stores over get(kind) and put(kind, value) of whole values. */
function settingStores (get, put) {
  return {
    loopSettings: {
      /** Every row: [{ setting, value, validFrom, by, updatedAt }]. */
      list: async () => await get('loopSettings') ?? [],
      async at (at) {
        const holding = new Map();
        for (const r of await get('loopSettings') ?? []) {
          if (r.validFrom <= at && !(holding.get(r.setting)?.validFrom > r.validFrom)) holding.set(r.setting, r);
        }
        return [...holding.values()].sort((a, b) => a.setting.localeCompare(b.setting)).map((r) => ({ setting: r.setting, value: r.value }));
      },
      async save (setting, value, validFrom, by) {
        const rows = (await get('loopSettings') ?? []).filter((r) => r.setting !== setting || r.validFrom !== validFrom);
        rows.push({ setting, value, validFrom, by: by ?? null, updatedAt: Date.now() });
        await put('loopSettings', rows);
      },
      async changes (from, to) {
        const times = (await get('loopSettings') ?? []).map((r) => r.validFrom).filter((t) => t > from && t <= to);
        return [...new Set(times)].sort((a, b) => a - b);
      },
    },

    testProfiles: {
      async get (name) {
        const r = (await get('testProfiles'))?.[name];
        return r ? { name, profile: r.profile, based_on: r.basedOn, note: r.note, updated_at: new Date(r.updatedAt), updated_by: r.by } : null;
      },
      async save (name, { profile, basedOn, note, by }) {
        await put('testProfiles', { ...await get('testProfiles'), [name]: { profile, basedOn, note, by, updatedAt: Date.now() } });
      },
      async remove (name) {
        const { [name]: _, ...rest } = await get('testProfiles') ?? {};
        await put('testProfiles', rest);
      },
    },

    sport: {
      async get () {
        const r = await get('sport');
        return r ? { ...r.config, updated_at: new Date(r.updatedAt), updated_by: r.by } : null;
      },
      async save ({ percentage, duration, target, profile, by }) {
        await put('sport', { config: { percentage, duration, target, profile }, by: by ?? null, updatedAt: Date.now() });
      },
      async remove () {
        await put('sport', null);
      },
    },
  };
}
