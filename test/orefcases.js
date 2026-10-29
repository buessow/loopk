// The AAPS conformance cases in test/fixtures/oref (AndroidAPS, AGPL-3.0:
// app/src/androidTest/assets/results): inputs logged by AAPS and the
// output of its JavaScript oref1, read as AAPS's ReplayApsResultsTest
// passes them to the Kotlin port.
import { readdirSync, readFileSync } from 'node:fs';
import { autoISF } from '../src/oref/autoisf.js';

const DIR = new URL('./fixtures/oref/', import.meta.url);

// AAPS's preference defaults (core/keys IntKey, DoubleKey).
const IOB_THRESHOLD_PERCENT = 100;
const SMB_MAX_RANGE_EXTENSION = 1.0;

function toIob (o) {
  return {
    iob: o.iob,
    basaliob: o.basaliob,
    activity: o.activity,
    lastBolusTime: o.lastBolusTime,
    time: Date.parse(o.time),
    iobWithZeroTemp: o.iobWithZeroTemp ? toIob(o.iobWithZeroTemp) : null,
  };
}

/** AutoISF's ISF from a case's profile and glucose status. */
export function autoIsfSens (raw) {
  const p = raw.profile;
  const g = raw.glucoseStatus;
  return autoISF({
    sens: p.sens,
    target_bg: p.target_bg,
    isTempTarget: p.temptargetSet,
    autosensRatio: raw.autosens_data.ratio,
    units: p.out_units,
    glucose_status: {
      glucose: g.glucose,
      delta: g.delta,
      shortAvgDelta: g.short_avgdelta,
      duraISFminutes: g.dura_ISF_minutes,
      duraISFaverage: g.dura_ISF_average,
      a0: g.parabola_fit_a0,
      a1: g.parabola_fit_a1,
      a2: g.parabola_fit_a2,
      bgAcceleration: g.bg_acceleration,
      corrSqu: g.parabola_fit_correlation,
      parabolaMinutes: g.parabola_fit_minutes,
    },
    settings: {
      autoIsfWeights: p.enable_autoISF,
      autoISF_max: p.autoISF_max,
      autoISF_min: p.autoISF_min,
      bgAccel_ISF_weight: p.bgAccel_ISF_weight,
      bgBrake_ISF_weight: p.bgBrake_ISF_weight,
      pp_ISF_weight: p.pp_ISF_weight,
      lower_ISFrange_weight: p.lower_ISFrange_weight,
      higher_ISFrange_weight: p.higher_ISFrange_weight,
      dura_ISF_weight: p.dura_ISF_weight,
      exerciseMode: p.exercise_mode,
      highTemptargetRaisesSensitivity: p.high_temptarget_raises_sensitivity,
      lowTemptargetLowersSensitivity: p.low_temptarget_lowers_sensitivity,
      halfBasalTarget: p.half_basal_exercise_target,
      autosensMax: p.autosens_max,
    },
  });
}

/** [{ file, algorithm, autoIsf, input (for determineBasal), output }], AMA left out. */
export function orefCases () {
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((file) => {
    const doc = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
    const raw = typeof doc.input === 'string' ? JSON.parse(doc.input) : doc.input;
    const output = typeof doc.output === 'string' ? JSON.parse(doc.output) : doc.output;
    return { file, algorithm: doc.algorithm, raw, output };
  }).filter((c) => c.algorithm !== 'OpenAPSAMAPlugin').map(({ file, algorithm, raw, output }) => {
    const autoIsf = algorithm === 'OpenAPSSMBAutoISFPlugin';
    const dyn = algorithm === 'OpenAPSSMBDynamicISFPlugin';
    const gs = raw.glucoseStatus;
    const profile = { ...raw.profile };
    if (!dyn) profile.lgsThreshold = null;
    // Older cases have no variable_sens in the output: the ported autoISF()
    // gives it (it matches every case that has one).
    if (autoIsf) profile.variable_sens = output.variable_sens ?? autoIsfSens(raw);
    const input = {
      glucose_status: {
        glucose: gs.glucose,
        noise: gs.noise,
        delta: gs.delta,
        shortAvgDelta: gs.short_avgdelta,
        longAvgDelta: gs.long_avgdelta,
        date: gs.date,
      },
      currenttemp: { duration: raw.currenttemp.duration, rate: raw.currenttemp.rate },
      iob_data_array: raw.iob_data.map(toIob),
      profile,
      autosens_data: { ratio: raw.autosens_data.ratio },
      meal_data: raw.meal_data,
      microBolusAllowed: raw.microBolusAllowed,
      currentTime: raw.currentTime,
      flatBGsDetected: raw.flatBGsDetected,
      dynIsfMode: dyn,
    };
    if (autoIsf) {
      Object.assign(input, {
        autoIsfMode: true,
        iob_threshold_percent: IOB_THRESHOLD_PERCENT,
        smb_max_range_extension: SMB_MAX_RANGE_EXTENSION,
        profile_percentage: profile.profile_percentage,
        smb_ratio: profile.smb_delivery_ratio,
        loop_wanted_smb: 'dummy',
        auto_isf_consoleLog: ['end AutoISF'],
        auto_isf_consoleError: ['start AutoISF'],
      });
    }
    return { file, algorithm, autoIsf, dyn, raw, input, output };
  });
}
