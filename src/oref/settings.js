// The loop settings a replay needs. AAPS uploads few of them, so each value
// comes from the first of: the settings entered in loopk (loop_settings),
// the device status configuration, what the loop's reason texts and console
// logs show, and AAPS's defaults. Every value carries where it came from.
//
// Defaults from AndroidAPS (AGPL-3.0), commit 423a4502f2: core/keys
// (BooleanKey, IntKey, DoubleKey, UnitDoubleKey) and SMBDefaults.

import { tempTargetAt } from './inputs.js';

/** AAPS's preference defaults, by the names the ported code uses. */
export const DEFAULTS = {
  max_iob: 3.0,
  max_basal: 1.0,
  max_daily_safety_multiplier: 3.0,
  current_basal_safety_multiplier: 4.0,
  lgsThreshold: null, // mg/dL; only shows in the log when it raises the threshold
  sensitivity_raises_target: true,
  resistance_lowers_target: false,
  adv_target_adjustments: false,
  exercise_mode: false,
  half_basal_exercise_target: 160,
  maxCOB: 120,
  remainingCarbsCap: 90,
  enableUAM: true,
  A52_risk_enable: false,
  SMBInterval: 3,
  enableSMB_with_COB: false,
  enableSMB_with_temptarget: false,
  allowSMB_with_high_temptarget: false,
  enableSMB_always: false,
  enableSMB_after_carbs: false,
  maxSMBBasalMinutes: 30,
  maxUAMSMBBasalMinutes: 30,
  bolus_increment: 0.05,
  carbsReqThreshold: 1,
  skip_neutral_temps: false,
  autosens: true,
  autosensMin: 0.7,
  autosensMax: 1.2,
  min5mCarbImpact: 8.0,
  absorptionCutoff: 6.0,
  insulinPeak: 75,
  snoozeDivisor: 2.0,
  // Dynamic ISF
  dynIsfAdjustmentFactor: 100,
  dynIsfAdjustSensitivity: false,
  // AutoISF
  autoIsfWeights: false,
  autoISF_max: 1.0,
  autoISF_min: 1.0,
  bgAccel_ISF_weight: 0.0,
  bgBrake_ISF_weight: 0.0,
  pp_ISF_weight: 0.0,
  lower_ISFrange_weight: 0.0,
  higher_ISFrange_weight: 0.0,
  dura_ISF_weight: 0.0,
  smb_delivery_ratio: 0.5,
  smb_delivery_ratio_min: 0.5,
  smb_delivery_ratio_max: 0.5,
  smb_delivery_ratio_bg_range: 0.0,
  smb_max_range_extension: 1.0,
  enableSMB_EvenOn_OddOff_always: false,
  iob_threshold_percent: 100,
  highTemptargetRaisesSensitivity: false,
  lowTemptargetLowersSensitivity: false,
};

const INSULIN_PEAK = { 2: 75, 3: 55, 5: 45 };
const MMOL = 18.0;

/**
 * Settings from a devicestatus configuration row ({ insulin, aps_settings,
 * sensitivity_settings }) and from runs ({ timestamp, reason, console:
 * [lines], units }). `tempTargets` ([{ timestamp, duration, low, high }],
 * sorted) shows when SMBs ran under a high temp target. Returns { values,
 * sources }.
 */
