// Synthetic loop runs for checking the ported AAPS algorithms against AAPS
// itself (scripts/oref-cases.js): a seeded generator of determine_basal
// inputs in the shape of AAPS's Kotlin classes (OapsProfile,
// GlucoseStatusSMB, IobTotal, ...), how the port takes them, and the
// comparison of AAPS's result (RT as Kotlin's JSON writes it) with the
// port's.

import { determineBasal } from '../src/oref/determinebasal.js';

const MIN = 60000;
export const ALGORITHMS = ['SMB', 'DYN_ISF', 'AUTO_ISF'];
const LOOP_WANTED_SMB = ['AAPS', 'iobTH', 'blocked', 'fullLoop', 'enforced'];

/** A seeded random source (mulberry32) with the helpers the cases need. */
export function randomSource (seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    // a value rounded to `digits` decimals, as AAPS logs them
    num: (lo, hi, digits = 2) => Number(r.uniform(lo, hi).toFixed(digits)),
  };
  return r;
}

/** 48 IOB ticks, 5 minutes apart, decaying from iob0, as AAPS calculates them ahead. */
function iobTicks (r, now, { iob0, basal, lastBolusTime }) {
  const tau = r.uniform(50, 140);
  const zeroShare = r.uniform(0.2, 1);
  const ticks = [];
  for (let i = 0; i < 48; i++) {
    const t = i * 5;
    const iob = iob0 * Math.exp(-t / tau);
    const zeroIob = iob - basal * zeroShare * (t / 60) * Math.exp(-t / (2 * tau));
    const tick = (v, act) => ({
      time: now + t * MIN,
      iob: Number(v.toFixed(3)),
      activity: Number(act.toFixed(4)),
      bolussnooze: 0,
      basaliob: Number((v * r.uniform(0, 1)).toFixed(3)),
      lastBolusTime,
    });
    ticks.push({ ...tick(iob, iob / tau), iobWithZeroTemp: tick(zeroIob, zeroIob / tau - basal * zeroShare / 600) });
  }
  return ticks;
}

