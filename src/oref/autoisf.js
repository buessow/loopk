// AutoISF 3: the ISF that AAPS's AutoISF plugin hands to determine_basal
// (profile.variable_sens), its decision on who controls SMBs and the SMB
// delivery ratio.
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// plugins/aps/src/main/kotlin/app/aaps/plugins/aps/openAPSAutoISF/OpenAPSAutoISFPlugin.kt
// (autoISF, interpolate, withinISFlimits, loop_smb, determine_varSMBratio and
// the iobTH part of invoke). The plugin reads preferences; here they come in
// as `settings`:
// - autoIsfWeights, autoISF_max, autoISF_min, bgAccel_ISF_weight,
//   bgBrake_ISF_weight, pp_ISF_weight, lower_ISFrange_weight,
//   higher_ISFrange_weight, dura_ISF_weight
// - smb_delivery_ratio, smb_delivery_ratio_min, smb_delivery_ratio_max,
//   smb_delivery_ratio_bg_range, enableSMB_EvenOn_OddOff_always,
//   iob_threshold_percent
// - exerciseMode, highTemptargetRaisesSensitivity,
//   lowTemptargetLowersSensitivity, halfBasalTarget, autosensMax

import { NORMAL_TARGET_MGDL } from './determinebasal.js';
import { MGDL_TO_MMOLL, convertBg, kd, round } from './format.js';

const normalTarget = NORMAL_TARGET_MGDL;

/** ISF factor from glucose: a polygon over glucose, scaled by the low and high range weights. */
export function interpolate (xdata, settings) {
  const polyX = [50.0, 60.0, 80.0, 90.0, 100.0, 110.0, 150.0, 180.0, 200.0];
  const polyY = [-0.5, -0.5, -0.3, -0.2, 0.0, 0.0, 0.5, 0.7, 0.7];
  const polymax = polyX.length - 1;
  let step = polyX[0];
  let sVal = polyY[0];
  let stepT = polyX[polymax];
  let sValold = polyY[polymax];

  let newVal = 1.0;
  let lowVal = 1.0;
  let lowLabl = step;

  if (step > xdata) {
    // extrapolate backwards
    stepT = polyX[1];
    sValold = polyY[1];
    lowVal = sVal;
    newVal = lowVal + (sValold - lowVal) / (stepT - step) * (xdata - step);
  } else if (stepT < xdata) {
    // extrapolate forwards
    step = polyX[polymax - 1];
    sVal = polyY[polymax - 1];
    lowVal = sVal;
    newVal = lowVal + (sValold - lowVal) / (stepT - step) * (xdata - step);
  } else {
    // interpolate
    for (let i = 0; i <= polymax; i++) {
      step = polyX[i];
      sVal = polyY[i];
      if (step === xdata) {
        newVal = sVal;
        break;
      } else if (step > xdata) {
        newVal = lowVal + (sVal - lowVal) / (step - lowLabl) * (xdata - lowLabl);
        break;
      }
      lowVal = sVal;
      lowLabl = step;
    }
  }
  return xdata > 100 ? newVal * settings.higher_ISFrange_weight : newVal * settings.lower_ISFrange_weight;
}

