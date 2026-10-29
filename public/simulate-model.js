// The simulate page's model (simulate.js): the settings it offers, the
// changes a form makes (POST /api/simulate/run and /period,
// src/oref/simulate.js) and the rows of the results. Glucose arrives in
// mg/dL; `glucose(mgdl)` formats it in the page's unit.

export const MGDL_PER_MMOL = 18;
const MIN = 60000;
const HOUR = 60 * MIN;

/**
 * The loop settings the form shows, with AAPS's name for each; kind
 * 'number' or 'boolean'; `algorithms` limits one to those algorithms.
 */
const AUTO = ['AUTO_ISF'];
const DYN = ['SMB+DynISF'];

/**
 * Every setting the simulator takes (src/oref/settings.js DEFAULTS), by
 * group. `algorithms`: the ones it applies to (all when absent). Glucose
 * in mg/dL, as AAPS keeps them.
 */
export const SETTING_FIELDS = [
  // limits
  { group: 'Limits', key: 'max_iob', label: 'Max IOB (U)', aaps: "Maximum total IOB OpenAPS can't go over", kind: 'number', step: 0.5 },
  { group: 'Limits', key: 'max_basal', label: 'Max basal (U/h)', aaps: 'Max U/hr a Temp Basal can be set to', kind: 'number', step: 0.05 },
  { group: 'Limits', key: 'max_daily_safety_multiplier', label: 'Max daily basal ×', aaps: 'Max daily safety multiplier', kind: 'number', step: 0.5 },
  { group: 'Limits', key: 'current_basal_safety_multiplier', label: 'Current basal ×', aaps: 'Current basal safety multiplier', kind: 'number', step: 0.5 },
  { group: 'Limits', key: 'lgsThreshold', label: 'Low glucose suspend (mg/dL)', aaps: 'Low glucose suspend threshold (empty: from the target)', kind: 'number', step: 1, nullable: true },
  { group: 'Limits', key: 'skip_neutral_temps', label: 'Skip neutral temps', aaps: 'Skip neutral temps', kind: 'boolean' },
  // SMB
  { group: 'SMB', key: 'maxSMBBasalMinutes', label: 'SMB limit (minutes of basal)', aaps: 'Max minutes of basal to limit SMB to', kind: 'number', step: 15 },
  { group: 'SMB', key: 'maxUAMSMBBasalMinutes', label: 'UAM SMB limit (minutes of basal)', aaps: 'Max minutes of basal to limit SMB to for UAM', kind: 'number', step: 15 },
  { group: 'SMB', key: 'SMBInterval', label: 'SMB interval (min)', aaps: 'How frequently SMBs will be given in min', kind: 'number', step: 1 },
  { group: 'SMB', key: 'bolus_increment', label: 'Bolus step (U)', aaps: "The pump's bolus step", kind: 'number', step: 0.01 },
  { group: 'SMB', key: 'enableSMB_always', label: 'SMB always', aaps: 'Enable SMB always', kind: 'boolean' },
  { group: 'SMB', key: 'enableUAM', label: 'UAM', aaps: 'Enable UAM', kind: 'boolean' },
  { group: 'SMB', key: 'enableSMB_with_COB', label: 'SMB with COB', aaps: 'Enable SMB with COB', kind: 'boolean' },
  { group: 'SMB', key: 'enableSMB_after_carbs', label: 'SMB after carbs', aaps: 'Enable SMB after carbs', kind: 'boolean' },
  { group: 'SMB', key: 'enableSMB_with_temptarget', label: 'SMB with low temp target', aaps: 'Enable SMB with temp targets', kind: 'boolean' },
  { group: 'SMB', key: 'allowSMB_with_high_temptarget', label: 'SMB with high temp target', aaps: 'Allow SMB with high temp target', kind: 'boolean' },
  { group: 'SMB', key: 'A52_risk_enable', label: 'SMB with any carbs', aaps: 'A52 risk: SMB with any COB, also without SMB always', kind: 'boolean' },
  // targets and sensitivity
  { group: 'Targets and sensitivity', key: 'sensitivity_raises_target', label: 'Sensitivity raises target', aaps: 'Sensitivity raises target', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'resistance_lowers_target', label: 'Resistance lowers target', aaps: 'Resistance lowers target', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'adv_target_adjustments', label: 'Advanced target adjustments', aaps: 'Advanced target adjustments', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'highTemptargetRaisesSensitivity', label: 'High temp target raises sensitivity', aaps: 'High temptarget raises sensitivity', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'lowTemptargetLowersSensitivity', label: 'Low temp target lowers sensitivity', aaps: 'Low temptarget lowers sensitivity', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'exercise_mode', label: 'Exercise mode', aaps: 'Exercise mode (high temp target raises sensitivity)', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'half_basal_exercise_target', label: 'Half basal exercise target (mg/dL)', aaps: 'Half basal exercise target', kind: 'number', step: 1 },
  { group: 'Targets and sensitivity', key: 'autosens', label: 'Autosens', aaps: 'Use autosens', kind: 'boolean' },
  { group: 'Targets and sensitivity', key: 'autosensMin', label: 'Autosens min', aaps: 'Autosens min ratio', kind: 'number', step: 0.05 },
  { group: 'Targets and sensitivity', key: 'autosensMax', label: 'Autosens max', aaps: 'Autosens max ratio', kind: 'number', step: 0.05 },
  // carbs and insulin
  { group: 'Carbs and insulin', key: 'maxCOB', label: 'Max COB (g)', aaps: 'Max COB', kind: 'number', step: 5 },
  { group: 'Carbs and insulin', key: 'remainingCarbsCap', label: 'Remaining carbs cap (g)', aaps: 'Remaining carbs cap', kind: 'number', step: 5 },
  { group: 'Carbs and insulin', key: 'carbsReqThreshold', label: 'Carbs required from (g)', aaps: 'Minimal carbs required for suggestion', kind: 'number', step: 1 },
  { group: 'Carbs and insulin', key: 'min5mCarbImpact', label: 'Min carb impact (mg/dL per 5 min)', aaps: 'min_5m_carbimpact', kind: 'number', step: 1 },
  { group: 'Carbs and insulin', key: 'absorptionCutoff', label: 'Meal max absorption (h)', aaps: 'Meal max absorption time [h]', kind: 'number', step: 0.5 },
  { group: 'Carbs and insulin', key: 'insulinPeak', label: 'Insulin peak (min)', aaps: 'Peak time of the insulin type', kind: 'number', step: 5 },
  { group: 'Carbs and insulin', key: 'snoozeDivisor', label: 'Bolus snooze divisor', aaps: 'Bolus snooze DIA divisor', kind: 'number', step: 0.5 },
  // Dynamic ISF
  { group: 'Dynamic ISF', key: 'dynIsfAdjustmentFactor', label: 'Adjustment factor (%)', aaps: 'DynamicISF Adjustment Factor %', kind: 'number', step: 5, algorithms: DYN },
  { group: 'Dynamic ISF', key: 'dynIsfAdjustSensitivity', label: 'TDD sensitivity ratio', aaps: 'Enable TDD based sensitivity ratio for basal and glucose target modification', kind: 'boolean', algorithms: DYN },
  // AutoISF
  { group: 'AutoISF', key: 'autoIsfWeights', label: 'AutoISF weights', aaps: 'Enable autoISF weights', kind: 'boolean', algorithms: AUTO },
  { group: 'AutoISF', key: 'autoISF_min', label: 'AutoISF min', aaps: 'autoISF_min', kind: 'number', step: 0.05, algorithms: AUTO },
  { group: 'AutoISF', key: 'autoISF_max', label: 'AutoISF max', aaps: 'autoISF_max', kind: 'number', step: 0.05, algorithms: AUTO },
  { group: 'AutoISF', key: 'bgAccel_ISF_weight', label: 'Acceleration weight', aaps: 'bgAccel_ISF_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'bgBrake_ISF_weight', label: 'Brake weight', aaps: 'bgBrake_ISF_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'pp_ISF_weight', label: 'Postprandial weight', aaps: 'pp_ISF_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'lower_ISFrange_weight', label: 'Below target weight', aaps: 'lower_ISFrange_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'higher_ISFrange_weight', label: 'Above target weight', aaps: 'higher_ISFrange_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'dura_ISF_weight', label: 'Duration weight', aaps: 'dura_ISF_weight', kind: 'number', step: 0.01, algorithms: AUTO },
  { group: 'AutoISF', key: 'smb_delivery_ratio', label: 'SMB delivery ratio', aaps: 'smb_delivery_ratio', kind: 'number', step: 0.05, algorithms: AUTO },
  { group: 'AutoISF', key: 'smb_delivery_ratio_min', label: 'SMB delivery ratio min', aaps: 'smb_delivery_ratio_min', kind: 'number', step: 0.05, algorithms: AUTO },
  { group: 'AutoISF', key: 'smb_delivery_ratio_max', label: 'SMB delivery ratio max', aaps: 'smb_delivery_ratio_max', kind: 'number', step: 0.05, algorithms: AUTO },
  { group: 'AutoISF', key: 'smb_delivery_ratio_bg_range', label: 'SMB ratio glucose range (mg/dL)', aaps: 'smb_delivery_ratio_bg_range (0: fixed ratio)', kind: 'number', step: 1, algorithms: AUTO },
  { group: 'AutoISF', key: 'smb_max_range_extension', label: 'SMB range extension', aaps: 'smb_max_range_extension', kind: 'number', step: 0.1, algorithms: AUTO },
  { group: 'AutoISF', key: 'iob_threshold_percent', label: 'IOB threshold (%)', aaps: 'iobTH', kind: 'number', step: 5, algorithms: AUTO },
  { group: 'AutoISF', key: 'enableSMB_EvenOn_OddOff_always', label: 'SMB on even targets only', aaps: 'Enable alternative activation of SMB depending on active target being even number', kind: 'boolean', algorithms: AUTO },
];

/** Groups shown open; the others fold away. */
export const OPEN_GROUPS = ['Limits', 'SMB'];

export const ALGORITHM_NAMES = { SMB: 'SMB', 'SMB+DynISF': 'SMB + Dynamic ISF', AUTO_ISF: 'AutoISF' };

const sameValue = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

/**
 * The changes of a form: `form` { settings: { key: value }, extra (JSON
 * text of further settings), profileName ('' the profile as recorded, or
 * a stored profile), percentage, isfFactor, carbRatioFactor,
 * basalFactor, target (in `units`), algorithm ('' as recorded),
 * tempTarget ('' unchanged, 'none', 'set'), tempTargetValue (in `units`),
 * tempTargetMinutes, sensitivityRatio ('' as recorded) }; `baseline` the
 * settings values. Only what differs from the baseline goes in. Throws on
 * an extra that isn't a JSON object.
 */
export function formChanges (form, baseline, units = 'mmol/L') {
  const toMgdl = (v) => (units === 'mmol/L' ? v * MGDL_PER_MMOL : v);
  const changes = {};
  const settings = {};
  for (const [key, value] of Object.entries(form.settings || {})) {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) continue;
    if (!sameValue(value, baseline[key])) settings[key] = value;
  }
  if (form.extra && form.extra.trim()) {
    const extra = JSON.parse(form.extra);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Further settings must be a JSON object');
    Object.assign(settings, extra);
  }
  if (Object.keys(settings).length) changes.settings = settings;
  const profile = {};
  const factor = (name, v) => { if (Number.isFinite(v) && Math.abs(v - 1) > 1e-9) profile[name] = v; };
  if (form.profileName) profile.name = form.profileName;
  if (Number.isFinite(form.percentage)) profile.percentage = form.percentage;
  factor('isfFactor', form.isfFactor);
  factor('carbRatioFactor', form.carbRatioFactor);
  factor('basalFactor', form.basalFactor);
  if (Number.isFinite(form.target)) profile.targetMgdl = Math.round(toMgdl(form.target));
  if (Object.keys(profile).length) changes.profile = profile;
  if (form.algorithm) changes.algorithm = form.algorithm;
  if (form.tempTarget === 'none') changes.tempTarget = null;
  else if (form.tempTarget === 'set' && Number.isFinite(form.tempTargetValue)) {
    changes.tempTarget = { targetMgdl: Math.round(toMgdl(form.tempTargetValue)), minutes: Number.isFinite(form.tempTargetMinutes) ? form.tempTargetMinutes : 60 };
  }
  if (Number.isFinite(form.sensitivityRatio)) changes.sensitivityRatio = form.sensitivityRatio;
  return changes;
}