/** One random loop run for algorithm. */
export function generateCase (r, id, algorithm) {
  const now = Date.UTC(2026, 9, 1) + r.int(0, 30 * 24 * 60) * MIN + r.int(0, 59) * 1000;
  const mmol = r.chance(0.3);
  const basal = r.num(0.2, 2.5, 2);
  // glucose: mostly in the usual range, also near lows and the sensor's ends
  const bg = r.chance(0.1) ? r.pick([39, 40, 55, 65, 70, 75, 80, 300, 400]) : r.num(45, 330, 0);
  const delta = r.chance(0.1) ? r.pick([0, -0.1, 0.1]) : r.num(-15, 15, 2);
  const glucoseStatus = {
    glucose: bg,
    noise: r.chance(0.05) ? r.pick([1, 2, 3]) : 0,
    delta,
    shortAvgDelta: Number((delta + r.uniform(-3, 3)).toFixed(2)),
    longAvgDelta: Number((delta + r.uniform(-5, 5)).toFixed(2)),
    date: now - (r.chance(0.05) ? r.int(10, 20) : r.int(0, 4)) * MIN - r.int(0, 59) * 1000,
  };
  const sens = r.num(25, 150, 1);
  const tempTarget = r.chance(0.25);
  const target = tempTarget ? r.pick([72, 80, 90, 100, 120, 140, 150, 160]) : r.pick([90, 95, 99, 100, 105, 110, 120]);
  const minBg = tempTarget ? target : target - r.pick([0, 0, 5, 10]);
  const maxBg = tempTarget ? target : target + r.pick([0, 0, 5, 10]);
  const profile = {
    dia: 5,
    min_5m_carbimpact: 8,
    max_iob: r.chance(0.1) ? 0 : r.num(1, 12, 1),
    max_daily_basal: Number((basal * r.uniform(1, 1.5)).toFixed(2)),
    max_basal: r.num(0.5, 6, 1),
    min_bg: minBg,
    max_bg: maxBg,
    target_bg: target,
    carb_ratio: r.num(4, 25, 1),
    sens,
    autosens_adjust_targets: false,
    max_daily_safety_multiplier: r.pick([3, 4]),
    current_basal_safety_multiplier: r.pick([4, 5]),
    high_temptarget_raises_sensitivity: r.chance(0.5),
    low_temptarget_lowers_sensitivity: r.chance(0.5),
    sensitivity_raises_target: r.chance(0.5),
    resistance_lowers_target: r.chance(0.5),
    adv_target_adjustments: false,
    exercise_mode: r.chance(0.3),
    half_basal_exercise_target: r.pick([140, 160]),
    maxCOB: 120,
    skip_neutral_temps: r.chance(0.3),
    remainingCarbsCap: 90,
    enableUAM: r.chance(0.7),
    A52_risk_enable: false,
    SMBInterval: r.int(1, 10),
    enableSMB_with_COB: r.chance(0.6),
    enableSMB_with_temptarget: r.chance(0.5),
    allowSMB_with_high_temptarget: r.chance(0.5),
    enableSMB_always: r.chance(0.5),
    enableSMB_after_carbs: r.chance(0.5),
    maxSMBBasalMinutes: r.pick([15, 30, 45, 60, 90, 120]),
    maxUAMSMBBasalMinutes: r.pick([15, 30, 45, 60, 90, 120]),
    bolus_increment: r.pick([0.05, 0.1]),
    carbsReqThreshold: r.int(1, 10),
    current_basal: basal,
    temptargetSet: tempTarget,
    autosens_max: r.pick([1.2, 1.5]),
    out_units: mmol ? 'mmol/L' : 'mg/dL',
    lgsThreshold: algorithm === 'DYN_ISF' && r.chance(0.7) ? r.int(65, 90) : null,
    variable_sens: algorithm === 'SMB' ? 0 : Number((sens * r.uniform(0.5, 1.8)).toFixed(2)),
  };
  if (algorithm === 'AUTO_ISF') {
    Object.assign(profile, {
      autoISF_version: '3.0.1',
      enable_autoISF: r.chance(0.8),
      autoISF_max: r.pick([1.5, 2, 3]),
      autoISF_min: r.pick([0.5, 0.7, 1]),
      bgAccel_ISF_weight: r.num(0, 0.3, 2),
      bgBrake_ISF_weight: r.num(0, 0.3, 2),
      pp_ISF_weight: r.num(0, 0.3, 2),
      lower_ISFrange_weight: r.num(0, 2, 1),
      higher_ISFrange_weight: r.num(0, 2, 1),
      dura_ISF_weight: r.num(0, 2, 1),
      smb_delivery_ratio: r.num(0.3, 1, 2),
      smb_delivery_ratio_min: 0.5,
      smb_delivery_ratio_max: 0.9,
      smb_delivery_ratio_bg_range: r.pick([0, 40]),
      smb_max_range_extension: r.pick([1, 1.5, 2]),
      enableSMB_EvenOn_OddOff_always: r.chance(0.5),
      iob_threshold_percent: r.pick([100, 100, 60, 80, 120]),
      profile_percentage: r.pick([100, 100, 80, 120, 150]),
    });
  } else {
    Object.assign(profile, { insulinDivisor: r.pick([55, 65, 75]), TDD: r.num(15, 80, 1) });
  }
  const lastBolusTime = r.chance(0.2) ? 0 : now - r.int(1, 240) * MIN;
  const iob0 = r.chance(0.15) ? r.num(-2, 0, 3) : r.num(0, 9, 3);
  const carbs = r.chance(0.4) ? 0 : r.num(5, 120, 0);
  const meal = {
    carbs,
    mealCOB: carbs ? Number((carbs * r.uniform(0, 1)).toFixed(1)) : 0,
    slopeFromMaxDeviation: r.chance(0.3) ? 0 : r.num(-3, 0, 3),
    slopeFromMinDeviation: r.chance(0.3) ? 999 : r.num(0, 3, 3),
    lastBolusTime,
    lastCarbTime: carbs ? now - r.int(1, 300) * MIN : 0,
  };
  const c = {
    id,
    algorithm,
    glucoseStatus,
    currentTemp: r.chance(0.3)
      ? { duration: 0, rate: 0, minutesrunning: null }
      : { duration: r.int(1, 120), rate: r.num(0, 4, 2), minutesrunning: null },
    iob: iobTicks(r, now, { iob0, basal, lastBolusTime }),
    profile,
    autosens: { ratio: r.chance(0.4) ? 1 : r.num(0.7, 1.3, 2) },
    meal,
    microBolusAllowed: r.chance(0.9),
    currentTime: now,
    flatBGsDetected: r.chance(0.03),
  };
  if (algorithm === 'AUTO_ISF') {
    // glucose status fields AutoISF adds; determine_basal reads only some
    Object.assign(glucoseStatus, {
      duraISFminutes: r.num(0, 120, 1),
      duraISFaverage: r.num(70, 250, 1),
      parabolaMinutes: r.num(0, 45, 1),
      deltaPl: r.num(-10, 10, 2),
      deltaPn: r.num(-10, 10, 2),
      bgAcceleration: r.num(-3, 3, 2),
      a0: bg,
      a1: r.num(-10, 10, 2),
      a2: r.num(-1, 1, 3),
      corrSqu: r.num(0.5, 1, 3),
    });
    c.autoIsf = {
      loop_wanted_smb: r.pick(LOOP_WANTED_SMB),
      smb_ratio: profile.smb_delivery_ratio,
      iob_threshold_percent: profile.iob_threshold_percent,
    };
  }
  return c;
}

