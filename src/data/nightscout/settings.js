// loopk's own settings where no loopk server keeps them: the loop settings
// and AI Test profile entered for the simulator, and sport mode. They are one
// document, { version, loopSettings, testProfiles, sport }, read and written
// whole (documentSettings): in the browser it is kept in localStorage
// (public/localworker.js, through the page), for an agent's own MCP in a file
// (src/mcp/settingsfile.js), otherwise in memory. "Export settings" writes
// the same document and "Import settings" reads it, so a file moves the
// settings between a browser and an agent. Nothing goes to Nightscout's
// settings collection, which only admin tokens may read. The rows come back
// as the Postgres stores return them (postgres/state.js).
//
// loopkSettings: the same stores read from a loopk server's own (GET
// /api/simulate/stored), for the browser's worker on that server, which
// leaves saving to the server's routes, and for an agent's own MCP
// (src/mcp/local.js), which saves the AI Test profile through them.

// The settings document's format; a newer one is refused, not misread.
export const SETTINGS_VERSION = 1;
// Read again after this long, for changes another caller made.
const FRESH = 60000;

const notSettings = (why) => Object.assign(new Error(`These are not loopk settings: ${why}`), { status: 400, expose: true });
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** The settings document `value` checked for its shape: { version, loopSettings, testProfiles, sport }. */
export function settingsDocument (value) {
  if (!isObject(value)) throw notSettings('not a JSON object');
  const version = value.version ?? SETTINGS_VERSION;
  if (!Number.isInteger(version) || version < 1) throw notSettings('version must be a whole number');
  if (version > SETTINGS_VERSION) throw notSettings(`version ${version} is newer than this loopk reads (${SETTINGS_VERSION})`);
  const { loopSettings = [], testProfiles = {}, sport = null } = value;
  if (!Array.isArray(loopSettings) || !loopSettings.every((r) => isObject(r) && typeof r.setting === 'string' && Number.isFinite(r.validFrom))) {
    throw notSettings('loopSettings must be a list of { setting, value, validFrom }');
  }
  if (!isObject(testProfiles) || !Object.values(testProfiles).every((t) => isObject(t) && isObject(t.profile))) {
    throw notSettings('testProfiles must name objects with a profile');
  }
  if (sport != null && !(isObject(sport) && isObject(sport.config))) throw notSettings('sport must be null or { config }');
  return { version: SETTINGS_VERSION, loopSettings, testProfiles, sport };
}

/**
 * The stores over one settings document, which `load()` reads (null: none
 * yet) and `save(doc)` replaces. Also `settingsDocument.get()` and `.put(doc)`
 * of the whole, for export and import. A data source's `settings` option.
 */
export function documentSettings ({ load, save }) {
  let tail = Promise.resolve();
  // One change after another, each over the document as the one before left it.
  const change = (fn) => {
    const run = tail.then(async () => {
      const doc = settingsDocument(await load() ?? {});
      await save(settingsDocument(fn(doc)));
    });
    tail = run.catch(() => {});
    return run;
  };
  const get = async (kind) => (await load())?.[kind] ?? null;
  const put = (kind, value) => change((doc) => ({ ...doc, [kind]: value }));
  return () => ({
    ...settingStores(get, put),
    settingsDocument: {
      get: async () => settingsDocument(await load() ?? {}),
      put: (doc) => change(() => settingsDocument(doc)),
    },
  });
}

/** Settings kept in memory only, starting from the document `initial`. */
export function memorySettings (initial = null) {
  let doc = initial;
  return documentSettings({ load: async () => doc, save: async (value) => { doc = value; } });
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
  const stores = settingStores(get, put);
  return {
    ...stores,
    testProfiles: {
      ...stores.testProfiles,
      // The server checks it and keeps who saved it.
      async save (name, { profile, basedOn, note }) {
        try {
          await client.put('/api/simulate/test-profile', { profile, basedOn, note });
        } catch (err) {
          // What the server refused, for the caller, with its status.
          const [, status, reason] = /HTTP (4\d\d)(?: \((.*)\))?$/.exec(err.message) ?? [];
          if (status) throw Object.assign(new Error(reason || err.message), { status: Number(status), expose: true });
          throw err;
        }
        read = null;
      },
    },
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
