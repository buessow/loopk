// The profile AAPS used at a time: its effective profile switch (EPS), the
// profile with percentage and time shift already applied, as uploaded with
// each switch. Values are looked up by local time of day, as ProfileSealed
// does (blockValueBySeconds over MidnightUtils.secondsFromMidnight).
//
// After AndroidAPS (AGPL-3.0), commit 423a4502f2:
// core/objects/src/main/kotlin/app/aaps/core/objects/profile/ProfileSealed.kt

import { zoneOffset } from '../predict/index.js';
import { MMOLL_TO_MGDL } from './format.js';

const DAY_SECONDS = 86400;
const SLOT = 15 * 60000;
const offsets = new Map();

/**
 * The phone's clock: its UTC offset (minutes) over time, as AAPS writes it on
 * each record. AAPS reads profiles by the phone's local time, which follows
 * daylight saving and travel, not the profile's time zone name.
 */
export class PhoneClock {
  /** `records`: [{ timestamp, offset }] sorted, e.g. the phone's temp basals. */
  constructor (records) {
    this.times = [];
    this.offsets = [];
    let last = null;
    for (const r of records) {
      if (r.offset == null) continue;
      if (last && r.offset === last.offset) {
        last = r;
        continue;
      }
      // a change happens on the half hour (DST) or between the two records
      const half = 30 * 60000;
      const at = last ? Math.max(last.timestamp + 1, Math.floor(r.timestamp / half) * half) : -Infinity;
      this.times.push(at);
      this.offsets.push(r.offset);
      last = r;
    }
  }

  get empty () { return this.offsets.length === 0; }

  offsetAt (t) {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return this.offsets[Math.max(0, lo - 1)];
  }
}

/**
 * The UTC offset (minutes) at t: from a PhoneClock, or zoneOffset of a time
 * zone name, remembered per 15 minutes (offsets change on the quarter hour
 * at most, and replays ask for them very often).
 */
export function localOffset (t, timeZone) {
  if (timeZone instanceof PhoneClock) return timeZone.offsetAt(t);
  const slot = Math.floor(t / SLOT);
  let zone = offsets.get(timeZone);
  if (!zone) offsets.set(timeZone, zone = new Map());
  let v = zone.get(slot);
  if (v === undefined) {
    if (zone.size > 100000) zone.clear();
    v = zoneOffset(slot * SLOT, timeZone);
    zone.set(slot, v);
  }
  return v;
}

/** Seconds since local midnight at t in `timeZone`. */
export function secondsFromMidnight (t, timeZone) {
  const local = t + localOffset(t, timeZone) * 60000;
  return Math.floor((((local % 86400000) + 86400000) % 86400000) / 1000);
}

/** The value of a schedule [[seconds, value]] (sorted) at `seconds` from midnight. */
export function blockValue (schedule, seconds) {
  let value = schedule[0][1];
  for (const [start, v] of schedule) {
    if (start <= seconds) value = v;
    else break;
  }
  return value;
}

/**
 * One effective profile: { date, dia, units, timeZone, percentage, basal,
 * ic, isf, targetLow, targetHigh } with schedules [[seconds, value]] in the
 * profile's units.
 */
export class Profile {
  constructor (eps) {
    Object.assign(this, eps);
    this.toMgdl = eps.units && eps.units.toLowerCase().startsWith('mmol') ? MMOLL_TO_MGDL : 1;
  }

  seconds (t) { return secondsFromMidnight(t, this.timeZone) % DAY_SECONDS; }
  getBasal (t) { return blockValue(this.basal, this.seconds(t)); }
  getIc (t) { return blockValue(this.ic, this.seconds(t)); }
  getIsfMgdl (t) { return blockValue(this.isf, this.seconds(t)) * this.toMgdl; }
  getTargetLowMgdl (t) { return blockValue(this.targetLow, this.seconds(t)) * this.toMgdl; }
  getTargetHighMgdl (t) { return blockValue(this.targetHigh, this.seconds(t)) * this.toMgdl; }
  getTargetMgdl (t) { return (this.getTargetLowMgdl(t) + this.getTargetHighMgdl(t)) / 2; }
  /** The largest basal rate of the day (getMaxDailyBasal). */
  getMaxDailyBasal () { return Math.max(...this.basal.map(([, v]) => v)); }
}

/** profileFunction.getProfile(t): the newest effective profile at or before t. */
export class ProfileTimeline {
  constructor (switches) {
    this.list = switches.slice().sort((a, b) => a.date - b.date).map((s) => new Profile(s));
  }

  at (t) {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid].date <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? this.list[lo - 1] : null;
  }
}