export function inferSettings (config, runs = [], { tempTargets = [] } = {}) {
  const values = { ...DEFAULTS };
  const sources = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, 'default']));
  const set = (key, value, source) => {
    if (value == null || Number.isNaN(value)) return;
    values[key] = value;
    sources[key] = source;
  };

  if (config) {
    set('insulinPeak', INSULIN_PEAK[config.insulin], 'configuration');
    const s = config.sensitivity_settings || {};
    set('autosensMin', round2(s.autosens_min), 'configuration');
    set('autosensMax', round2(s.autosens_max), 'configuration');
    set('absorptionCutoff', s.absorption_cutoff, 'configuration');
    set('min5mCarbImpact', s.openaps_smb_min_5m_carbimpact, 'configuration');
    const a = config.aps_settings || {};
    set('dynIsfAdjustmentFactor', a.DynISFAdjust, 'configuration');
  }

  // The most common value a pattern shows in the runs.
  const mode = (pattern, text = (r) => r.console.join('\n')) => {
    const counts = new Map();
    for (const r of runs) {
      const m = pattern.exec(text(r) || '');
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    let best = null;
    for (const [v, n] of counts) if (best == null || n > counts.get(best)) best = v;
    return best;
  };
  const num = (v) => (v == null ? null : Number(v));
  set('maxSMBBasalMinutes', num(mode(/profile\.maxSMBBasalMinutes: (\d+)/)), 'console');
  set('maxUAMSMBBasalMinutes', num(mode(/profile\.maxUAMSMBBasalMinutes: (\d+)/)), 'console');
  const threshold = mode(/Threshold set from [\d.]+ to ([\d.]+)/);
  if (threshold != null) {
    const mmol = runs.some((r) => r.units === 'mmol/L') || Number(threshold) < 30;
    set('lgsThreshold', Math.trunc(Number(threshold) * (mmol ? MMOL : 1)), 'console');
  }
  // max IOB: the largest limit a reason names (0 is the duplicate-reading limit).
  const iobs = runs.map((r) => /max_iob ([\d.]+)/.exec(r.reason || '')?.[1]).filter((v) => v != null).map(Number).filter((v) => v > 0);
  if (iobs.length) set('max_iob', Math.max(...iobs), 'reason');
  // max basal: at least the largest safe basal a reason names.
  const safe = runs.map((r) => /maxSafeBasal: ([\d.]+)/.exec(r.reason || '')?.[1]).filter((v) => v != null).map(Number);
  if (safe.length) set('max_basal', Math.max(...safe), 'reason (lower bound)');
  if (runs.some((r) => r.console.includes('SMB enabled due to enableSMB_always'))) set('enableSMB_always', true, 'console');
  // SMB with a high temp target: disabled says so, enabled shows as SMB running under one
  const highTarget = (r) => {
    const tt = r.timestamp != null && tempTargetAt(tempTargets, r.timestamp);
    return tt && (tt.low + tt.high) / 2 > 100;
  };
  if (runs.some((r) => r.console.some((l) => l.startsWith('SMB disabled due to high temptarget')))) {
    set('allowSMB_with_high_temptarget', false, 'console');
  } else if (runs.some((r) => highTarget(r) && r.console.some((l) => l.startsWith('SMB enabled')))) {
    set('allowSMB_with_high_temptarget', true, 'console');
  }
  if (runs.some((r) => r.console.some((l) => l.startsWith(' minUAMPredBG')))) set('enableUAM', true, 'console');
  if (runs.some((r) => r.console.some((l) => l.startsWith('Setting neutral temp basal')))) set('skip_neutral_temps', false, 'console');
  // SMB interval: minutes since the last bolus plus the wait the reason gives.
  const intervals = [];
  for (const r of runs) {
    const wait = /Waiting (\d+)m (\d+)s to microbolus again/.exec(r.reason || '');
    const age = r.console.map((l) => /last bolus ([\d.E-]+)m ago/.exec(l)?.[1]).find((v) => v != null);
    if (wait && age != null) intervals.push(Math.round(Number(age) + Number(wait[1]) + Number(wait[2]) / 60));
  }
  if (intervals.length) set('SMBInterval', modeOf(intervals), 'reason');
  // AutoISF
  const ratio = mode(/SMB delivery ratio set to fixed value ([\d.]+)/);
  if (ratio != null) {
    set('smb_delivery_ratio', Number(ratio), 'console');
    set('smb_delivery_ratio_bg_range', 0, 'console');
  }
  if (runs.some((r) => r.console.includes('autoISF weights disabled in Preferences'))) set('autoIsfWeights', false, 'console');
  if (runs.some((r) => r.console.some((l) => /User setting iobTH=100% disables/.test(l)))) set('iob_threshold_percent', 100, 'console');
  if (runs.some((r) => r.console.includes('Loop allows AAPS power level'))) set('enableSMB_EvenOn_OddOff_always', false, 'console');
  // autosens moving the target: up when sensitive, down when resistant
  const targetMoves = runs.flatMap((r) => r.console.map((l) => /^ ?target_bg from ([\d.]+) to ([\d.]+)/.exec(l)).filter(Boolean));
  if (targetMoves.some((m) => Number(m[2]) > Number(m[1]))) set('sensitivity_raises_target', true, 'console');
  if (targetMoves.some((m) => Number(m[2]) < Number(m[1]))) set('resistance_lowers_target', true, 'console');
  // Dynamic ISF: the TDD-based autosens ratio shows as a ratio other than the Oref1 plugin's steps.
  if (runs.some((r) => r.dynamicIsf && r.sensitivityRatio != null && Math.abs(r.sensitivityRatio * 100 - Math.round(r.sensitivityRatio * 100)) > 1e-6)) {
    set('dynIsfAdjustSensitivity', true, 'sensitivity ratio');
  }
  return { values, sources };
}

