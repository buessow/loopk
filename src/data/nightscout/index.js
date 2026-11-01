// A data source that keeps nothing: it reads a Nightscout server (or another
// loopk) through API v3 with the caller's access token, into an in-memory
// Postgres (postgres/memory.js), and answers with the Postgres source's
// queries over it. Before a read runs, what it needs (NEEDS) is loaded if it
// is not yet: time ranges of a collection, or, for "the latest before",
// profile switches back from a time until the one it looks for. What is
// loaded is refreshed with the server's history of changes at most once a
// minute. The profile store is small and loaded whole. New documents (sport
// mode, a copied profile) are written to the server; loopk's own API takes
// none. loopk's settings are kept on the server too (settings.js); the rest
// of its own state (tokens, people, dashboards) lives in memory only.

import { NightscoutClient } from '../../sync/client.js';
import { prepare } from '../../sync/normalize.js';
import { postgresSource } from '../postgres/index.js';
import { Coverage } from './coverage.js';
import { upstreamSettings } from './settings.js';
export { loopkSettings } from './settings.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Changes on the server are read at most this often.
const REFRESH = MIN;
// Server clocks differ: the first history read starts this long before the source.
const CLOCK_MARGIN = 5 * MIN;
// A range is fetched in pieces this long, so skip stays small; profile
// events alone are few, and fetched in longer pieces.
const PIECE = 2 * DAY;
const EVENTS_PIECE = 90 * DAY;
// How far back a "latest before" looks at most.
const FURTHEST_BACK = 3 * 365 * DAY;
// The collections read by time, and the field their ranges use (as the glucose page does).
const RANGE_FIELD = { entries: 'date', treatments: 'created_at', devicestatus: 'date', heartrate: 'date' };
const LOADED_WHOLE = ['profile'];
// How a server answers for a collection it does not have (Nightscout has no heartrate).
const NO_COLLECTION = /HTTP 404 \(Bad operation or collection\)/;
// Profile switches and AAPS's effective profile switches (uploaded as notes):
// loaded on their own, back from a time, for "the latest before".
const PROFILE_EVENTS = ['Profile Switch', 'Effective Profile Switch', 'Note'];

// What "the latest before" looks for, as SQL over the cache's treatments ($1: the time).
const LATEST = {
  // the last permanent switch, which later temporary ones go back to (treatments.forModel)
  permanentSwitch: `SELECT 1 FROM treatments WHERE event_type = 'Profile Switch' AND coalesce(duration, 0) = 0
    AND date <= $1 AND is_valid IS DISTINCT FROM false LIMIT 1`,
  // the last effective profile switch (treatments.forReplay)
  effectiveSwitch: `SELECT 1 FROM treatments WHERE event_type = 'Note' AND original_profile_name IS NOT NULL
    AND date <= $1 AND is_valid IS DISTINCT FROM false LIMIT 1`,
  // the last switch with its profile (profiles.switchedAt)
  switchWithProfile: `SELECT 1 FROM treatments t JOIN treatment_profiles p ON p.treatment_identifier = t.identifier
    WHERE t.event_type IN ('Profile Switch', 'Effective Profile Switch') AND t.date <= $1 AND t.is_valid IS DISTINCT FROM false LIMIT 1`,
  // any profile switch (the glucose page's search for the one in effect)
  anySwitch: `SELECT 1 FROM treatments WHERE event_type = 'Profile Switch' AND date <= $1 AND is_valid IS DISTINCT FROM false LIMIT 1`,
};

const now = () => Date.now();
const upTo = (t) => t + 1; // a closed range [from, t] as [from, t + 1)
const range = (collection, from, to) => ({ range: collection, from, to });
const latest = (kind, at) => ({ latest: kind, at });

/**
 * What each read of records.js needs: ranges [from, to) of a collection,
 * the latest record of a kind before a time, or the first reading.
 */
