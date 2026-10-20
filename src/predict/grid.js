// The 5-minute grid of modelling/glupred/grid.py, over a window of slots:
// insulin delivered as boluses and as basal, the profile basal, and carbs,
// from the raw treatment records. Basal delivery is integrated per minute
// from the profile in effect and the temp basals, as in Python, so the
// model's inputs come out the same.

const MIN = 60000;

const minuteOf = (t) => Math.floor(t / MIN);
const mod = (a, n) => ((a % n) + n) % n;

/** Python's round(): half to even. */
export function roundHalfEven (x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Index of the first value above x in the sorted array (numpy searchsorted, side='right'). */
function upperBound (sorted, x, key = (v) => v) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(sorted[mid]) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const byDate = (records) => records.slice().sort((a, b) => a.date - b.date);

function toSchedule (raw) {
  const s = (raw || []).map(([seconds, rate]) => [Math.trunc(Number(seconds)), Number(rate)]).sort((a, b) => a[0] - b[0]);
  return s.length ? s : null;
}

const PCT_SUFFIX = /\s*\(\d+%\)$/;

/**
 * Basal schedule in effect over time: [{ start (minute), schedule, pct, shift }].
 * A schedule is a sorted list of [seconds from midnight, U/h]. A switch
 * without an embedded schedule uses the newest stored profile of that name;
 * a temporary switch (duration > 0) reverts to the previous permanent one.
 */
export function profileEvents (switches, stores) {
  const st = byDate(stores);
  const stored = (name, minute) => {
    if (name == null) return null;
    const base = name.replace(PCT_SUFFIX, '');
    let found = null;
    for (const s of st) if (s.name === base && minuteOf(s.date) <= minute) found = s.schedule;
    return found;
  };
  let current = null;
  if (st.length) {
    const first = st[0];
    const def = st.find((s) => s.date === first.date && s.name === first.defaultProfile);
    const schedule = toSchedule(def ? def.schedule : first.schedule);
    if (schedule) current = { start: -Infinity, schedule, pct: 100, shift: 0 };
  }
  const events = current ? [current] : [];
  let permanent = current;
  const rows = byDate(switches);
  rows.forEach((sw, i) => {
    const m = minuteOf(sw.date);
    const raw = sw.schedule != null ? sw.schedule : stored(sw.profile, m);
    const schedule = raw != null ? toSchedule(raw) : current?.schedule;
    if (!schedule) return;
    current = { start: m, schedule, pct: Number(sw.percentage ?? 100), shift: Math.trunc(Number(sw.timeshift ?? 0)) };
    events.push(current);
    const duration = Number(sw.duration) || 0;
    if (duration > 0 && permanent) {
      const end = m + Math.trunc(duration);
      const next = i + 1 < rows.length ? minuteOf(rows[i + 1].date) : Infinity;
      if (end < next) {
        current = { ...permanent, start: end };
        events.push(current);
      }
    } else {
      permanent = current;
    }
  });
  return events;
}

/** Profile basal rate (U/h) for the minutes first..first + count - 1 (0 where no profile is known). */
export function profileRates (first, count, offsetAt, events) {
  const rates = new Float64Array(count);
  let k = -1;
  for (let i = 0; i < count; i++) {
    const m = first + i;
    while (k + 1 < events.length && events[k + 1].start <= m) k++;
    if (k < 0) continue;
    const { schedule, pct, shift } = events[k];
    const local = mod(m + offsetAt(m) + shift * 60, 1440) * 60;
    const j = Math.max(upperBound(schedule, local, (s) => s[0]) - 1, 0);
    rates[i] = schedule[j][1] * pct / 100;
  }
  return rates;
}

/**
 * Delivered basal rate (U/h) for the same minutes: the profile rate,
 * replaced by temp basals. A temp basal ends at its duration or at the next
 * record; one without a duration cancels the running one.
 */
export function basalRates (first, profile, temps) {
  const rates = Float64Array.from(profile);
  const last = first + profile.length - 1;
  const ts = byDate(temps);
  ts.forEach((t, k) => {
    const d = t.durationMs / MIN;
    if (!(d > 0)) return;
    const s = minuteOf(t.date);
    let e = s + roundHalfEven(d);
    if (k + 1 < ts.length) e = Math.min(e, minuteOf(ts[k + 1].date));
    if (e <= first || s > last) return;
    const a = Math.max(s, first) - first;
    const b = Math.min(e, last + 1) - first;
    for (let i = a; i < b; i++) {
      if (t.rate != null && Number.isFinite(t.rate)) rates[i] = t.rate;
      else if (t.percent != null && Number.isFinite(t.percent)) rates[i] = profile[i] * Math.max(0, 1 + t.percent / 100);
    }
  });
  return rates;
}

/**
 * Records without a second one of the same amount (within `tolerance`)
 * within `seconds`: AAPS and pump syncs store some doses and carbs twice.
 */
export function dedupe (records, key, tolerance, seconds) {
  const b = byDate(records);
  const keep = b.map(() => true);
  let j = 0;
  for (let i = 1; i < b.length; i++) {
    while ((b[i].date - b[j].date) / 1000 > seconds) j++;
    for (let k = j; k < i; k++) {
      if (keep[k] && Math.abs(b[k][key] - b[i][key]) < tolerance) {
        keep[i] = false;
        break;
      }
    }
  }
  return b.filter((_, i) => keep[i]);
}

/**
 * Per slot of the window `firstSlot`..`firstSlot + n - 1` (slot numbers,
 * minutes / slotMinutes): bolus, basal and profile basal (U), and carbs (g).
 * `offsetAt(minute)` is the UTC offset in minutes. Treatments are
 * { boluses, extended, tempBasals, carbs, profileSwitches, profileStores }
 * with dates in ms.
 */
export function treatmentGrid (treatments, { firstSlot, n, slotMinutes, offsetAt, duplicates }) {
  const first = firstSlot * slotMinutes;
  const count = n * slotMinutes;
  const events = profileEvents(treatments.profileSwitches || [], treatments.profileStores || []);
  const profile = profileRates(first, count, offsetAt, events);
  const basal = basalRates(first, profile, treatments.tempBasals || []);

  const perMinute = new Float64Array(count);
  for (const x of byDate(treatments.extended || [])) {
    const d = Math.max(1, roundHalfEven(x.duration));
    const a = minuteOf(x.date) - first;
    const b = a + d;
    if (b <= 0 || a >= count) continue;
    for (let i = Math.max(a, 0); i < Math.min(b, count); i++) perMinute[i] += x.insulin / d;
  }

  const slots = (perMin) => {
    const out = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < slotMinutes; k++) s += perMin[i * slotMinutes + k];
      out[i] = s;
    }
    return out;
  };
  const sums = (records, key) => {
    const out = new Array(n).fill(0);
    for (const r of records) {
      const i = Math.floor(minuteOf(r.date) / slotMinutes) - firstSlot;
      if (i >= 0 && i < n) out[i] += r[key];
    }
    return out;
  };
  const extended = slots(perMinute);
  const boluses = sums(dedupe(treatments.boluses || [], 'insulin', duplicates.insulin, duplicates.seconds), 'insulin');
  return {
    bolus: boluses.map((v, i) => v + extended[i]),
    basal: slots(basal.map((r) => r / 60)),
    profileBasal: slots(profile.map((r) => r / 60)),
    carbs: sums(dedupe(treatments.carbs || [], 'carbs', duplicates.carbs, duplicates.seconds), 'carbs'),
  };
}