function withinISFlimits (liftISF, minISFReduction, maxISFReduction, sensitivityRatio, origin_sens, temptargetSet,
  high_temptarget_raises_sensitivity, target_bg, consoleError) {
  let liftISFlimited = liftISF;
  if (liftISF < minISFReduction) {
    consoleError.push(`weakest autoISF factor ${kd(round(liftISF, 2))} limited by autoISF_min ${kd(minISFReduction)}`);
    liftISFlimited = minISFReduction;
  } else if (liftISF > maxISFReduction) {
    consoleError.push(`strongest autoISF factor ${kd(round(liftISF, 2))} limited by autoISF_max ${kd(maxISFReduction)}`);
    liftISFlimited = maxISFReduction;
  }
  let finalISF;
  let originSensFinal = origin_sens;
  if (high_temptarget_raises_sensitivity && temptargetSet && target_bg > normalTarget) {
    finalISF = liftISFlimited * sensitivityRatio;
    originSensFinal = ' including exercise mode impact';
  } else if (liftISFlimited >= 1) {
    finalISF = Math.max(liftISFlimited, sensitivityRatio);
    originSensFinal = liftISFlimited >= sensitivityRatio ? '' : 'from low TT modifier';
  } else {
    finalISF = Math.min(liftISFlimited, sensitivityRatio);
    if (liftISFlimited <= sensitivityRatio) originSensFinal = ''; // low TT lowers sensitivity dominates
  }
  consoleError.push(`final ISF factor is ${kd(round(finalISF, 2))} ` + originSensFinal);
  consoleError.push('----------------------------------');
  consoleError.push('end AutoISF');
  consoleError.push('----------------------------------');
  return finalISF;
}

/**
 * The AutoISF sensitivity (mg/dL/U). `sens`: the profile ISF in mg/dL;
 * `target_bg`: the profile target, or the temp target's when `isTempTarget`;
 * `autosensRatio`: autosens (1 when off); `glucose_status`: as
 * glucoseStatusAutoIsf. Log lines go to `consoleError`.
 */