const units = (v) => (v == null ? '–' : `${Number(v.toFixed(2))} U`);
const rate = (r) => (r.rate == null ? 'no change' : r.duration === 0 ? 'cancel temp' : `${r.rate.toFixed(2)} U/h for ${Math.round(r.duration)} min`);

/** What a decision does, in a few words. */
export function decisionText (d) {
  const parts = [];
  if (d.smb > 0) parts.push(`SMB ${units(d.smb)}`);
  parts.push(d.rate == null ? 'temp unchanged' : rate(d));
  return parts.join(', ');
}

/** The limits a decision hit (src/analysis/misses.js runLimits), as short labels. */
export function limitLabels (limits = []) {
  const names = { smbSize: 'SMB size limit', uamSmbSize: 'UAM SMB size limit', maxIob: 'max IOB', maxBasal: 'max safe basal', smbOff: 'SMB off', duplicates: 'duplicate readings' };
  return limits.map((l) => `${names[l.kind] || l.kind}${l.value != null ? ` ${Number(l.value.toFixed(2))}` : ''}`);
}

/**
 * The rows comparing the recorded decision, loopk's baseline and the
 * changed one: [label, recorded, baseline, changed] as text.
 */
export function decisionRows (r, glucose) {
  const g = (v) => (v == null ? '–' : glucose(v));
  const n = (v, d = 2) => (v == null ? '–' : Number(v.toFixed(d)).toString());
  const rows = [
    ['Algorithm', ALGORITHM_NAMES[r.recorded.algorithm] || r.recorded.algorithm, ALGORITHM_NAMES[r.baseline.algorithm], ALGORITHM_NAMES[r.changed.algorithm]],
    ['SMB (U)', n(r.recorded.smb), n(r.baseline.smb), n(r.changed.smb)],
    ['Temp basal', rate(r.recorded), rate(r.baseline), rate(r.changed)],
    ['Eventual glucose', g(r.recorded.eventualBG), g(r.baseline.eventualBG), g(r.changed.eventualBG)],
    ['Insulin required (U)', n(r.recorded.insulinReq), n(r.baseline.insulinReq), n(r.changed.insulinReq)],
    ['Target', '–', g(r.baseline.targetBG), g(r.changed.targetBG)],
    ['Sensitivity ratio', n(r.recorded.sensitivityRatio), n(r.baseline.sensitivityRatio), n(r.changed.sensitivityRatio)],
    ['ISF used', '–', r.baseline.variableSens == null ? '–' : g(r.baseline.variableSens), r.changed.variableSens == null ? '–' : g(r.changed.variableSens)],
    ['IOB (U)', '–', n(r.baseline.iob), n(r.changed.iob)],
    ['COB (g)', '–', n(r.baseline.cob, 0), n(r.changed.cob, 0)],
    ['Limits hit', '–', limitLabels(r.baseline.limits).join(', ') || 'none', limitLabels(r.changed.limits).join(', ') || 'none'],
  ];
  return rows;
}