/** A case as the port's determineBasal takes it. */
export function portInput (c) {
  const input = {
    glucose_status: c.glucoseStatus,
    currenttemp: { duration: c.currentTemp.duration, rate: c.currentTemp.rate },
    iob_data_array: c.iob,
    profile: { ...c.profile },
    autosens_data: { ratio: c.autosens.ratio },
    meal_data: c.meal,
    microBolusAllowed: c.microBolusAllowed,
    currentTime: c.currentTime,
    flatBGsDetected: c.flatBGsDetected,
    dynIsfMode: c.algorithm === 'DYN_ISF',
    // AAPS runs the cases in UTC (TZ=UTC)
    minuteOf: (t) => new Date(t).getUTCMinutes(),
  };
  if (c.algorithm === 'AUTO_ISF') {
    Object.assign(input, {
      autoIsfMode: true,
      loop_wanted_smb: c.autoIsf.loop_wanted_smb,
      profile_percentage: c.profile.profile_percentage,
      smb_ratio: c.autoIsf.smb_ratio,
      smb_max_range_extension: c.profile.smb_max_range_extension,
      iob_threshold_percent: c.autoIsf.iob_threshold_percent,
      auto_isf_consoleError: [],
      auto_isf_consoleLog: [],
    });
  }
  return input;
}

// The fields compared, as test/oref.test.js compares the AAPS fixtures, and the reason.
const FIELDS = ['tick', 'eventualBG', 'targetBG', 'insulinReq', 'carbsReq', 'carbsReqWithin', 'units',
  'sensitivityRatio', 'duration', 'rate', 'COB', 'IOB', 'variable_sens'];
const CURVES = ['IOB', 'ZT', 'COB', 'UAM'];

function comparable (field, value) {
  if (['carbsReq', 'carbsReqWithin', 'duration'].includes(field)) return value ?? 0;
  if (field === 'tick') return String(value ?? '');
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value ?? null;
}

/** The differences between AAPS's result and the port's: [{ field, aaps, port }]. */
export function differences (aaps, port) {
  const out = [];
  for (const f of FIELDS) {
    const a = comparable(f, aaps[f]);
    const p = comparable(f, port[f]);
    if (a !== p) out.push({ field: f, aaps: a, port: p });
  }
  for (const curve of CURVES) {
    const a = aaps.predBGs?.[curve];
    const p = port.predBGs?.[curve];
    if (JSON.stringify(a ?? null) !== JSON.stringify(p ?? null)) out.push({ field: `predBGs.${curve}`, aaps: a ?? null, port: p ?? null });
  }
  if (String(aaps.reason ?? '') !== String(port.reason ?? '')) out.push({ field: 'reason', aaps: aaps.reason, port: String(port.reason) });
  return out;
}

// Kotlin's JSON writes NaN and Infinity bare.
export const parseKotlin = (line) => JSON.parse(line.replace(/:(-?)(NaN|Infinity)\b/g, (m, sign, w) => `:"${sign}${w}"`));
const numeric = (v) => (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v);
export function fromKotlin (rt) {
  for (const f of FIELDS) if (typeof rt[f] === 'string' && f !== 'tick') rt[f] = numeric(rt[f]);
  return rt;
}


/** The first n cases of seed: algorithms in turn, ids `${seed}-${i}`. */
export function generateCases (seed, n) {
  const r = randomSource(seed);
  return Array.from({ length: n }, (_, i) => generateCase(r, `${seed}-${i}`, ALGORITHMS[i % ALGORITHMS.length]));
}

/** The port's decision for a case. */
export const portDecision = (c) => determineBasal(portInput(c), { autoIsf: c.algorithm === 'AUTO_ISF' });
