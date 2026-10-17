// Cleans up Nightscout documents (as API v3 serves them: plain JSON, with an
// identifier) before they are stored: imported from Nightscout's MongoDB or
// copied while following a Nightscout server. Years of AAPS and Nightscout
// versions left differently shaped documents; see mongo-analysis/report.md.

const DAY = 24 * 3600 * 1000;
const EARLIEST = Date.UTC(2015, 0, 1);
// Leftovers of the API v1 era: NSClient's own sync id and a copy of the date.
const OBSOLETE = ['NSCLIENT_ID', 'sysTime'];
const SCHEDULE_KINDS = ['basal', 'carbratio', 'sens', 'target_low', 'target_high'];
const PROFILE_NUMBERS = ['dia', 'carbs_hr', 'delay'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sane (t) {
  return Number.isFinite(t) && t >= EARLIEST && t <= Date.now() + DAY ? t : null;
}

/** Epoch milliseconds from a number in s, ms or µs, or from a date string; null if implausible. */
export function toMillis (v) {
  if (typeof v === 'number') {
    if (v > 1e14) return sane(Math.round(v / 1000)); // microseconds
    if (v < 1e11) return sane(v * 1000); // seconds
    return sane(v);
  }
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return toMillis(Number(v));
    return sane(Date.parse(v));
  }
  return null;
}

const numeric = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

/** Drops empty objects (e.g. `configuration: {}` in statuses without loop data). */
function dropEmptyObjects (obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!isPlainObject(v)) continue;
    dropEmptyObjects(v);
    if (!Object.keys(v).length) delete obj[k];
  }
  return obj;
}

/** Numbers stored as strings in old profiles ("value": "0.8", "timeAsSeconds": "3600"). */
export function normalizeProfile (body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  for (const k of PROFILE_NUMBERS) if (k in out) out[k] = numeric(out[k]);
  for (const kind of SCHEDULE_KINDS) {
    if (!Array.isArray(out[kind])) continue;
    out[kind] = out[kind].map((e) => (isPlainObject(e)
      ? { ...e, ...('value' in e && { value: numeric(e.value) }), ...('timeAsSeconds' in e && { timeAsSeconds: numeric(e.timeAsSeconds) }) }
      : e));
  }
  return out;
}

/** "+3" / "-2", as AAPS writes a status's tick; older versions sent numbers. */
const tickString = (v) => (typeof v === 'number' ? (v >= 0 ? `+${v}` : String(v)) : v);

/**
 * The cleaned document, or null if it cannot be stored (no plausible time).
 * Does not change `doc`.
 */
export function normalize (collection, doc) {
  const d = structuredClone(doc);
  for (const k of OBSOLETE) delete d[k];

  // One time for date and created_at: date wins, as in Nightscout's API v3.
  const fromDate = toMillis(d.date);
  const t = fromDate ?? toMillis(d.created_at) ?? toMillis(d.dateString);
  if (t == null) return null;
  // A heart rate stored in microseconds has its duration in microseconds too.
  if (collection === 'heartrate' && typeof d.date === 'number' && d.date > 1e14 && typeof d.duration === 'number') {
    d.duration = Math.round(d.duration / 1000);
  }
  d.date = t;
  d.created_at = new Date(t).toISOString();

  // Documents written through API v1 have no server timestamps.
  if (typeof d.srvModified !== 'number') d.srvModified = typeof d.srvCreated === 'number' ? d.srvCreated : t;
  if (typeof d.srvCreated !== 'number') d.srvCreated = Math.min(d.srvModified, t);

  if (collection === 'devicestatus' && isPlainObject(d.openaps)) {
    for (const source of ['suggested', 'enacted']) {
      const x = d.openaps[source];
      if (!isPlainObject(x)) continue;
      if ('tick' in x) x.tick = tickString(x.tick);
    }
    const enacted = d.openaps.enacted;
    if (isPlainObject(enacted) && 'recieved' in enacted) {
      if (!('received' in enacted)) enacted.received = enacted.recieved;
      delete enacted.recieved;
    }
  }

  if (collection === 'profile') {
    d.mills = numeric(d.mills);
    if (isPlainObject(d.store)) {
      d.store = Object.fromEntries(Object.entries(d.store).map(([name, body]) => [name, normalizeProfile(body)]));
    }
  }

  if (collection === 'treatments' && typeof d.profileJson === 'string') {
    try {
      const body = JSON.parse(d.profileJson);
      if (isPlainObject(body)) d.profileJson = JSON.stringify(normalizeProfile(body));
    } catch { /* not JSON: kept as it is */ }
  }

  return dropEmptyObjects(d);
}

/**
 * Where a document from Nightscout's `collection` belongs and how it is
 * stored: { collection, doc }, or null to skip it. Heart rates filed as
 * treatments, in `activity` or (by an AAPS bug, March 2025) in `food` go to
 * `heartrate`.
 */
export function prepare (collection, doc) {
  if (collection === 'activity' || (collection === 'treatments' && doc.eventType === 'HeartRate')) {
    const hr = legacyHeartRate(doc);
    return hr && { collection: 'heartrate', doc: normalize('heartrate', hr) };
  }
  if (collection === 'food' && 'beatsPerMinute' in doc) collection = 'heartrate';
  const d = normalize(collection, doc);
  return d && { collection, doc: d };
}

/**
 * Heart rate recorded before AAPS had a heart rate collection (2020-2023): as
 * `HeartRate` treatments and in an `activity` collection, with
 * { heartRate, samplingStart, samplingEnd, deviceId }. Returns a heart rate
 * document, or null for test data and readings without a plausible time.
 */
export function legacyHeartRate (doc) {
  if (doc.test === true || /Sim/.test(doc.deviceId || '')) return null;
  if (typeof doc.heartRate !== 'number' || doc.heartRate <= 0) return null;
  let end = toMillis(doc.samplingEnd) ?? toMillis(doc.created_at);
  let start = toMillis(doc.samplingStart) ?? toMillis(doc.date);
  if (end == null && start == null) return null;
  if (end == null) end = start + 5 * 60000;
  if (start == null || start > end || end - start > 3600000) start = end - 5 * 60000;
  return {
    identifier: doc.identifier,
    date: start,
    created_at: new Date(start).toISOString(),
    duration: end - start,
    beatsPerMinute: doc.heartRate,
    ...(doc.deviceId && { device: doc.deviceId }),
    isValid: doc.isValid !== false,
    srvCreated: end,
    srvModified: end,
  };
}
