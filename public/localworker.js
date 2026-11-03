// The worker that is loopk in this browser (local.js starts it): a Postgres
// (PGlite) with loopk's schema, the server's Nightscout data source over it,
// and loopk's API answered over that source (localapi.js). With a token it
// reads that Nightscout server directly, and nothing it reads goes to
// loopk's server, which only sends the code; without one it reads loopk's
// own API v3 as the page is signed in, with loopk's stored settings
// (loopkSettings).
//
// With a token, the database is kept in IndexedDB with what it has loaded
// (CACHE), so a later visit reads only what changed since; one tab at a time
// keeps it (a lock), others work in memory. loopk's settings are then the
// page's (localStorage): they arrive with 'open' and 'settings', and each
// change goes back to the page as { type: 'settings', value }.
//
// Messages: { id, type: 'open', url, token?, settings? }, then
// { id, method, path, body }, { id, type: 'changed' } when the server saved
// loopk's settings, and { type: 'settings', value } when another tab changed
// them; each with an id is answered with { id, status, body }.

import { PGlite } from './vendor/pglite/index.js';
import { migrate, pglitePool } from '../src/data/postgres/pglite.js';
import { documentSettings, loopkSettings, nightscoutSource } from '../src/data/nightscout/index.js';
import { localApi } from './localapi.js';

// What the kept database holds besides the data: what was loaded, and the
// cache's format. A new format starts the cache again.
const CACHE = 'loopk_browser_cache';
const CACHE_FORMAT = 1;
// A cache not caught up for this long starts again: reading every change since would take longer.
const CACHE_STALE = 7 * 24 * 3600000;

let opening = null;
let source = null;
let settings = null;

/** The IndexedDB name of the kept database for the server at `url`. */
function cacheName (url) {
  let h = 0x811c9dc5;
  for (const c of url) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `loopk-${h.toString(16).padStart(8, '0')}`;
}

/** Whether this worker may keep the database `name`: true while it holds the lock. */
function keep (name) {
  if (!self.navigator?.locks || !self.indexedDB) return Promise.resolve(false);
  return new Promise((resolve) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      // held as long as the worker runs
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(false));
  });
}

/** The database and what it holds: { db, kept (null: start loading), save(state) (none: not kept) }. */
async function database (url, migrations) {
  const name = cacheName(new URL(url).origin + new URL(url).pathname.replace(/\/$/, ''));
  const kept = await keep(name);
  // Each query waits for its write to IndexedDB, so what was loaded is kept
  // when the page changes (relaxedDurability loses the last writes then).
  const db = await PGlite.create(kept ? `idb://${name}` : undefined);
  if (!kept) {
    await migrate(db, migrations);
    return { db, kept: null };
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS ${CACHE} (key text PRIMARY KEY, value jsonb NOT NULL)`);
  const row = (await db.query(`SELECT value FROM ${CACHE} WHERE key = 'loader'`)).rows[0]?.value;
  const fresh = row?.format === CACHE_FORMAT && Date.now() - row.state.cursor < CACHE_STALE;
  if (!fresh) {
    // nothing of an older format or too old is kept: the schema too is made again
    await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE ${CACHE} (key text PRIMARY KEY, value jsonb NOT NULL)`);
  }
  await migrate(db, migrations);
  return { db, kept: fresh ? row.state : null, save: (state) => db.query(`INSERT INTO ${CACHE} (key, value) VALUES ('loader', $1)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [{ format: CACHE_FORMAT, state }]) };
}

async function open ({ url, token, settings: initial }) {
  const t0 = performance.now();
  const migrations = await (await fetch('/migrations.json')).json();
  if (!token) {
    const pool = async () => {
      const db = await PGlite.create();
      await migrate(db, migrations);
      return pglitePool(db);
    };
    source = await nightscoutSource({ url, pool, settings: loopkSettings });
  } else {
    settings = initial ?? null;
    const { db, kept, save } = await database(url, migrations);
    // Each change written after the one before, the newest last.
    let saving = Promise.resolve();
    const onChange = save && ((state) => { saving = saving.then(() => save(state)).catch((err) => console.warn('loopk in this browser: the cache was not kept', err)); });
    source = await nightscoutSource({
      url,
      token,
      pool: async () => pglitePool(db),
      kept,
      onChange,
      settings: documentSettings({
        load: async () => settings,
        save: async (value) => {
          settings = value;
          self.postMessage({ type: 'settings', value });
        },
      }),
    });
    // A new cache is kept from the start, though nothing is loaded yet: the
    // sign-in page moves on as soon as this is answered.
    if (save && !kept) await save(source.loader.state());
    console.info(`loopk in this browser: ${kept ? 'the cache kept from before' : save ? 'a new cache, kept' : 'a cache in memory (another tab keeps it)'}`);
  }
  const client = source.loader.client;
  console.info(`loopk in this browser: ${client.url} opened in ${Math.round(performance.now() - t0)} ms`);
  return localApi(source, { url: client.url, upstream: (path) => client.get(path) });
}

self.onmessage = async ({ data: message }) => {
  const { id, type, ...request } = message;
  if (type === 'settings') {
    settings = request.value ?? null;
    return;
  }
  const reply = (answer) => self.postMessage({ id, ...answer });
  try {
    if (type === 'open') {
      opening = open(request);
      await opening;
      return reply({ status: 200, body: {} });
    }
    const handle = await opening;
    if (type === 'changed') {
      source.settingsChanged?.();
      return reply({ status: 200, body: {} });
    }
    const t0 = performance.now();
    const answer = await handle(request);
    console.info(`loopk in this browser: ${request.method} ${request.path.split('?')[0]} ${answer.status} in ${Math.round(performance.now() - t0)} ms`);
    reply(answer);
  } catch (err) {
    const status = /did not accept the access token|HTTP 401/.test(err.message) ? 401 : 500;
    reply({ status, body: { status, message: err.message } });
  }
};