export function autoISF ({ sens, glucose_status, target_bg, isTempTarget, autosensRatio = 1.0, units, settings, consoleError = [] }) {
  const high_temptarget_raises_sensitivity = settings.exerciseMode || settings.highTemptargetRaisesSensitivity;
  let sensitivityRatio;
  let origin_sens = '';
  if ((high_temptarget_raises_sensitivity && isTempTarget && target_bg > normalTarget) ||
      (settings.lowTemptargetLowersSensitivity && isTempTarget && target_bg < normalTarget)) {
    const c = settings.halfBasalTarget - normalTarget;
    if (c * (c + target_bg - normalTarget) <= 0.0) {
      sensitivityRatio = settings.autosensMax;
    } else {
      sensitivityRatio = c / (c + target_bg - normalTarget);
      sensitivityRatio = Math.min(sensitivityRatio, settings.autosensMax);
      sensitivityRatio = round(sensitivityRatio, 2);
      origin_sens = ' from low TT modifier';
    }
  } else {
    sensitivityRatio = autosensRatio;
  }
  if (!settings.autoIsfWeights || glucose_status == null) {
    consoleError.push('autoISF weights disabled in Preferences');
    consoleError.push('----------------------------------');
    consoleError.push('end AutoISF');
    consoleError.push('----------------------------------');
    return round(sens / sensitivityRatio, 1);
  }

  const dura05 = glucose_status.duraISFminutes;
  const avg05 = glucose_status.duraISFaverage;
  const maxISFReduction = settings.autoISF_max;
  let sens_modified = false;
  let pp_ISF = 1.0;
  let acce_ISF = 1.0;
  let acce_weight = 1.0;
  const bg_off = target_bg + 10.0 - glucose_status.glucose; // move from central BG=100 to target+10 as virtual BG'=100

  // calculate acce_ISF from bg acceleration and adapt ISF accordingly
  const fit_corr = glucose_status.corrSqu;
  const bg_acce = glucose_status.bgAcceleration;
  consoleError.push(`Parabola fit results were acceleration:${kd(round(bg_acce, 2))}, correlation:${kd(fit_corr)}, duration:${kd(glucose_status.parabolaMinutes)}m`);
  if (glucose_status.a2 !== 0.0 && fit_corr >= 0.9) {
    let minmax_delta = -glucose_status.a1 / 2 / glucose_status.a2 * 5; // back from 5min block to 1 min
    const minmax_value = round(glucose_status.a0 - minmax_delta * minmax_delta / 25 * glucose_status.a2, 1);
    minmax_delta = round(minmax_delta, 1);
    if (minmax_delta > 0 && bg_acce < 0) {
      consoleError.push(`Parabolic fit extrapolates a maximum of ${convertBg(minmax_value, units)} in about ${kd(minmax_delta)} minutes`);
    } else if (minmax_delta > 0 && bg_acce > 0.0) {
      consoleError.push(`Parabolic fit extrapolates a minimum of ${convertBg(minmax_value, units)} in about ${kd(minmax_delta)} minutes`);
      if (minmax_delta <= 30 && minmax_value < target_bg) { // start braking
        acce_weight = -settings.bgBrake_ISF_weight;
        consoleError.push('extrapolation below target soon: use bgBrake_ISF_weight instead');
      }
    }
  }
  if (fit_corr < 0.9) {
    consoleError.push(`acce_ISF adaptation by-passed as correlation ${kd(round(fit_corr, 3))} is too low`);
  } else {
    const fit_share = 10 * (fit_corr - 0.9); // 0 at correlation 0.9, 1 at 1.00
    let cap_weight = 1.0; // full contribution above target
    if (acce_weight === 1.0 && glucose_status.glucose < target_bg) { // below target acce goes towards target
      if (bg_acce > 0) {
        if (bg_acce > 1) cap_weight = 0.5; // halve the effect below target
        acce_weight = settings.bgBrake_ISF_weight;
      } else if (bg_acce < 0) {
        acce_weight = settings.bgAccel_ISF_weight;
      }
    } else if (acce_weight === 1.0) { // above target acce goes away from target
      if (bg_acce < 0.0) acce_weight = settings.bgBrake_ISF_weight;
      else if (bg_acce > 0.0) acce_weight = settings.bgAccel_ISF_weight;
    }
    acce_ISF = 1.0 + bg_acce * cap_weight * acce_weight * fit_share;
    consoleError.push(`acce_ISF adaptation is ${kd(round(acce_ISF, 2))}`);
    if (acce_ISF !== 1.0) sens_modified = true;
  }

  const bg_ISF = 1 + interpolate(100 - bg_off, settings);
  consoleError.push(`bg_ISF adaptation is ${kd(round(bg_ISF, 2))}`);
  let liftISF;
  let final_ISF;
  if (bg_ISF < 1.0) {
    liftISF = Math.min(bg_ISF, acce_ISF);
    if (acce_ISF > 1.0) {
      liftISF = bg_ISF * acce_ISF; // bg_ISF could become > 1 now
      consoleError.push(`bg_ISF adaptation lifted to ${kd(round(liftISF, 2))} as bg accelerates already`);
    }
    final_ISF = withinISFlimits(liftISF, settings.autoISF_min, maxISFReduction, sensitivityRatio, origin_sens, isTempTarget, high_temptarget_raises_sensitivity, target_bg, consoleError);
    return Math.min(720.0, round(sens / final_ISF, 1)); // observe ISF maximum of 720(?)
  } else if (bg_ISF > 1.0) {
    sens_modified = true;
  }

  const bg_delta = glucose_status.delta;
  const deltaType = 'pp';
  if (bg_off > 0.0) {
    consoleError.push(deltaType + `_ISF adaptation by-passed as average glucose < ${kd(target_bg)}+10`);
  } else if (glucose_status.shortAvgDelta < 0) {
    consoleError.push(deltaType + '_ISF adaptation by-passed as no rise or too short lived');
  } else {
    pp_ISF = 1.0 + Math.max(0.0, bg_delta * settings.pp_ISF_weight);
    consoleError.push(`pp_ISF adaptation is ${kd(round(pp_ISF, 2))}`);
    if (pp_ISF !== 1.0) sens_modified = true;
  }

  let dura_ISF = 1.0;
  const weightISF = settings.dura_ISF_weight;
  if (dura05 < 10.0) {
    consoleError.push(`dura_ISF by-passed; bg is only ${kd(dura05)} m at level ${kd(avg05)}`);
  } else if (avg05 <= target_bg) {
    consoleError.push(`dura_ISF by-passed; avg. glucose ${kd(avg05)} below target ${kd(target_bg)}`);
  } else {
    // fight the resistance at high levels
    const dura05Weight = dura05 / 60;
    const avg05Weight = weightISF / target_bg;
    dura_ISF += dura05Weight * avg05Weight * (avg05 - target_bg);
    sens_modified = true;
    consoleError.push(`dura_ISF adaptation is ${kd(round(dura_ISF, 2))} because ISF ${kd(round(sens, 1))} did not do it for ${kd(round(dura05, 1))}m`);
  }
  if (sens_modified) {
    liftISF = Math.max(dura_ISF, Math.max(bg_ISF, Math.max(acce_ISF, pp_ISF)));
    if (acce_ISF < 1.0) {
      consoleError.push(`strongest autoISF factor ${kd(round(liftISF, 2))} weakened to ${kd(round(liftISF * acce_ISF, 2))} as bg decelerates already`);
      liftISF = liftISF * acce_ISF;
    }
    final_ISF = withinISFlimits(liftISF, settings.autoISF_min, maxISFReduction, sensitivityRatio, origin_sens, isTempTarget, high_temptarget_raises_sensitivity, target_bg, consoleError);
    return round(sens / final_ISF, 1);
  }
  consoleError.push('----------------------------------');
  consoleError.push('end AutoISF');
  consoleError.push('----------------------------------');
  return round(sens / sensitivityRatio, 1); // nothing changed
}

