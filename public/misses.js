// The loop's misses (GET /api/analysis/misses, src/analysis/misses.js) as
// the page shows them: a sentence per miss and the period to select.
// Glucose arrives in mg/dL; `glucose(mgdl)` formats it in the page's unit.

const MIN = 60000;
const HOUR = 60 * MIN;
// The longest period to ask Claude about (app.js has the same).
const MAX_SELECTION = 12 * HOUR;

const units = (u) => `${Number(u.toFixed(2))} U`;
// "the hour", "the 2 hours", "the 45 minutes" from `from` to `to`.
function before (from, to) {
  const m = Math.round((to - from) / MIN);
  if (m === 60) return 'the hour';
  return m % 60 ? `the ${m} minutes` : `the ${m / 60} hours`;
}

const runs = (n) => `${n} run${n === 1 ? '' : 's'}`;
const value = (v, unit) => (v == null ? '' : ` of ${Number(v.toFixed(2))} ${unit}`);

/** A limit that held the loop back (src/analysis/misses.js, runLimits), with the AAPS setting behind it. */
export function limitText ({ kind, runs: n, value: v }) {
  switch (kind) {
    case 'smbSize':
      return `In ${runs(n)} an SMB was cut to the SMB size limit${value(v, 'U')}, set by "Max minutes of basal to limit SMB to".`;
    case 'uamSmbSize':
      return `In ${runs(n)} an SMB was cut to the SMB size limit${value(v, 'U')}, set by "Max minutes of basal to limit SMB to for UAM" (IOB was more than the logged carbs needed).`;
    case 'maxIob':
      if (v === 0) return `In ${runs(n)} max IOB was 0 U, so the loop could not take IOB above 0 (AAPS sets max IOB to 0 in Low Glucose Suspend mode and when the app has expired).`;
      return `In ${runs(n)} the loop asked for less because IOB would have gone over max IOB${value(v, 'U')} ("Maximum total IOB OpenAPS can't go over").`;
    case 'maxBasal':
      return `In ${runs(n)} the temp basal was cut to the max safe basal${value(v, 'U/h')} (max basal, or the max daily or current basal safety multiplier).`;
    case 'smbOff':
      return `In ${runs(n)} SMBs were switched off.`;
    case 'duplicates':
      return `In ${runs(n)} max IOB was 0 U because of duplicate glucose readings (two readings at most 20 s apart in the last 50 minutes; AAPS's glucose quality check), so the loop gave no SMBs and no basal above the profile.`;
    default:
      return `In ${runs(n)} a limit held the loop back.`;
  }
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
  const parts = [m.causedByDuplicates ? `High of ${glucose(m.glucose)}, caused by duplicate glucose readings.` : `High of ${glucose(m.glucose)}.`];
  if (m.dosedFor != null) parts.push(`In the hour before, the loop dosed for ${glucose(m.dosedFor)}`);
  parts[parts.length - 1] += m.dosedFor != null ? ` and gave ${units(m.smb)} of SMB.` : '';
  if (m.missing != null) parts.push(`Had it seen the peak coming it would have asked for about ${units(m.missing)} more.`);
  for (const l of m.limits || []) parts.push(limitText(l));
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

/** What the prompt for Claude says about the miss (askclaude.js). */
export function missNote (m, glucose) {
  const flags = m.flags.length ? ` (${m.flags.join(', ')})` : '';
  return `loopk flagged this as a loop miss${flags}: ${missSummary(m, glucose)} Explain why the loop did this and what would have prevented it.`;
}
