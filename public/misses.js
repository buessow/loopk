// The loop's misses (GET /api/analysis/misses, src/analysis/misses.js) as
// the page shows them: a sentence per miss and the period to select.
// Glucose arrives in mg/dL; `glucose(mgdl)` formats it in the page's unit.

const MIN = 60000;
const HOUR = 60 * MIN;
// The longest period Claude reviews (src/analysis/context.js, MAX_WINDOW).
const MAX_SELECTION = 12 * HOUR;

const units = (u) => `${Number(u.toFixed(2))} U`;
// "the hour", "the 2 hours", "the 45 minutes" from `from` to `to`.
function before (from, to) {
  const m = Math.round((to - from) / MIN);
  if (m === 60) return 'the hour';
  return m % 60 ? `the ${m} minutes` : `the ${m / 60} hours`;
}

/** What happened, in one or two sentences. */
export function missSummary (m, glucose) {
  const e = m.expected || {};
  if (m.kind === 'low') {
    const parts = [`Low of ${glucose(m.glucose)} after ${units(m.smb)} of SMB in ${before(m.from, m.start)} before`];
    if (m.excess != null) parts[0] += `, about ${units(m.excess)} more than the low left room for`;
    parts[0] += '.';
    if (e.minGuardBG != null) parts.push(`At its largest SMB the loop expected no lower than ${glucose(e.minGuardBG)}.`);
    if (m.smbAfterRescue >= 0.05) parts.push(`${units(m.smbAfterRescue)} came after ${m.rescueCarbs} g of rescue carbs.`);
    return parts.join(' ');
  }
  const parts = [`High of ${glucose(m.glucose)}.`];
  if (m.dosedFor != null) parts.push(`In the hour before, the loop dosed for ${glucose(m.dosedFor)}`);
  parts[parts.length - 1] += m.dosedFor != null ? ` and gave ${units(m.smb)} of SMB.` : '';
  if (m.missing != null) parts.push(`Had it seen the peak coming it would have asked for about ${units(m.missing)} more.`);
  if (m.limitedRuns) parts.push(`A limit capped ${m.limitedRuns} of its runs.`);
  return parts.join(' ');
}

/**
 * The period to select for the miss: from the start of what led to it to
 * shortly after it ended, at most the longest review.
 */
export function missSelection (m) {
  const from = m.from;
  return { from, to: Math.min(m.end + 30 * MIN, from + MAX_SELECTION) };
}

/** What Claude is told about the miss with the review. */
export function missNote (m, glucose) {
  const flags = m.flags.length ? ` (${m.flags.join(', ')})` : '';
  return `loopk flagged this as a loop miss${flags}: ${missSummary(m, glucose)} Explain why the loop did this and what would have prevented it.`;
}