/**
 * The iobTH limit as invoke computes it: { iobTHvirtual, iobThEffective,
 * use_iobTH }. `target_bg`: (min_bg + max_bg) / 2 after temp targets.
 */
export function iobThreshold ({ maxIob, target_bg, isTempTarget, profile_percentage, settings }) {
  let exerciseRatio = 1.0;
  if ((settings.highTemptargetRaisesSensitivity && isTempTarget && target_bg > normalTarget) ||
      (settings.lowTemptargetLowersSensitivity && isTempTarget && target_bg < normalTarget)) {
    const c = settings.halfBasalTarget - normalTarget;
    if (c * (c + target_bg - normalTarget) > 0.0) {
      let sensitivityRatio = c / (c + target_bg - normalTarget);
      sensitivityRatio = Math.min(sensitivityRatio, settings.autosensMax);
      exerciseRatio = round(sensitivityRatio, 2);
    }
  }
  let iobTH_reduction_ratio = 1.0;
  let use_iobTH = false;
  if (settings.iob_threshold_percent !== 100) {
    iobTH_reduction_ratio = profile_percentage / 100.0 * exerciseRatio;
    use_iobTH = true;
  }
  const iobTHtolerance = 130.0;
  const iobTHvirtual = settings.iob_threshold_percent * iobTHtolerance / 10000.0 * maxIob * iobTH_reduction_ratio;
  return { iobTHvirtual, iobThEffective: iobTHvirtual / iobTHtolerance * 100.0, use_iobTH };
}

/**
 * Who decides on SMBs: "AAPS" (the usual enable_smb rules), "fullLoop" or
 * "enforced" (SMBs on), "blocked" or "iobTH" (off). `profile`: max_iob,
 * target_bg, out_units. Log lines go to `consoleLog`.
 */
