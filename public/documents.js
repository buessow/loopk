// Documents of the Nightscout API (APIv3) for the glucose chart, through
// the browser cache (browser-cache.js) where it has them.

import { cacheRange, cachedRange } from './browser-cache.js';

export const PAGE = 1000;
// What the chart needs of a treatment; profile switches add their profile.
export const TREATMENT_FIELDS = 'identifier,date,created_at,srvModified,eventType,type,isSMB,insulin,carbs,glucose,units,'
  + 'duration,durationInMilliseconds,absolute,rate,percent,profile,profileJson,percentage,timeshift';
export const DEVICESTATUS_FIELDS = 'identifier,date,srvModified,openaps,loop';

export async function api (path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const body = await res.json();
  return body.result ?? body;
}

/**
 * All documents of a collection with `field` in [from, to), fetched in pages
 * of PAGE sorted by that field. `field` is `date` (epoch ms) or `created_at` (ISO).
 */
export async function fetchRange (col, field, from, to, query = '') {
  const cached = await cachedRange(col, field, from, to).catch(() => null);
  if (cached) return cached;

  const value = (t) => (field === 'date' ? t : new Date(t).toISOString());
  const docs = new Map();
  let cursor = value(from);
  for (;;) {
    const upper = to != null ? `&${field}$lt=${encodeURIComponent(value(to))}` : '';
    const page = await api(`/api/v3/${col}?${field}$gte=${encodeURIComponent(cursor)}${upper}&sort=${field}&limit=${PAGE}${query}`);
    const before = docs.size;
    for (const d of page) docs.set(d.identifier, d);
    if (page.length < PAGE || docs.size === before) break;
    // Continue from the last value; documents sharing it are deduplicated.
    cursor = page[page.length - 1][field];
  }
  const result = [...docs.values()];
  // IndexedDB is an optional progressive enhancement: a full/quota-restricted
  // cache must never prevent the dashboard from loading from the API.
  await cacheRange(col, result, from, to).catch(() => {});
  return result;
}

/** The latest profile switch before `t`: the profile in effect at the start of loaded data. */
export function fetchSwitchBefore (t) {
  return api(`/api/v3/treatments?eventType$re=Profile%20Switch$&created_at$lt=${new Date(t).toISOString()}&sort$desc=created_at&limit=1`);
}
