// The request to Claude for a review of the loop: the AAPS guide
// (docs/aaps-algorithms.md) as the system prompt, and the records of
// context.js as plain-text tables in the user message.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = fs.readFileSync(path.join(root, 'docs', 'aaps-algorithms.md'), 'utf8');
const MGDL_PER_MMOL = 18.0182;
const HR_BUCKET = 15 * 60000;

export const SYSTEM = `You review the decisions of an AAPS (AndroidAPS) closed loop for one person with type 1 diabetes, from the loop's own records. The person reads your review on their Nightscout-compatible dashboard. They know AAPS well; they want to learn whether the loop dosed well in a period they selected and which setting, if any, made it go wrong.

How AAPS doses, checked against the AAPS source code (master-3.4), is described in the guide below. Use it to explain the loop's behaviour: name the mechanism (ISF and its adaptation, sensitivity ratio, UAM, SMB size limits, max IOB, low glucose suspend, carb absorption) behind each decision you discuss. Where the guide and the records disagree, trust the records and say so.

<aaps_guide>
${GUIDE}
</aaps_guide>`;

const pad = (n) => String(n).padStart(2, '0');

/**
 * The runs grouped into periods of the same algorithm and dynamic ISF state:
 * [{ from, to, algorithm, dynamicIsf }]; runs that report neither are left out.
 */
export function algorithmPeriods (runs) {
  const periods = [];
  for (const r of runs) {
    if (r.algorithm == null && r.dynamic_isf == null) continue;
    const last = periods[periods.length - 1];
    if (last && last.algorithm === r.algorithm && last.dynamicIsf === r.dynamic_isf) last.to = r.date;
    else periods.push({ from: r.date, to: r.date, algorithm: r.algorithm, dynamicIsf: r.dynamic_isf });
  }
  return periods;
}

/** Formats epoch ms as "Thu 22 Oct 14:05" in the time zone. */
export function timeFormatter (timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (t) => {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month} ${pad(p.hour)}:${pad(p.minute)}`;
  };
}

const num = (v, digits = 2) => (v == null ? '' : String(Math.round(v * 10 ** digits) / 10 ** digits));
const cell = (v) => (v == null ? '' : String(v).replace(/[\r\n|]+/g, ' ').trim());
const table = (head, rows) => [head.join(' | '), ...rows.map((r) => r.map(cell).join(' | '))].join('\n');

/** One treatment as an event name and its details. */
function treatment (t) {
  const parts = [];
  if (t.insulin) parts.push(`${num(t.insulin)} U${t.is_smb || t.type === 'SMB' ? ' SMB' : ''}`);
  if (t.carbs) parts.push(`${num(t.carbs, 0)} g carbs`);
  if (t.protein) parts.push(`${num(t.protein, 0)} g protein`);
  if (t.fat) parts.push(`${num(t.fat, 0)} g fat`);
  if (t.event_type === 'Temp Basal') parts.push(`${t.rate != null ? num(t.rate) + ' U/h' : num(t.percent, 0) + '%'} for ${num(t.minutes, 0)} min`);
  else if (t.minutes) parts.push(`${num(t.minutes, 0)} min`);
  if (t.target_bottom != null || t.target_top != null) parts.push(`target ${num(t.target_bottom, 1)}–${num(t.target_top, 1)}${t.units ? ' ' + t.units : ''}`);
  if (t.profile) parts.push(`profile ${t.profile}${t.percentage != null && t.percentage !== 100 ? ` ${num(t.percentage, 0)}%` : ''}${t.timeshift ? ` shift ${num(t.timeshift, 0)} h` : ''}`);
  if (t.glucose) parts.push(`BG check ${num(t.glucose, 1)}`);
  if (t.reason) parts.push(`reason: ${t.reason}`);
  if (t.notes) parts.push(`notes: ${t.notes}`);
  return [t.event_type || t.type || 'Treatment', parts.join(', ')];
}

/** A profile schedule ([[seconds from midnight, value]]) as "00:00 0.8, 06:00 1.1". */
function schedule (rows) {
  return (rows || []).map(([s, v]) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)} ${num(v)}`).join(', ');
}