const pct = (v) => (v == null ? '–' : v.toFixed(1));
const int = (v) => (v == null ? '–' : String(Math.round(v)));
const dec = (v, d = 1) => (v == null ? '–' : v.toFixed(d));

/**
 * The results of a period: [label, actual, simulated, band low k, band
 * high k] as text; the band only for glucose.
 */
export function periodRows (r, glucose) {
  const a = r.actual;
  const s = r.simulated;
  const lo = s.low;
  const hi = s.high;
  const g = (x) => (x == null ? '–' : glucose(x));
  const row = (label, f, band = true) => [label, f(a), f(s), band ? f(lo) : '', band ? f(hi) : ''];
  return [
    row('Mean glucose', (x) => g(x.mean)),
    row('Time in range 70–180 (%)', (x) => pct(x.ranges.target)),
    row('Time below 54 (%)', (x) => pct(x.ranges.veryLow)),
    row('Time 54–70 (%)', (x) => pct(x.ranges.low)),
    row('Time 180–250 (%)', (x) => pct(x.ranges.high)),
    row('Time above 250 (%)', (x) => pct(x.ranges.veryHigh)),
    row('Lows below 70 (count)', (x) => int(x.lows70)),
    row('Lows below 54 (count)', (x) => int(x.lows54)),
    row('Minutes below 70', (x) => int(x.minutesBelow70)),
    row('Highs above 250 (count)', (x) => int(x.highs250)),
    row('Total insulin (U)', (x) => dec(x.insulin?.total), false),
    row('Basal (U)', (x) => dec(x.insulin?.basal), false),
    row('SMB (U)', (x) => dec(x.insulin?.smb), false),
    row('SMB count', (x) => int(x.insulin?.smbCount), false),
    row('Largest SMB (U)', (x) => dec(x.insulin?.largestSmb, 2), false),
    ['Loop misses', String(r.misses.actual), String(r.misses.simulated), '', ''],
  ];
}