const NEEDS = {
  glucose: {
    first: () => [{ first: 'entries' }],
    newest: () => [range('entries', now() - DAY, now() + MIN)],
    upTo: (from, to) => [range('entries', from, upTo(to))],
    between: (from, to) => [range('entries', from, to)],
    latest: (at) => [range('entries', at - DAY, upTo(at))],
    hourly: (from, to) => [range('entries', from, to)],
    allTimes: (from, to) => [range('entries', from, to)],
    forReplay: (from, to) => [range('entries', from, upTo(to))],
  },
  treatments: {
    forModel: (from, to) => [range('treatments', from, to), latest('permanentSwitch', from)],
    forMisses: (from, to) => [range('treatments', from, to)],
    between: (from, to) => [range('treatments', from, to)],
    latestTempBasal: (at) => [range('treatments', at - DAY, upTo(at))],
    latestTempTarget: (at) => [range('treatments', at - DAY, upTo(at))],
    forReplay: (from, to) => [range('treatments', from, upTo(to)), latest('effectiveSwitch', from)],
  },
  loop: {
    runs: (from, to) => [range('devicestatus', from, to)],
    forMisses: (from, to) => [range('devicestatus', from, to)],
    forReplay: (from, to) => [range('devicestatus', from, upTo(to))],
    latest: (at) => [range('devicestatus', at - 6 * HOUR, upTo(at))],
    configuration: (at) => [range('devicestatus', at - DAY, upTo(at))],
    curves: () => [],
    sensitivityRatios: (from, to) => [range('devicestatus', from, to)],
    // Reasons naming a limit are looked for in the last two days only, not
    // the 90 the Postgres source looks at: loading that much is too slow.
    limitReasons: (from, to) => [range('devicestatus', to - 2 * DAY, upTo(to))],
  },
  profiles: {
    switchedAt: (at) => [latest('switchWithProfile', at)],
    storedAt: () => [],
    // The profiles switched to in the last 60 days, not the year the
    // Postgres source looks at: years of switches are tens of megabytes.
    switchedInYear: (at) => [range('profileEvents', at - 60 * DAY, upTo(at))],
    storedLatest: () => [],
  },
  heartrate: {
    between: (from, to) => [range('heartrate', from, to)],
    hourly: (from, to) => [range('heartrate', from, to)],
    latest: (at) => [range('heartrate', at - DAY, upTo(at))],
  },
};

/** Remembers a promise until it fails, so a failed load is tried again. */
const once = (holder, key, make) => {
  holder[key] ||= make().catch((err) => {
    holder[key] = null;
    throw err;
  });
  return holder[key];
};

/** Loads ranges of the server's collections into the cache, and its changes. */
class Loader {
  constructor (client, cache) {
    this.client = client;
    this.cache = cache;
    // profileEvents: the profile switches alone; a range of treatments holds them too
    this.coverage = Object.fromEntries([...Object.keys(RANGE_FIELD), 'profileEvents'].map((c) => [c, new Coverage()]));
    this.queues = new Map(); // collection -> the end of its chain of loads
    this.missing = new Set(); // collections the server does not have
    this.cursor = now() - CLOCK_MARGIN; // history read from here on
    this.refreshed = now();
    this.loads = {};
  }

  /** One load of a collection after another, so they see each other's coverage. */
  queue (collection, fn) {
    const run = (this.queues.get(collection) || Promise.resolve()).then(fn);
    this.queues.set(collection, run.catch(() => {}));
    return run;
  }

  /** Stores Nightscout documents of `collection` as the follower does. */
  async store (collection, docs) {
    const byTarget = new Map();
    for (const doc of docs) {
      const p = prepare(collection, doc);
      if (!p) continue;
      if (!byTarget.has(p.collection)) byTarget.set(p.collection, []);
      byTarget.get(p.collection).push(p.doc);
    }
    for (const [target, list] of byTarget) await this.cache.collection(target).bulkUpsert(list);
  }

  /** The profile store, whole: once, before anything else. */
  start () {
    return once(this.loads, 'start', async () => {
      for (const c of LOADED_WHOLE) await this.store(c, await this.client.search(c));
    });
  }

