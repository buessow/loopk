// Basal profiles in use for the profiles page (public/profiles.js): per
// profile version (name and basal schedule) and manual percentage, the time
// it was in effect and the insulin delivered meanwhile, and per hour of day
// the delivered basal and boluses (SMBs included) as sums and sums of squares,
// for means and standard deviations. Basal is integrated per minute from the
// profile and the temp basals, as for the hourly totals (index.js). The
// loop's sensitivity ratio (autosens or dynamic ISF, from devicestatus; above
// 1 is less sensitive) is summed the same way.

import { basalRates, profileEvents, profileRates, roundHalfEven } from '../predict/grid.js';
import { treatmentsBetween, zoneOffset } from '../predict/index.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Minutes integrated at once, to bound memory.
const CHUNK = 30 * 24 * 60;
// A loop run's sensitivity ratio holds until the next run, for at most this long (minutes).
const RATIO_STALE = 30;
// Minutes of an hour with a known ratio for it to count as a sample of the ratio.
const RATIO_COVER = 30;

const stat = () => ({ n: 0, sum: 0, sumSq: 0 });
const addStat = (s, v) => {
  s.n++;
  s.sum += v;
  s.sumSq += v * v;
};
const round = (v, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const roundStat = (s) => ({ n: s.n, sum: round(s.sum), sumSq: round(s.sumSq) });

/** Records with from <= date < to. */
const within = (list, from, to) => (list || []).filter((r) => r.date >= from && r.date < to);

/** 12 hex digits for a profile version (name and schedule): two 32-bit FNV-1a hashes, so the browser can make it too. */
function keyOf (event) {
  const text = `${event.name}\0${JSON.stringify(event.schedule)}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12);
}

function newUsage (pct) {
  return {
    pct,
    minutes: 0,
    basal: 0,
    bolus: 0,
    sensitivity: { minutes: 0, sum: 0 },
    days: stat(),
    hours: Array.from({ length: 24 }, () => ({ basal: stat(), bolus: stat(), ratio: stat() })),
  };
}

/**
 * A local clock hour or day being filled minute by minute. It counts as a
 * sample only if all of it lies in the window under one profile and percentage.
 */
function bucket (id, local, group) {
  return { id, first: local, last: local, group, basal: 0, bolus: 0, ratio: 0, ratioMinutes: 0 };
}

/**
 * Profile usage for from <= time < to (ms), limited to the time from the
 * first reading to now. Returns { from, to, timeZone, minutes, profiles },
 * profiles newest first: { key, name, schedule ([[seconds, U/h]], at 100%),
 * firstSeen, lastSeen (ms), current, pcts: [{ pct, minutes, basal, bolus (U),
 * sensitivity: { minutes, sum } of the ratio over the minutes it is known,
 * days: { n, sum, sumSq } of whole local days (U per day), hours: 24 x
 * { basal, bolus (U/h), ratio (mean sensitivity ratio): { n, sum, sumSq } }
 * of whole local clock hours }] }.
 */
export async function profileUsage (data, { from, to, timeZone, now = Date.now() }) {
  const first = await data.glucose.first();
  const start = first != null ? Math.max(from, first) : Infinity;
  const firstMin = Math.ceil(start / MIN);
  const endMin = Math.floor(Math.min(to, now) / MIN);
  if (!(endMin > firstMin)) return { from: null, to: null, timeZone, minutes: 0, profiles: [] };

  const [treatments, ratios] = await Promise.all([
    treatmentsBetween(data, firstMin * MIN - DAY, endMin * MIN),
    data.loop.sensitivityRatios((firstMin - RATIO_STALE) * MIN, endMin * MIN),
  ]);
  const runs = ratios.map((r) => ({ minute: Math.floor(new Date(r.date).getTime() / MIN), ratio: r.ratio }));
  let run = -1;
  const events = profileEvents(treatments.profileSwitches || [], treatments.profileStores || []);
  const keys = events.map(keyOf);

  const zone = new Map();
  const offsetAt = (minute) => {
    const h = Math.floor(minute / 60);
    if (!zone.has(h)) zone.set(h, zoneOffset(h * HOUR, timeZone));
    return zone.get(h);
  };

  const profiles = new Map();
  const usageOf = (k) => {
    const e = events[k];
    const key = keys[k];
    if (!profiles.has(key)) {
      profiles.set(key, { key, name: e.name ?? null, schedule: e.schedule, firstSeen: null, lastSeen: null, current: false, pcts: new Map() });
    }
    const p = profiles.get(key);
    if (!p.pcts.has(e.pct)) p.pcts.set(e.pct, newUsage(e.pct));
    return { profile: p, usage: p.pcts.get(e.pct) };
  };

  // Whole local hours and days become samples of their profile and percentage.
  let hour = null;
  let day = null;
  const flushHour = () => {
    if (hour && hour.group && hour.first % 60 === 0 && hour.last % 60 === 59) {
      const h = Math.floor(((hour.first % 1440) + 1440) % 1440 / 60);
      const hours = (hour.last - hour.first + 1) / 60;
      addStat(hour.group.hours[h].basal, hour.basal / hours);
      addStat(hour.group.hours[h].bolus, hour.bolus / hours);
      if (hour.ratioMinutes >= RATIO_COVER) addStat(hour.group.hours[h].ratio, hour.ratio / hour.ratioMinutes);
    }
  };
  const flushDay = () => {
    if (day && day.group && ((day.first % 1440) + 1440) % 1440 === 0 && ((day.last % 1440) + 1440) % 1440 === 1439) {
      addStat(day.group.days, day.basal + day.bolus);
    }
  };

  let lastKey = null;
  for (let m0 = firstMin; m0 < endMin; m0 += CHUNK) {
    const count = Math.min(CHUNK, endMin - m0);
    const a = m0 * MIN - DAY;
    const b = (m0 + count) * MIN;
    const rates = profileRates(m0, count, offsetAt, events);
    const basal = basalRates(m0, rates, within(treatments.tempBasals, a, b));
    const bolus = new Float64Array(count);
    for (const x of within(treatments.extended, a, b)) {
      const d = Math.max(1, roundHalfEven(x.duration));
      const s = Math.floor(x.date / MIN) - m0;
      for (let i = Math.max(s, 0); i < Math.min(s + d, count); i++) bolus[i] += x.insulin / d;
    }
    // The database moves duplicate boluses out as they are stored (migration 0010).
    for (const x of within(treatments.boluses, m0 * MIN, b)) bolus[Math.floor(x.date / MIN) - m0] += x.insulin;

    let k = -1;
    for (let i = 0; i < count; i++) {
      const m = m0 + i;
      while (k + 1 < events.length && events[k + 1].start <= m) k++;
      const used = k >= 0 ? usageOf(k) : null;
      const basalU = basal[i] / 60;
      while (run + 1 < runs.length && runs[run + 1].minute <= m) run++;
      const ratio = run >= 0 && m - runs[run].minute < RATIO_STALE ? runs[run].ratio : null;
      if (used) {
        const { profile, usage } = used;
        usage.minutes++;
        if (ratio != null) {
          usage.sensitivity.minutes++;
          usage.sensitivity.sum += ratio;
        }
        usage.basal += basalU;
        usage.bolus += bolus[i];
        if (profile.firstSeen == null) profile.firstSeen = m * MIN;
        profile.lastSeen = m * MIN;
      }
      const group = used ? used.usage : null;
      lastKey = used ? used.profile.key : null;
      const local = m + offsetAt(m);
      const hourId = Math.floor(local / 60);
      const dayId = Math.floor(local / 1440);
      if (!hour || hour.id !== hourId) {
        flushHour();
        hour = bucket(hourId, local, group);
      }
      if (!day || day.id !== dayId) {
        flushDay();
        day = bucket(dayId, local, group);
      }
      for (const x of [hour, day]) {
        if (x.group !== group) x.group = null;
        x.last = local;
        x.basal += basalU;
        x.bolus += bolus[i];
      }
      if (ratio != null) {
        hour.ratio += ratio;
        hour.ratioMinutes++;
      }
    }
  }
  flushHour();
  flushDay();

  // The profile in effect at the end of the window.
  if (lastKey) profiles.get(lastKey).current = true;

  const list = [...profiles.values()]
    .map((p) => ({
      ...p,
      pcts: [...p.pcts.values()]
        .sort((x, y) => x.pct - y.pct)
        .map((u) => ({
          pct: u.pct,
          minutes: u.minutes,
          basal: round(u.basal),
          bolus: round(u.bolus),
          sensitivity: { minutes: u.sensitivity.minutes, sum: round(u.sensitivity.sum) },
          days: roundStat(u.days),
          hours: u.hours.map((h) => ({ basal: roundStat(h.basal), bolus: roundStat(h.bolus), ratio: roundStat(h.ratio) })),
        })),
    }))
    .sort((x, y) => (y.current - x.current) || (y.lastSeen - x.lastSeen));
  return { from: firstMin * MIN, to: endMin * MIN, timeZone, minutes: endMin - firstMin, profiles: list };
}