/** Heart rate as 15-minute means, so a watch's per-second samples stay small. */
function heartRateMeans (samples) {
  const buckets = new Map();
  for (const { date, bpm } of samples) {
    const k = Math.floor(date / HR_BUCKET) * HR_BUCKET;
    const b = buckets.get(k) || { n: 0, sum: 0, max: 0 };
    b.n++;
    b.sum += bpm;
    b.max = Math.max(b.max, bpm);
    buckets.set(k, b);
  }
  return [...buckets].sort((a, b) => a[0] - b[0]).map(([t, b]) => [t, Math.round(b.sum / b.n), Math.round(b.max)]);
}

/** Loop runs without the duplicates some uploaders send (same reason within a minute). */
export function uniqueRuns (runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r.date - last.date < 60000 && r.reason === last.reason) continue;
    out.push(r);
  }
  return out;
}

const positive = (v) => (v != null && v >= 0 ? v : null);

/** Glucose units the person may read the review in. */
export const UNITS = ['mmol/L', 'mg/dL'];

/**
 * The user message: what to judge, then the records as tables. `units` is
 * the glucose unit the person reads the page in: the answer uses it too.
 */
export function userMessage (c, { question = '', units = 'mmol/L' } = {}) {
  const at = timeFormatter(c.timeZone);
  const inWindow = (t) => t >= c.from && t < c.to;
  const mark = (t) => (inWindow(t) ? '*' : '');
  const out = [];

  out.push(`The person selected ${at(c.from)} – ${at(c.to)} (${c.timeZone}). Review what the loop did in that window.

Judge each important decision by what the loop knew at the time (its reason line, IOB, COB, predictions) and by what happened afterwards (the readings up to 3 hours after the window). Decide whether the loop acted about right, over-corrected (too much insulin: a low, a fast drop, or carbs needed) or under-corrected (too little or too late: glucose stayed high or rose), and why. Separate what the loop could not know (unlogged carbs, exercise, a sensor error, a site problem) from what its settings or algorithm caused. Use the person's profile, configuration and the guide. If the records do not show something, say it is unknown rather than guessing.

Answer in Markdown, in this order:
1. **Verdict**: one line, one of "About right", "Over-corrected", "Under-corrected" or "Mixed", with the main reason.
2. **In plain words**: 3 to 6 sentences for someone who uses the loop but knows little about how its algorithm works: what glucose did, what the loop did about it and why, and whether that was good. Use everyday words; avoid abbreviations such as IOB, COB, ISF, SMB, UAM or eventual BG, or explain each in a few words the first time (for example "insulin still working in the body"). Make it understandable without the sections below.
3. **What happened**: the key moments as a short list with times (glucose, IOB, COB, what the loop did).
4. **Why**: the mechanisms behind the decisions, referring to the guide.
5. **What to change**: concrete settings to look at, only where the records support it, each with how sure you are. Say so if nothing should change.
6. Last, the moments to mark on the person's glucose chart, as a fenced code block with the info string \`annotations\` holding a JSON array of 2 to 8 objects, in time order:
\`\`\`annotations
[{"at": "Thu 22 Oct 18:40", "until": "Thu 22 Oct 19:30", "kind": "under", "text": "UAM late: SMBs capped at 0.6 U"}]
\`\`\`
"at" (and optional "until", for a period) are times written exactly as in the tables; "kind" is "over" (too much insulin), "under" (too little or too late), "ok" (a good decision) or "note" (context, such as unlogged carbs); "text" says what happened in at most 60 characters. Refer to them in the text by their number in this list, as (1), (2) and so on. Write nothing after the block.

The person may ask follow-up questions. Answer them from the same records and the guide, briefly and to the point, in the same plain language where the question allows, referring to the marks by number. Only if a follow-up answer points at moments not marked yet, end it with a new annotations block that lists the earlier marks first, unchanged and in the same order, then the new ones.

The person reads glucose in ${units}. Write every glucose value, target, glucose change and ISF in your answers and marks in ${units} (ISF as ${units} per U), also where the records use the other unit: the tables give glucose in both, but the loop's reason lines and the profile use ${c.profile?.units || 'the profile\'s'} units, and the loop-run columns are in mg/dL (1 mmol/L = 18 mg/dL). Insulin is in units (U), carbs in grams.

Keep the text under about 700 words.`);
  if (question.trim()) out.push(`The person adds: ${question.trim()}`);

  out.push(`## Records

Times are local (${c.timeZone}). The records run from ${at(c.start)} (${(c.from - c.start) / 3600000} h before the window, for insulin and carbs still acting) to ${at(c.end)}. Rows inside the selected window are marked with * in the first column.`);

  const k = c.configuration;
  const periods = algorithmPeriods(c.runs);
  const settings = k && [['APS', k.aps_settings], ['sensitivity', k.sensitivity_settings], ['insulin', k.insulin_settings], ['safety', k.safety_settings]]
    .filter(([, v]) => v && Object.keys(v).length)
    .map(([name, v]) => `${name} settings: ${JSON.stringify(v)}`);
  out.push(`### Loop configuration
${k ? `Newest before the window's end (${at(k.date)}): APS: ${cell(k.aps)}; sensitivity plugin id: ${cell(k.sensitivity)}; insulin plugin id: ${cell(k.insulin)}; AAPS version: ${cell(k.version)}${settings.length ? '\n' + settings.join('\n') : ''}` : 'No configuration was uploaded before the window\'s end.'}
Algorithm of the loop runs (as each run reported it; "dynamic ISF" is true when the run adjusted ISF itself, by DynamicISF or AutoISF):
${periods.length ? periods.map((a) => `- ${at(a.from)} to ${at(a.to)}: ${cell(a.algorithm) || 'unknown'}, dynamic ISF ${a.dynamicIsf ?? 'unknown'}`).join('\n') : '- unknown: the runs did not say'}`);

  if (c.profile) {
    const p = c.profile;
    const s = p.schedules || {};
    out.push(`### Profile in effect (${p.source} ${cell(p.name)}, ${at(p.date)})
Units: ${cell(p.units)}; DIA: ${num(p.dia, 1)} h; time zone: ${cell(p.timezone)}
Basal (U/h): ${schedule(s.basal)}
ISF (${cell(p.units)} per U): ${schedule(s.sens)}
Carb ratio (g per U): ${schedule(s.carbratio)}
Target low: ${schedule(s.target_low)}
Target high: ${schedule(s.target_high)}`);
  } else {
    out.push('### Profile in effect\nUnknown: no profile found.');
  }

  out.push(`### Glucose readings (${c.readings.length})
${table(['', 'time', 'mg/dL', 'mmol/L', 'trend'], c.readings.map((r) => [mark(r.date), at(r.date), num(r.sgv, 0), num(r.sgv / MGDL_PER_MMOL, 1), r.direction]))}`);

  out.push(`### Treatments (${c.treatments.length}): boluses, SMBs, carbs, temp basals, temp targets, profile switches, notes
${table(['', 'time', 'event', 'details'], c.treatments.map((t) => [mark(t.date), at(t.date), ...treatment(t)]))}`);

  const runs = uniqueRuns(c.runs);
  out.push(`### Loop runs (${runs.length}): what each run decided
BG, eventual BG, target and ISF used are in mg/dL (ISF per U); the reason text uses the profile's units. "set" is yes when the run was enacted; an empty temp rate means no new temp basal.
${table(['', 'time', 'BG', 'eventual BG', 'target', 'IOB (U)', 'basal IOB (U)', 'COB (g)', 'insulin req (U)', 'sens ratio', 'ISF used', 'temp rate (U/h)', 'for (min)', 'SMB (U)', 'set', 'reason'],
    runs.map((r) => [mark(r.date), at(r.date), num(r.bg, 0), num(r.eventual_bg, 0), num(r.target_bg, 0), num(r.iob), num(r.basal_iob), num(r.cob, 0),
      num(r.insulin_req), num(r.sensitivity_ratio), num(r.variable_sens, 1), num(positive(r.rate)), num(positive(r.duration), 0), num(r.smb), r.enacted ? 'yes' : '', r.reason]))}`);

  const logs = runs.filter((r) => r.console_log?.length || r.console_error?.length);
  if (logs.length) {
    out.push(`### Loop console logs inside the window (${logs.length} runs)
AAPS writes the algorithm's step-by-step output to consoleError; it is normal output, not errors.
${logs.map((r) => `#### ${at(r.date)}\n${[...(r.console_error || []), ...(r.console_log || [])].join('\n')}`).join('\n\n')}`);
  }

  if (c.heartRate.length) {
    out.push(`### Heart rate, 15-minute mean and maximum (bpm)
${table(['', 'from', 'mean', 'max'], heartRateMeans(c.heartRate).map(([t, mean, max]) => [mark(t), at(t), mean, max]))}`);
  }

  return out.join('\n\n');
}