/** The page's address for a view: { mode: 'run', run } or { mode: 'period', from, to } (ms). */
export function viewQuery (v) {
  const q = new URLSearchParams();
  if (v.mode === 'run' && v.run) q.set('run', String(v.run));
  if (v.mode === 'period' && v.from && v.to) {
    q.set('from', String(v.from));
    q.set('to', String(v.to));
  }
  return q.toString();
}

/** The view in an address's query, or null. */
export function parseView (search) {
  const q = new URLSearchParams(search);
  const num = (k) => (q.has(k) && /^\d+$/.test(q.get(k)) ? Number(q.get(k)) : null);
  if (num('run')) return { mode: 'run', run: num('run') };
  if (num('from') && num('to') && num('from') < num('to')) return { mode: 'period', from: num('from'), to: num('to') };
  return null;
}

// The lengths a period can have, in hours (at most 14 days, src/oref/period.js MAX_PERIOD).
export const PERIOD_HOURS = [3, 6, 12, 24, 48, 168, 336];
export const periodLabel = (h) => (h <= 48 ? `${h}h` : `${h / 24}d`);

/** The period of `hours` ending at `to` (ms), not after `now`. */
export function periodEnding (to, hours, now = Date.now()) {
  const end = Math.min(to, now);
  return { from: end - hours * HOUR, to: end };
}