function round2 (v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

function modeOf (list) {
  const counts = new Map();
  for (const v of list) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

const LIMIT_DAYS = 90;

// AAPS's preference keys (core/keys: DoubleKey, IntKey, BooleanKey,
// UnitDoubleKey) for the settings above.
const AAPS_PREFERENCES = {
  max_iob: 'openapsmb_max_iob',
  max_basal: 'openapsma_max_basal',
  max_daily_safety_multiplier: 'openapsama_max_daily_safety_multiplier',
  current_basal_safety_multiplier: 'openapsama_current_basal_safety_multiplier',
  lgsThreshold: 'lgsThreshold',
  sensitivity_raises_target: 'sensitivity_raises_target',
  resistance_lowers_target: 'resistance_lowers_target',
  half_basal_exercise_target: 'half_basal_exercise_target',
  enableUAM: 'use_uam',
  SMBInterval: 'smbinterval',
  enableSMB_with_COB: 'enableSMB_with_COB',
  enableSMB_with_temptarget: 'enableSMB_with_temptarget',
  allowSMB_with_high_temptarget: 'enableSMB_with_high_temptarget',
  enableSMB_always: 'enableSMB_always',
  enableSMB_after_carbs: 'enableSMB_after_carbs',
  maxSMBBasalMinutes: 'smbmaxminutes',
  maxUAMSMBBasalMinutes: 'uamsmbmaxminutes',
  carbsReqThreshold: 'carbsReqThreshold',
  autosens: 'openapsama_useautosens',
  autosensMin: 'autosens_min',
  autosensMax: 'autosens_max',
  min5mCarbImpact: 'openaps_smb_min_5m_carbimpact',
  absorptionCutoff: 'absorption_cutoff',
  dynIsfAdjustmentFactor: 'DynISFAdjust',
  dynIsfAdjustSensitivity: 'dynisf_adjust_sensitivity',
  autoIsfWeights: 'openapsama_enable_autoISF',
  autoISF_max: 'autoISF_max',
  autoISF_min: 'autoISF_min',
  bgAccel_ISF_weight: 'bgAccel_ISF_weight',
  bgBrake_ISF_weight: 'bgBrake_ISF_weight',
  pp_ISF_weight: 'pp_ISF_weight',
  lower_ISFrange_weight: 'lower_ISFrange_weight',
  higher_ISFrange_weight: 'higher_ISFrange_weight',
  dura_ISF_weight: 'dura_ISF_weight',
  smb_delivery_ratio: 'openapsama_smb_delivery_ratio',
  smb_delivery_ratio_min: 'openapsama_smb_delivery_ratio_min',
  smb_delivery_ratio_max: 'openapsama_smb_delivery_ratio_max',
  smb_delivery_ratio_bg_range: 'openapsama_smb_delivery_ratio_bg_range',
  smb_max_range_extension: 'openapsama_smb_max_range_extension',
  enableSMB_EvenOn_OddOff_always: 'Enable alternative activation of SMB always',
  iob_threshold_percent: 'iob_threshold_percent',
  highTemptargetRaisesSensitivity: 'high_temptarget_raises_sensitivity',
  lowTemptargetLowersSensitivity: 'low_temptarget_lowers_sensitivity',
};

/**
 * The settings in AAPS's preferences (`prefs`: { key: value }, values as
 * strings or typed, e.g. from shared_prefs XML or a settings export) as the
 * algorithm gets them. SMB always and SMB after carbs need a glucose source
 * with advanced filtering (Dexcom, Libre 2 and the like); without it AAPS
 * passes them as false. Settings not in `prefs` are left out.
 */
export function fromAapsPreferences (prefs, { advancedFiltering = true } = {}) {
  const out = {};
  for (const [key, pref] of Object.entries(AAPS_PREFERENCES)) {
    const raw = prefs[pref];
    if (raw == null || raw === '') continue;
    const d = DEFAULTS[key];
    let value;
    if (typeof d === 'boolean') value = raw === true || raw === 'true';
    else value = Number(raw);
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    // a glucose in the user's units (UnitDoubleKey), to whole mg/dL as AAPS does
    if (key === 'lgsThreshold') value = Math.trunc(value < 39 ? value * MMOL : value);
    out[key] = value;
  }
  if (!advancedFiltering) {
    if ('enableSMB_always' in out) out.enableSMB_always = false;
    if ('enableSMB_after_carbs' in out) out.enableSMB_after_carbs = false;
  }
  return out;
}

/** Whether `value` fits setting `key`: the type of its default (numbers may also be null where the default is). */
/** Settings that must be above 0 (steps and times the code divides by). */
export const POSITIVE_SETTINGS = new Set(['bolus_increment', 'insulinPeak', 'absorptionCutoff']);

export function validSetting (key, value) {
  if (!Object.hasOwn(DEFAULTS, key)) return false;
  const d = DEFAULTS[key];
  if (value === null) return d === null;
  if (typeof d === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value) && (!POSITIVE_SETTINGS.has(key) || value > 0);
}

/** The settings entered in loopk that hold at `at` (ms): { key: value }. */
export async function storedSettings (data, at) {
  const rows = await data.loopSettings.at(at);
  return Object.fromEntries(rows.filter((r) => validSetting(r.setting, r.value)).map((r) => [r.setting, r.value]));
}

/** Stores `values` ({ key: value }) as holding from `validFrom` (ms). */
export async function saveSettings (data, values, { validFrom, by = null }) {
  for (const [key, value] of Object.entries(values)) {
    if (!validSetting(key, value)) throw new Error(`Not a loop setting value: ${key} = ${JSON.stringify(value)}`);
  }
  for (const [key, value] of Object.entries(values)) {
    await data.loopSettings.save(key, value, validFrom, by);
  }
}

/**
 * The settings at `to` (ms): from loop_settings, the configuration, `runs`
 * (loadRuns, the recent ones), the limits reasons named in the 90 days
 * before and AAPS's defaults. Returns { values, sources }.
 */
export async function loadSettings (data, { to, runs = [], tempTargets = [], entered = true }) {
  const [config, limits, stored] = await Promise.all([
    data.loop.configuration(to),
    data.loop.limitReasons(to - LIMIT_DAYS * 24 * 3600000, to),
    entered ? storedSettings(data, to) : {},
  ]);
  const settings = inferSettings(config, [...runs, ...limits.map((r) => ({ reason: r.reason, console: [] }))], { tempTargets });
  return withEntered(settings, stored);
}

function withEntered (settings, stored) {
  const out = { values: { ...settings.values }, sources: { ...settings.sources } };
  for (const [key, value] of Object.entries(stored)) {
    out.values[key] = value;
    out.sources[key] = 'entered';
  }
  return out;
}

/**
 * The settings over [from, to] (ms): inferred as loadSettings does, with
 * the entered ones that hold at each time. Returns { at(t): { values,
 * sources }, last: the settings at `to` }.
 */
export async function loadSettingsTimeline (data, { from, to, runs = [], tempTargets = [] }) {
  const inferred = await loadSettings(data, { to, runs, tempTargets, entered: false });
  const starts = [from, ...await data.loopSettings.changes(from, to)];
  const segments = [];
  for (const start of starts) segments.push({ start, settings: withEntered(inferred, await storedSettings(data, start)) });
  return {
    at (t) {
      let s = segments[0];
      for (const seg of segments) if (seg.start <= t) s = seg;
      return s.settings;
    },
    last: segments.at(-1).settings,
  };
}