export function loopSmb ({ microBolusAllowed, profile, iob_data_iob, useIobTh, iobThEffective, settings, consoleLog = [] }) {
  const iobThUser = settings.iob_threshold_percent;
  if (useIobTh) {
    const iobThPercent = round(iobThEffective / profile.max_iob * 100.0, 0);
    if (iobThPercent === iobThUser) {
      consoleLog.push(`User setting iobTH=${iobThUser}% not modulated`);
    } else {
      consoleLog.push(`User setting iobTH=${iobThUser}% modulated to ${Math.trunc(iobThPercent)}% or ${kd(round(iobThEffective, 2))}U`);
      consoleLog.push('  due to profile %, exercise mode or similar');
    }
  } else {
    consoleLog.push('User setting iobTH=100% disables iobTH method');
  }

  if (!microBolusAllowed) return 'AAPS'; // see message in enable_smb
  if (settings.enableSMB_EvenOn_OddOff_always) {
    const mmol = profile.out_units === 'mmol/L';
    let target = mmol ? profile.target_bg * MGDL_TO_MMOLL : profile.target_bg;
    let evenTarget;
    let msgUnits;
    let msgTail;
    if (mmol) {
      evenTarget = Math.trunc(round(target * 10.0, 0)) % 2 === 0;
      target = round(target, 1);
      msgUnits = 'has';
      msgTail = 'decimal';
    } else {
      evenTarget = Math.trunc(round(target, 0)) % 2 === 0;
      target = round(target, 0);
      msgUnits = 'is';
      msgTail = 'number';
    }
    const msgEven = evenTarget ? 'even' : 'odd';
    if (!evenTarget) {
      consoleLog.push(`SMB disabled; current target ${kd(target)} ${msgUnits} ${msgEven} ${msgTail}`);
      consoleLog.push('Loop allows minimal power');
      return 'blocked';
    } else if (profile.max_iob === 0.0) {
      consoleLog.push('SMB disabled because of max_iob=0');
      return 'blocked';
    } else if (useIobTh && iobThEffective < iob_data_iob) {
      consoleLog.push(`SMB disabled by Full Loop logic: iob ${kd(iob_data_iob)} is above effective iobTH ${kd(iobThEffective)}`);
      consoleLog.push('Loop power level temporarily capped');
      return 'iobTH';
    } else {
      consoleLog.push(`SMB enabled; current target ${kd(target)} ${msgUnits} ${msgEven} ${msgTail}`);
      if (profile.target_bg < 100) { // indirect assessment; later set it in GUI
        consoleLog.push('Loop allows maximum power');
        return 'fullLoop'; // even number
      }
      consoleLog.push('Loop allows medium power');
      return 'enforced'; // even number
    }
  }
  consoleLog.push('Loop allows AAPS power level');
  return 'AAPS'; // leave it to standard AAPS
}

/** The share of insulinReq given as SMB, rising with glucose above target. `bg`: whole mg/dL. */
export function determineVarSmbRatio ({ bg, target_bg, loop_wanted_smb, settings, consoleLog = [] }) {
  const fix_SMB = settings.smb_delivery_ratio;
  const lower_SMB = Math.min(settings.smb_delivery_ratio_min, settings.smb_delivery_ratio_max);
  const higher_SMB = Math.max(settings.smb_delivery_ratio_min, settings.smb_delivery_ratio_max);
  const range = settings.smb_delivery_ratio_bg_range;
  const higher_bg = target_bg + range;
  let new_SMB = fix_SMB;
  if (range > 0) {
    new_SMB = lower_SMB + (higher_SMB - lower_SMB) * (bg - target_bg) / range;
    new_SMB = Math.max(lower_SMB, Math.min(higher_SMB, new_SMB)); // cap if outside target_bg--higher_bg
  }
  if (loop_wanted_smb === 'fullLoop') { // go for max impact
    consoleLog.push(`SMB delivery ratio set to ${kd(round(Math.max(fix_SMB, new_SMB), 2))} as max of fixed and interpolated values`);
    return Math.max(fix_SMB, new_SMB);
  }
  if (range === 0.0) { // deactivated in SMB extended menu
    consoleLog.push(`SMB delivery ratio set to fixed value ${kd(round(fix_SMB, 2))}`);
    return fix_SMB;
  }
  if (bg <= target_bg) {
    consoleLog.push(`SMB delivery ratio limited by minimum value ${kd(round(lower_SMB, 2))}`);
    return lower_SMB;
  }
  if (bg >= higher_bg) {
    consoleLog.push(`SMB delivery ratio limited by maximum value ${kd(round(higher_SMB, 2))}`);
    return higher_SMB;
  }
  consoleLog.push(`SMB delivery ratio set to interpolated value ${kd(round(new_SMB, 2))}`);
  return new_SMB;
}