/** The period moved by half its length, earlier (-1) or later (+1), not after `now`. */
export function shiftPeriod ({ from, to }, direction, now = Date.now()) {
  const span = to - from;
  const end = Math.min(now, to + direction * span / 2);
  return { from: end - span, to: end };
}

const mmolOf = (v) => (v == null ? null : v / MGDL_PER_MMOL);

/**
 * The simulation of a period (POST /api/simulate/period) as the glucose
 * chart's overlay (glucosechart.js `sim`), glucose in mmol/L.
 */
export function simOverlay (r) {
  const s = r.series;
  const basal = [];
  for (const [t, rate] of s.simulatedBasal) {
    const last = basal[basal.length - 1];
    if (last && last.t1 === t && Math.abs(last.rate - rate) < 1e-9) last.t1 = t + 5 * MIN;
    else basal.push({ t0: t, t1: t + 5 * MIN, rate });
  }
  return {
    g: s.glucose.filter((p) => p[2] != null).map((p) => ({ t: p[0], v: mmolOf(p[2]) })),
    band: s.glucose.filter((p) => p[3] != null && p[4] != null).map((p) => ({ t: p[0], lo: mmolOf(p[3]), hi: mmolOf(p[4]) })),
    basal,
    smbs: s.simulatedSmbs.map(([t, v]) => ({ t, v })),
    runs: (s.runs || []).map((x) => ({
      t: x.t, bg: mmolOf(x.bg), eventual: mmolOf(x.eventual), target: mmolOf(x.target), isf: mmolOf(x.isf),
      iob: x.iob, cob: x.cob, insulinReq: x.insulinReq, smb: x.smb, rate: x.rate, duration: x.duration, reason: x.reason,
    })),
    windows: s.windows.slice(1),
  };
}

/** A run's predicted curves (mg/dL, as the API sends them) in mmol/L. */
export function predMmol (predBGs = {}) {
  return Object.fromEntries(Object.entries(predBGs).map(([k, v]) => [k, v.map(mmolOf)]));
}

/**
 * The loop's misses of a period, each list with what became of it: in
 * the actual list "gone" (not in the simulation) or "both"; in the
 * simulated list "new" (only there) or "both".
 */
export function missLists (misses) {
  const mark = (list, only) => (list || []).map((m) => ({ ...m, fate: m.both ? 'both' : only }));
  return { actual: mark(misses.actualList, 'gone'), simulated: mark(misses.simulatedList, 'new') };
}

