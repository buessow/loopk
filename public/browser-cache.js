// A small persistent cache for the dashboard's time series. It deliberately
// stores Nightscout documents as received; the API history cursor supplies
// only records created, changed, or soft-deleted since the last visit.

const DB_NAME = 'loopk-dashboard';
// 3: entries carry their device, to leave out simulated readings.
const DB_VERSION = 3;
const META = 'meta';
// How long the page waits for the cache to open before going on without it.
const OPEN_TIMEOUT = 3000;
const COLLECTIONS = ['entries', 'treatments', 'devicestatus', 'heartrate'];

let opening;
let unavailable = false;

function request (r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function db () {
  if (unavailable || !globalThis.indexedDB) return null;
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = (e) => {
        const database = open.result;
        // Documents cached before version 3 lack fields the page needs now: start over.
        if (e.oldVersion < 3) for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name);
        for (const collection of COLLECTIONS) {
          if (!database.objectStoreNames.contains(collection)) database.createObjectStore(collection, { keyPath: 'identifier' });
        }
        if (!database.objectStoreNames.contains(META)) database.createObjectStore(META, { keyPath: 'key' });
      };
      open.onsuccess = () => {
        const database = open.result;
        // A newer page (another tab) upgrading the cache: let it, and open
        // the new version on next use.
        database.onversionchange = () => {
          database.close();
          opening = null;
        };
        resolve(database);
      };
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Browser cache is blocked'));
      // Tabs of older pages that hold the cache open can stall an upgrade
      // without a "blocked" event: the page works without the cache meanwhile.
      setTimeout(() => reject(new Error('Browser cache did not open')), OPEN_TIMEOUT);
    }).catch(() => {
      unavailable = true;
      return null;
    });
  }
  return opening;
}

async function meta (key) {
  const database = await db();
  if (!database) return null;
  const tx = database.transaction(META, 'readonly');
  return (await request(tx.objectStore(META).get(key)))?.value ?? null;
}

async function setMeta (key, value) {
  const database = await db();
  if (!database) return;
  const tx = database.transaction(META, 'readwrite');
  tx.objectStore(META).put({ key, value });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function mergeRanges (ranges, next) {
  const all = [...(ranges || []), next].sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of all) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

const timeAt = (doc, field) => field === 'date' ? doc.date : Date.parse(doc[field] || '');

/** Cached documents for a completely fetched interval, or null when it must be requested. */
export async function cachedRange (collection, field, from, to) {
  const end = to ?? Date.now();
  const ranges = await meta(`ranges:${collection}`);
  // A present-to-now range is refreshed by API history immediately after it
  // paints, so an earlier cached end is sufficient for that initial render.
  if (!ranges?.some((range) => range.from <= from && (to == null || range.to >= end))) return null;
  const database = await db();
  if (!database) return null;
  const tx = database.transaction(collection, 'readonly');
  const docs = await request(tx.objectStore(collection).getAll());
  return docs.filter((doc) => {
    const time = timeAt(doc, field);
    return doc.isValid !== false && Number.isFinite(time) && time >= from && time < end;
  });
}

/** Adds normal search results and records that their time interval is complete. */
export async function cacheRange (collection, docs, from, to) {
  await applyChanges(collection, docs);
  const end = to ?? Date.now();
  const ranges = await meta(`ranges:${collection}`);
  await setMeta(`ranges:${collection}`, mergeRanges(ranges, { from, to: end }));
}

/** Applies API history changes; an invalid document removes its cached predecessor. */
export async function applyChanges (collection, docs) {
  const database = await db();
  if (!database) return;
  const tx = database.transaction(collection, 'readwrite');
  const store = tx.objectStore(collection);
  for (const doc of docs) {
    if (!doc?.identifier) continue;
    if (doc.isValid === false) store.delete(doc.identifier);
    else store.put(doc);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

export const cursorFor = (collection) => meta(`cursor:${collection}`);
export const saveCursor = (collection, cursor) => setMeta(`cursor:${collection}`, cursor);
export const cachedValue = (key) => meta(`value:${key}`);
export const saveValue = (key, value) => setMeta(`value:${key}`, value);
export const cacheAvailable = async () => !!(await db());

/** Clears a prior user's data before this signed-in user can read from cache. */
export async function useCacheFor (owner) {
  const database = await db();
  if (!database) return false;
  const previous = await meta('owner');
  if (previous && previous !== owner) await clearCache();
  await setMeta('owner', owner);
  return true;
}

/** Removes sensitive cached values, used when the browser signs out. */
export async function clearCache () {
  const database = await db();
  if (!database) return;
  const tx = database.transaction([...COLLECTIONS, META], 'readwrite');
  for (const collection of COLLECTIONS) tx.objectStore(collection).clear();
  tx.objectStore(META).clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
