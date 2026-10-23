// Calculations of the profiles page (profiles.js), kept free of the DOM so
// they can be tested: means and standard deviations of the sums that
// /api/reports/profiles returns, the percentages of a profile combined, the
// basal schedule per hour of day, and the series of a profile's chart.

const MINUTES_PER_DAY = 1440;

/** Mean and sample standard deviation of { n, sum, sumSq }; null where undefined. */
export function meanSd ({ n, sum, sumSq }) {
  if (!n) return { n: 0, mean: null, sd: null };
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : null;
  return { n, mean, sd };
}

const addStats = (a, b) => ({ n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq });
const ZERO = { n: 0, sum: 0, sumSq: 0 };

/** The usages of several percentages of a profile as one (pct null). */
export function combinePcts (pcts) {
  return {
    pct: null,
    minutes: pcts.reduce((s, u) => s + u.minutes, 0),
    basal: pcts.reduce((s, u) => s + u.basal, 0),
    bolus: pcts.reduce((s, u) => s + u.bolus, 0),
    sensitivity: {
      minutes: pcts.reduce((s, u) => s + u.sensitivity.minutes, 0),
      sum: pcts.reduce((s, u) => s + u.sensitivity.sum, 0),
    },
    days: pcts.reduce((s, u) => addStats(s, u.days), ZERO),
    hours: Array.from({ length: 24 }, (_, h) => ({
      basal: pcts.reduce((s, u) => addStats(s, u.hours[h].basal), ZERO),
      bolus: pcts.reduce((s, u) => addStats(s, u.hours[h].bolus), ZERO),
      ratio: pcts.reduce((s, u) => addStats(s, u.hours[h].ratio), ZERO),
    })),
  };
}

/** Rate (U/h) of a schedule ([[seconds from midnight, U/h]], sorted) at `seconds`. */
function rateAt (schedule, seconds) {
  let rate = schedule[0][1];
  for (const [s, r] of schedule) if (s <= seconds) rate = r;
  return rate;
}

/** The schedule's mean rate (U/h) in each local hour 0–23, times pct / 100. */
export function hourlyProfile (schedule, pct = 100) {
  if (!schedule?.length) return new Array(24).fill(null);
  return Array.from({ length: 24 }, (_, h) => {
    let s = 0;
    for (let m = 0; m < 60; m++) s += rateAt(schedule, (h * 60 + m) * 60);
    return (s / 60) * pct / 100;
  });
}

/**
 * The numbers of one row of the table: hours active, share of the window
 * (%), insulin in total, as basal and as boluses (U), insulin per active day
 * (U), the mean sensitivity ratio of the loop, and the mean and SD of whole
 * days under it.
 */
export function rowSummary (usage, windowMinutes) {
  const total = usage.basal + usage.bolus;
  const days = meanSd(usage.days);
  return {
    hours: usage.minutes / 60,
    share: windowMinutes > 0 ? (100 * usage.minutes) / windowMinutes : null,
    total,
    basal: usage.basal,
    bolus: usage.bolus,
    perDay: usage.minutes > 0 ? total / (usage.minutes / MINUTES_PER_DAY) : null,
    sensitivity: usage.sensitivity.minutes > 0 ? usage.sensitivity.sum / usage.sensitivity.minutes : null,
    fullDays: days.n,
    dayMean: days.mean,
    daySd: days.sd,
  };
}

/** Mean and mean ± SD per hour of day of one series of `hours` ('basal', 'bolus' or 'ratio'). */
function band (hours, key) {
  const stats = hours.map((h) => meanSd(h[key]));
  return {
    n: stats.map((s) => s.n),
    mean: stats.map((s) => s.mean),
    low: stats.map((s) => (s.mean == null ? null : Math.max(0, s.mean - (s.sd ?? 0)))),
    high: stats.map((s) => (s.mean == null ? null : s.mean + (s.sd ?? 0))),
  };
}

/**
 * The chart of a profile for one percentage (a number) or all ('all'): the
 * profile basal at 100% and at the percentages shown (U/h per hour of day),
 * the delivered basal and the boluses as mean ± SD (U/h), and the loop's
 * sensitivity ratio as mean ± SD.
 */
export function chartSeries (profile, pct = 'all') {
  const shown = pct === 'all' ? profile.pcts : profile.pcts.filter((u) => u.pct === pct);
  const usage = pct === 'all' ? combinePcts(profile.pcts) : shown[0] || combinePcts([]);
  return {
    profile: hourlyProfile(profile.schedule),
    adjusted: shown.filter((u) => u.pct !== 100).map((u) => ({ pct: u.pct, values: hourlyProfile(profile.schedule, u.pct) })),
    basal: band(usage.hours, 'basal'),
    bolus: band(usage.hours, 'bolus'),
    ratio: band(usage.hours, 'ratio'),
  };
}