  /** The first reading, once (reports start there). */
  first () {
    return once(this.loads, 'first', async () => this.store('entries', await this.client.get('/api/v3/entries?type=sgv&sort=date&limit=1')));
  }

  /** Reads what changed on the server since the last time, at most once a REFRESH. */
  async refresh () {
    if (now() - this.refreshed < REFRESH) return;
    this.refreshed = now();
    const from = this.cursor;
    let newest = from;
    for (const c of [...Object.keys(RANGE_FIELD), ...LOADED_WHOLE]) {
      await this.queue(c, async () => {
        for (let cursor = from; ;) {
          const docs = await this.read(c, () => this.client.history(c, cursor));
          if (!docs.length) break;
          await this.store(c, docs);
          const last = Math.max(...docs.map((d) => (typeof d.srvModified === 'number' ? d.srvModified : 0)));
          newest = Math.max(newest, last);
          if (docs.length < this.client.pageSize || last <= cursor) break;
          cursor = last - 1;
        }
      });
    }
    this.cursor = newest;
  }

  /** Fetches [from, to) of `collection` (with `query`), piece by piece. */
  async fetch (collection, from, to, query = {}, piece = PIECE) {
    const field = RANGE_FIELD[collection];
    const value = (t) => (field === 'date' ? t : new Date(t).toISOString());
    for (let p = from; p < to; p += piece) {
      const q = Math.min(to, p + piece);
      await this.store(collection, await this.read(collection, () => this.client.search(collection, { ...query, [`${field}$gte`]: value(p), [`${field}$lt`]: value(q) })));
    }
  }

  /** The documents `get()` reads, none if the server has no such collection. */
  async read (collection, get) {
    if (this.missing.has(collection)) return [];
    try {
      return await get();
    } catch (err) {
      if (!NO_COLLECTION.test(err.message)) throw err;
      this.missing.add(collection);
      return [];
    }
  }

  /** Loads [from, to) of `collection` (or of the profile events) where it is not loaded yet. */
  range (collection, from, to) {
    const queue = collection === 'profileEvents' ? 'treatments' : collection;
    return this.queue(queue, async () => {
      for (const [a, b] of this.coverage[collection].gaps(Math.floor(from), Math.ceil(to))) {
        if (collection === 'profileEvents') {
          // only the profile events, where the treatments are not loaded
          for (const [c, d] of this.coverage.treatments.gaps(a, b)) {
            for (const eventType of PROFILE_EVENTS) await this.fetch('treatments', c, d, { eventType }, EVENTS_PIECE);
          }
        } else {
          await this.fetch(collection, a, b);
          if (collection === 'treatments') this.coverage.profileEvents.add(a, b);
        }
        this.coverage[collection].add(a, b);
      }
    });
  }

  /**
   * Loads profile events back from `at`, a day and then twice as far each
   * time, until the cache holds the `kind` of LATEST. Past the first
   * reading, only the newest profile event of each type before is fetched.
   */
  async latest (kind, at) {
    await this.first();
    const start = await this.cache.glucose.first();
    const found = async () => (await this.cache.pool.query(LATEST[kind], [new Date(at)])).rows.length > 0;
    let edge = at;
    for (let back = DAY; ; back *= 2) {
      edge = at - back;
      await this.range('profileEvents', edge, upTo(at));
      if (await found()) return;
      if (back >= FURTHEST_BACK || start == null || edge <= start) break;
    }
    // the newest before the window searched
    const before = new Date(edge).toISOString();
    await this.queue('treatments', async () => {
      for (const eventType of PROFILE_EVENTS) {
        const params = new URLSearchParams({ eventType, 'created_at$lt': before, sort$desc: 'created_at', limit: '1' });
        await this.store('treatments', await this.client.get(`/api/v3/treatments?${params}`));
      }
    });
  }

  /** Loads what `needs` asks for. */
  async ensure (needs) {
    await this.start();
    await this.refresh();
    await Promise.all(needs.map((n) => (
      n.first ? this.first() : n.latest ? this.latest(n.latest, n.at) : this.range(n.range, n.from, n.to))));
  }

  /** Loads the range a document search filters on (API v3 searches of the glucose page). */
  ensureFilter (collection, filter = []) {
    if (!RANGE_FIELD[collection]) return this.ensure([]);
    const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
    let from = null;
    let to = null;
    let switches = false;
    for (const { field, operator, value } of filter) {
      if (field === 'eventType' && /Profile Switch/.test(String(value))) switches = true;
      // date and created_at are the same time
      if (field !== 'date' && field !== 'created_at') continue;
      const t = ms(value);
      if (!Number.isFinite(t)) continue;
      if (operator === 'gte' || operator === 'gt') from = Math.max(from ?? t, t);
      if (operator === 'lt' || operator === 'lte') to = Math.min(to ?? t, t);
      if (operator === 'eq') [from, to] = [t, t + 1];
    }
    to = to ?? now() + MIN;
    // A search back from a time (sort descending, a limit): the switch in
    // effect then, or the day before it.
    if (from == null && switches) return this.ensure([latest('anySwitch', to)]);
    return this.ensure([range(collection, from ?? to - DAY, upTo(to))]);
  }
}

// The in-memory Postgres of the server; the browser brings its own (public/localworker.js).
const serverPool = async () => (await import('../postgres/memory.js')).memoryPool();

/**
 * The Nightscout source for the server at `url`, read with the access token
 * `token` (none: the page's session, in the browser), over the in-memory
 * Postgres `pool()` makes, with loopk's settings from `settings(client)`
 * (on that server's settings collection; loopkSettings: a loopk server's
 * own). Throws a readable error if the server or the token does not work.
 */
export async function nightscoutSource ({ url, token, fetch, pageSize = 500, pool = serverPool, settings = upstreamSettings }) {
  const client = new NightscoutClient({ url, token, fetch, pageSize });
  await client.check();
  const cache = postgresSource(await pool());
  const loader = new Loader(client, cache);

  const reads = {};
  for (const [group, methods] of Object.entries(NEEDS)) {
    reads[group] = {};
    for (const [name, needs] of Object.entries(methods)) {
      reads[group][name] = async (...args) => {
        await loader.ensure(needs(...args));
        return cache[group][name](...args);
      };
    }
  }

  // Documents: searches load their range first; new documents go to the server.
  const collection = (name) => {
    const store = cache.collection(name);
    const refused = () => { throw new Error(`This server shows the data of ${client.url} and changes it there only`); };
    return {
      table: store.table,
      findMany: async (options) => {
        await loader.ensureFilter(name, options.filter);
        return store.findMany(options);
      },
      findOne: async (identifier, ...rest) => {
        await loader.ensure([]);
        return store.findOne(identifier, ...rest);
      },
      lastModified: () => store.lastModified(),
      /** Writes a new document to the server, then keeps the server's copy. */
      insert: async (doc) => {
        const reply = await client.post(`/api/v3/${name}`, doc);
        const identifier = reply?.identifier ?? doc.identifier;
        await loader.store(name, [await client.get(`/api/v3/${name}/${encodeURIComponent(identifier)}`)]);
        return store.findOne(identifier);
      },
      replace: refused,
      patch: refused,
      bulkUpsert: refused,
      deleteOne: refused,
    };
  };

  return {
    ...cache,
    kind: 'nightscout',
    /** The server whose data this is; loopk's own API accepts no changes. */
    upstream: client.url,
    /** Who the token is on that server and what it may do there: { sub, permissions }. */
    access: { sub: client.access.sub, permissions: client.access.permissionGroups.flat() },
    collection,
    ...reads,
    ...settings(client),
    async storage () {
      return { storage: 'nightscout', url: client.url };
    },
    /** Nothing to check: the schema is made with the cache. */
    async checkSchema () {},
    loader,
  };
}
