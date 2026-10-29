// determine_basal: one loop run of AAPS's oref1 algorithm, as SMB (with or
// without Dynamic ISF) and as AutoISF. Given the glucose status, IOB array,
// profile, autosens and meal data, it predicts glucose and decides the temp
// basal and SMB.
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// - plugins/aps/src/main/kotlin/app/aaps/plugins/aps/openAPSSMB/DetermineBasalSMB.kt
// - plugins/aps/src/main/kotlin/app/aaps/plugins/aps/openAPSAutoISF/DetermineBasalAutoISF.kt
// The two files are one algorithm with a few differences, marked "AutoISF:"
// here. Names, order and messages follow the Kotlin, so changes in a new AAPS
// release can be carried over by diff. Glucose is in mg/dL throughout;
// profile.out_units only sets the units of the reason text.

import { convertBg, kd, round, toFixed2, withoutZeros } from './format.js';

// Constants.NORMAL_TARGET_MGDL
export const NORMAL_TARGET_MGDL = 99;

function calculateExpectedDelta (targetBg, eventualBg, bgi) {
  // (hours * mins_per_hour) / 5 = how many 5 minute periods in 2h = 24
  const fiveMinBlocks = (2 * 60) / 5;
  const targetDelta = targetBg - eventualBg;
  return round(bgi + (targetDelta / fiveMinBlocks), 1);
}

/** A result (RT) with a reason that collects text as Kotlin's StringBuilder. */
function newRT (fields, consoleLog, consoleError) {
  return {
    algorithm: fields.algorithm,
    runningDynamicIsf: fields.runningDynamicIsf,
    timestamp: fields.timestamp,
    bg: fields.bg ?? null,
    tick: fields.tick ?? null,
    eventualBG: fields.eventualBG ?? null,
    targetBG: fields.targetBG ?? null,
    insulinReq: fields.insulinReq ?? null,
    deliverAt: fields.deliverAt ?? null,
    sensitivityRatio: fields.sensitivityRatio ?? null,
    variable_sens: fields.variable_sens ?? null,
    predBGs: null,
    COB: null,
    IOB: null,
    reason: '',
    rate: null,
    duration: null,
    units: null,
    carbsReq: null,
    carbsReqWithin: null,
    consoleLog,
    consoleError,
  };
}

/**
 * One run. `input`:
 * - glucose_status { glucose, noise, delta, shortAvgDelta, longAvgDelta, date }
 * - currenttemp { duration (min), rate (U/h) }
 * - iob_data_array [{ iob, basaliob, activity, lastBolusTime, iobWithZeroTemp }], 5-min steps
 * - profile (OapsProfile / OapsProfileAutoIsf fields)
 * - autosens_data { ratio }
 * - meal_data { carbs, mealCOB, slopeFromMaxDeviation, slopeFromMinDeviation, lastCarbTime }
 * - microBolusAllowed, currentTime (ms), flatBGsDetected
 * - dynIsfMode (SMB) or, with autoIsf: autoIsfMode, loop_wanted_smb,
 *   profile_percentage, smb_ratio, smb_max_range_extension,
 *   iob_threshold_percent, auto_isf_consoleError, auto_isf_consoleLog
 * - minuteOf(t): the minute of the hour at t on the phone (skip_neutral_temps)
 */
export function determineBasal (input, { autoIsf = false } = {}) {
  const {
    glucose_status, currenttemp, iob_data_array, profile, autosens_data, meal_data,
    microBolusAllowed, currentTime, flatBGsDetected,
  } = input;
  // dynIsfMode in SMB, autoIsfMode in AutoISF: profile.variable_sens is the ISF.
  const variableIsf = autoIsf ? !!input.autoIsfMode : !!input.dynIsfMode;
  const dynIsfMode = !autoIsf && variableIsf;
  const units = profile.out_units;
  const convert_bg = (v) => convertBg(v, units);
  const minuteOf = input.minuteOf || ((t) => new Date(t).getMinutes());

  const consoleError = [];
  const consoleLog = [];
  const algorithm = autoIsf ? 'AUTO_ISF' : 'SMB';
  let rT = newRT({ algorithm, runningDynamicIsf: variableIsf, timestamp: currentTime }, consoleLog, consoleError);
  const append = (s) => { rT.reason += s; };
  const reason = (msg) => {
    if (rT.reason.length) rT.reason += '. ';
    rT.reason += msg;
    consoleError.push(msg);
  };
  const getMaxSafeBasal = () =>
    Math.min(profile.max_basal, Math.min(profile.max_daily_safety_multiplier * profile.max_daily_basal, profile.current_basal_safety_multiplier * profile.current_basal));
  const round_basal = (v) => v;

  function enable_smb (target_bg) {
    // disable SMB when a high temptarget is set
    if (!microBolusAllowed) {
      consoleError.push('SMB disabled (!microBolusAllowed)');
      return false;
    } else if (!profile.allowSMB_with_high_temptarget && profile.temptargetSet && target_bg > (autoIsf ? 100 : NORMAL_TARGET_MGDL)) {
      consoleError.push(`SMB disabled due to high temptarget of ${kd(target_bg)}`);
      return false;
    }
    // enable SMB/UAM if always-on (unless previously disabled for high temptarget)
    if (profile.enableSMB_always) {
      consoleError.push('SMB enabled due to enableSMB_always');
      return true;
    }
    // enable SMB/UAM (if enabled in preferences) while we have COB
    if (profile.enableSMB_with_COB && meal_data.mealCOB !== 0) {
      consoleError.push(`SMB enabled for COB of ${kd(meal_data.mealCOB)}`);
      return true;
    }
    // enable SMB/UAM (if enabled in preferences) for a full 6 hours after any carb entry
    if (profile.enableSMB_after_carbs && meal_data.carbs !== 0) {
      consoleError.push('SMB enabled for 6h after carb entry');
      return true;
    }
    // enable SMB/UAM (if enabled in preferences) if a low temptarget is set
    if (profile.enableSMB_with_temptarget && (profile.temptargetSet && target_bg < 100)) {
      consoleError.push(`SMB enabled for temptarget of ${convert_bg(target_bg)}`);
      return true;
    }
    consoleError.push('SMB disabled (no enableSMB preferences active or no condition satisfied)');
    return false;
  }

  function setTempBasal (_rate, duration) {
    const maxSafeBasal = getMaxSafeBasal();
    let rate = _rate;
    if (rate < 0) rate = 0.0;
    else if (rate > maxSafeBasal) rate = maxSafeBasal;

    const suggestedRate = round_basal(rate);
    if (currenttemp.duration > (duration - 10) && currenttemp.duration <= 120 && suggestedRate <= currenttemp.rate * 1.2 && suggestedRate >= currenttemp.rate * 0.8 && duration > 0) {
      append(` ${currenttemp.duration}m left and ${withoutZeros(currenttemp.rate)} ~ req ${withoutZeros(suggestedRate)}U/hr: no temp required`);
      return rT;
    }

    if (suggestedRate === profile.current_basal) {
      if (profile.skip_neutral_temps) {
        if (currenttemp.duration > 0) {
          reason('Suggested rate is same as profile rate, a temp basal is active, canceling current temp');
          rT.duration = 0;
          rT.rate = 0.0;
          return rT;
        } else {
          reason('Suggested rate is same as profile rate, no temp basal is active, doing nothing');
          return rT;
        }
      } else {
        reason(`Setting neutral temp basal of ${kd(profile.current_basal)}U/hr`);
        rT.duration = duration;
        rT.rate = suggestedRate;
        return rT;
      }
    } else {
      rT.duration = duration;
      rT.rate = suggestedRate;
      return rT;
    }
  }

  const deliverAt = currentTime;
  const profile_current_basal = round_basal(profile.current_basal);
  let basal = profile_current_basal;
  const systemTime = currentTime;
  const bgTime = glucose_status.date;
  const minAgo = round((systemTime - bgTime) / 60.0 / 1000.0, 1);
  const bg = glucose_status.glucose;
  const noise = glucose_status.noise ?? 0;
  // 38 is an xDrip error state that usually indicates sensor failure
  if (bg <= 10 || bg === 38.0 || noise >= 3) {
    append('CGM is calibrating, in ??? state, or noise is high');
  }
  if (minAgo > 12 || minAgo < -5) { // Dexcom data is too old, or way in the future
    append(`If current system time ${systemTime} is correct, then BG data is too old. The last BG data was read ${kd(minAgo)}m ago at ${bgTime}`);
  } else if (bg > 60 && flatBGsDetected) {
    append('Error: CGM data is unchanged for the past ~45m');
  }
  if (bg <= 10 || bg === 38.0 || noise >= 3 || minAgo > 12 || minAgo < -5 || (bg > 60 && flatBGsDetected)) {
    if (currenttemp.rate > basal) { // high temp is running
      append(`. Replacing high temp basal of ${kd(currenttemp.rate)} with neutral temp of ${kd(basal)}`);
      rT.deliverAt = deliverAt;
      rT.duration = 30;
      rT.rate = basal;
      return rT;
    } else if (currenttemp.rate === 0.0 && currenttemp.duration > 30) { // shorten long zero temps to 30m
      append('. Shortening ' + currenttemp.duration + 'm long zero temp to 30m. ');
      rT.deliverAt = deliverAt;
      rT.duration = 30;
      rT.rate = 0.0;
      return rT;
    } else { // do nothing.
      append(`. Temp ${kd(currenttemp.rate)} <= current basal ${kd(round(basal, 2))}U/hr; doing nothing. `);
      return rT;
    }
  }

  const max_iob = profile.max_iob; // maximum amount of non-bolus IOB OpenAPS will ever deliver

  // if min and max are set, then set target to their average
  let target_bg = (profile.min_bg + profile.max_bg) / 2;
  let min_bg = profile.min_bg;
  let max_bg = profile.max_bg;

  let sensitivityRatio = autoIsf ? 1.0 : undefined;
  let exercise_ratio = 1.0; // AutoISF
  const high_temptarget_raises_sensitivity = profile.exercise_mode || profile.high_temptarget_raises_sensitivity;
  const normalTarget = NORMAL_TARGET_MGDL; // evaluate high/low temptarget against normal target, not scheduled target (which might change)
  // when temptarget is 160 mg/dL, run 50% basal (120 = 75%; 140 = 60%), 80 mg/dL with low_temptarget_lowers_sensitivity would give 1.5x basal, but is limited to autosens_max (1.2x by default)
  const halfBasalTarget = profile.half_basal_exercise_target;

  if (dynIsfMode) {
    consoleError.push('---------------------------------------------------------');
    consoleError.push(' Dynamic ISF version 2.0 ');
    consoleError.push('---------------------------------------------------------');
  }

  if ((high_temptarget_raises_sensitivity && profile.temptargetSet && target_bg > normalTarget) ||
      (profile.low_temptarget_lowers_sensitivity && profile.temptargetSet && target_bg < normalTarget)) {
    // w/ target 100, temp target 110 = .89, 120 = 0.8, 140 = 0.67, 160 = .57, and 200 = .44
    const c = halfBasalTarget - normalTarget;
    if (autoIsf) {
      // AutoISF: a half basal target at or below the normal target means the maximum.
      if (c * (c + target_bg - normalTarget) <= 0.0) {
        sensitivityRatio = profile.autosens_max;
      } else {
        sensitivityRatio = c / (c + target_bg - normalTarget);
        // limit sensitivityRatio to profile.autosens_max (1.2x by default)
        sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
        sensitivityRatio = round(sensitivityRatio, 2);
        exercise_ratio = sensitivityRatio;
        consoleError.push(`Sensitivity ratio set to ${kd(sensitivityRatio)} based on temp target of ${kd(target_bg)}; `);
      }
    } else {
      sensitivityRatio = c / (c + target_bg - normalTarget);
      // limit sensitivityRatio to profile.autosens_max (1.2x by default)
      sensitivityRatio = Math.min(sensitivityRatio, profile.autosens_max);
      sensitivityRatio = round(sensitivityRatio, 2);
      consoleLog.push(`Sensitivity ratio set to ${kd(sensitivityRatio)} based on temp target of ${kd(target_bg)}; `);
    }
  } else {
    sensitivityRatio = autosens_data.ratio;
    (autoIsf ? consoleError : consoleLog).push(`Autosens ratio: ${kd(sensitivityRatio)}; `);
  }
  // AutoISF: iobTH, the IOB threshold for SMBs, shrinks with the profile percentage and exercise.
  let iobTH_reduction_ratio = 1.0;
  if (autoIsf && input.iob_threshold_percent !== 100) {
    iobTH_reduction_ratio = input.profile_percentage / 100.0 * exercise_ratio;
  }
  basal = profile.current_basal * sensitivityRatio;
  basal = round_basal(basal);
  if (basal !== profile_current_basal) {
    (autoIsf ? consoleError : consoleLog).push(`Adjusting basal from ${kd(profile_current_basal)} to ${kd(basal)};${autoIsf ? '' : ' '}`);
  } else {
    (autoIsf ? consoleError : consoleLog).push(`Basal unchanged: ${kd(basal)};${autoIsf ? '' : ' '}`);
  }

  // adjust min, max, and target BG for sensitivity, such that 50% increase in ISF raises target from 100 to 120
  if (!profile.temptargetSet) {
    if ((profile.sensitivity_raises_target && autosens_data.ratio < 1) || (profile.resistance_lowers_target && autosens_data.ratio > 1)) {
      // with a target of 100, default 0.7-1.2 autosens min/max range would allow a 93-117 target range
      min_bg = round((min_bg - 60) / autosens_data.ratio, 0) + 60;
      max_bg = round((max_bg - 60) / autosens_data.ratio, 0) + 60;
      let new_target_bg = round((target_bg - 60) / autosens_data.ratio, 0) + 60;
      // don't allow target_bg below 80
      new_target_bg = Math.max(80.0, new_target_bg);
      if (target_bg === new_target_bg) (autoIsf ? consoleError : consoleLog).push(`target_bg unchanged: ${kd(new_target_bg)}; `);
      else (autoIsf ? consoleError : consoleLog).push(`target_bg from ${kd(target_bg)} to ${kd(new_target_bg)}; `);
      target_bg = new_target_bg;
    }
  }

  const iobArray = iob_data_array;
  const iob_data = iobArray[0];

  const tick = glucose_status.delta > -0.5 ? '+' + round(glucose_status.delta) : String(round(glucose_status.delta));
  const minDelta = Math.min(glucose_status.delta, glucose_status.shortAvgDelta);
  const minAvgDelta = Math.min(glucose_status.shortAvgDelta, glucose_status.longAvgDelta);
  const maxDelta = Math.max(glucose_status.delta, Math.max(glucose_status.shortAvgDelta, glucose_status.longAvgDelta));

  let sens;
  if (autoIsf) {
    const profile_sens = round(profile.sens, 1);
    const adjusted_sens = round(profile.sens / sensitivityRatio, 1);
    if (adjusted_sens !== profile_sens) consoleError.push(`ISF from ${kd(profile_sens)} to ${kd(adjusted_sens)}`);
    else consoleError.push(`ISF unchanged: ${kd(adjusted_sens)}`);
    sens = variableIsf ? profile.variable_sens : adjusted_sens;
  } else if (dynIsfMode) {
    sens = profile.variable_sens;
  } else {
    const profile_sens = round(profile.sens, 1);
    const adjusted_sens = round(profile.sens / sensitivityRatio, 1);
    if (adjusted_sens !== profile_sens) consoleLog.push(`ISF from ${kd(profile_sens)} to ${kd(adjusted_sens)}`);
    else consoleLog.push(`ISF unchanged: ${kd(adjusted_sens)}`);
    sens = adjusted_sens;
  }
  consoleError.push(autoIsf ? `CR: ${kd(profile.carb_ratio)}` : `CR:${kd(profile.carb_ratio)}`);

  // AutoISF: its own log, the iobTH limit and who decides on SMBs.
  const iobTHtolerance = 130.0;
  let iobTHvirtual = 0;
  let enableSMB = false;
  if (autoIsf) {
    if (variableIsf) {
      consoleError.push('----------------------------------');
      consoleError.push(`start AutoISF ${profile.autoISF_version}`);
      consoleError.push('----------------------------------');
      consoleError.push(...(input.auto_isf_consoleLog || []));
      consoleError.push(...(input.auto_isf_consoleError || []));
    }
    // if that would put us over iobTH, then reduce accordingly; allow 30% overrun
    iobTHvirtual = input.iob_threshold_percent * iobTHtolerance / 10000.0 * profile.max_iob * iobTH_reduction_ratio;
    if (microBolusAllowed && input.loop_wanted_smb !== 'AAPS') {
      if (input.loop_wanted_smb === 'enforced' || input.loop_wanted_smb === 'fullLoop') enableSMB = true; // otherwise FL switched SMB off
    } else {
      enableSMB = enable_smb(target_bg);
    }
  }

  // calculate BG impact: the amount BG "should" be rising or falling based on insulin activity alone
  const bgi = round((-iob_data.activity * sens * 5), 2);
  // project deviations for 30 minutes
  let deviation = round(30 / 5 * (minDelta - bgi));
  // don't overreact to a big negative delta: use minAvgDelta if deviation is negative
  if (deviation < 0) {
    deviation = round((30 / 5) * (minAvgDelta - bgi));
    // and if deviation is still negative, use long_avgdelta
    if (deviation < 0) deviation = round((30 / 5) * (glucose_status.longAvgDelta - bgi));
  }

  // calculate the naive (bolus calculator math) eventual BG based on net IOB and sensitivity
  let naive_eventualBG;
  if (variableIsf) naive_eventualBG = round(bg - (iob_data.iob * sens), 0);
  else if (iob_data.iob > 0) naive_eventualBG = round(bg - (iob_data.iob * sens), 0);
  else naive_eventualBG = round(bg - (iob_data.iob * Math.min(sens, profile.sens)), 0); // if IOB is negative, be more conservative and use the lower of sens, profile.sens
  // and adjust it for the deviation above
  let eventualBG = naive_eventualBG + deviation;

  const tlog = autoIsf ? consoleError : consoleLog;
  // raise target for noisy / raw CGM data
  if (bg > max_bg && profile.adv_target_adjustments && !profile.temptargetSet) {
    // with target=100, as BG rises from 100 to 160, adjustedTarget drops from 100 to 80
    const adjustedMinBG = round(Math.max(80.0, min_bg - (bg - min_bg) / 3.0), 0);
    const adjustedTargetBG = round(Math.max(80.0, target_bg - (bg - target_bg) / 3.0), 0);
    const adjustedMaxBG = round(Math.max(80.0, max_bg - (bg - max_bg) / 3.0), 0);
    // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedMinBG, don't use it
    if (eventualBG > adjustedMinBG && naive_eventualBG > adjustedMinBG && min_bg > adjustedMinBG) {
      tlog.push(`Adjusting targets for high BG: min_bg from ${kd(min_bg)} to ${kd(adjustedMinBG)}; `);
      min_bg = adjustedMinBG;
    } else {
      tlog.push(`min_bg unchanged: ${kd(min_bg)}; `);
    }
    // if eventualBG, naive_eventualBG, and target_bg aren't all above adjustedTargetBG, don't use it
    if (eventualBG > adjustedTargetBG && naive_eventualBG > adjustedTargetBG && target_bg > adjustedTargetBG) {
      tlog.push(`target_bg from ${kd(target_bg)} to ${kd(adjustedTargetBG)}; `);
      target_bg = adjustedTargetBG;
    } else {
      tlog.push(`target_bg unchanged: ${kd(target_bg)}; `);
    }
    // if eventualBG, naive_eventualBG, and max_bg aren't all above adjustedMaxBG, don't use it
    if (eventualBG > adjustedMaxBG && naive_eventualBG > adjustedMaxBG && max_bg > adjustedMaxBG) {
      consoleError.push(`max_bg from ${kd(max_bg)} to ${kd(adjustedMaxBG)}`);
      max_bg = adjustedMaxBG;
    } else {
      consoleError.push(`max_bg unchanged: ${kd(max_bg)}`);
    }
  }

  const expectedDelta = calculateExpectedDelta(target_bg, eventualBG, bgi);

  // min_bg of 90 -> threshold of 65, 100 -> 70 110 -> 75, and 130 -> 85
  let threshold = min_bg - 0.5 * (min_bg - 40);
  // AutoISF: the LGS threshold setting is not used.
  if (!autoIsf && profile.lgsThreshold != null) {
    const lgsThreshold = profile.lgsThreshold;
    if (lgsThreshold > threshold) {
      consoleError.push(`Threshold set from ${convert_bg(threshold)} to ${convert_bg(lgsThreshold)}; `);
      threshold = lgsThreshold;
    }
  }

  rT = newRT({
    algorithm,
    runningDynamicIsf: variableIsf,
    timestamp: currentTime,
    bg,
    tick,
    eventualBG,
    targetBG: target_bg,
    insulinReq: 0.0,
    deliverAt, // The time at which the microbolus should be delivered
    sensitivityRatio, // autosens ratio (fraction of normal basal)
    variable_sens: profile.variable_sens,
  }, consoleLog, consoleError);

  // generate predicted future BGs based on IOB, COB, and current absorption rate
  let COBpredBGs = [bg];
  let aCOBpredBGs = [bg];
  let IOBpredBGs = [bg];
  let UAMpredBGs = [bg];
  let ZTpredBGs = [bg];

  if (!autoIsf) enableSMB = enable_smb(target_bg);

  // enable UAM (if enabled in preferences)
  const enableUAM = profile.enableUAM;

  // carb impact and duration are 0 unless changed below
  let ci;
  let cid;
  // calculate current carb absorption rate, and how long to absorb all carbs
  // CI = current carb impact on BG in mg/dL/5m
  ci = round((minDelta - bgi), 1);
  const uci = round((minDelta - bgi), 1);
  // use autosens-adjusted sens to counteract autosens meal insulin dosing adjustments so that
  // autotuned CR is still in effect even when basals and ISF are being adjusted by TT or autosens
  // this avoids overdosing insulin for large meals when low temp targets are active
  const csf = sens / profile.carb_ratio;
  consoleError.push(`profile.sens: ${kd(profile.sens)}, sens: ${kd(sens)}, CSF: ${kd(csf)}`);

  const maxCarbAbsorptionRate = 30; // g/h; maximum rate to assume carbs will absorb if no CI observed
  // limit Carb Impact to maxCarbAbsorptionRate * csf in mg/dL per 5m
  const maxCI = round(maxCarbAbsorptionRate * csf * 5 / 60, 1);
  if (ci > maxCI) {
    consoleError.push(`Limiting carb impact from ${kd(ci)} to ${kd(maxCI)} mg/dL/5m ( ${maxCarbAbsorptionRate} g/h )`);
    ci = maxCI;
  }
  let remainingCATimeMin = 3.0; // h; duration of expected not-yet-observed carb absorption
  // adjust remainingCATime (instead of CR) for autosens if sensitivityRatio defined
  remainingCATimeMin = remainingCATimeMin / sensitivityRatio;
  // 20 g/h means that anything <= 60g will get a remainingCATimeMin, 80g will get 4h, and 120g 6h
  // when actual absorption ramps up it will take over from remainingCATime
  const assumedCarbAbsorptionRate = 20; // g/h; maximum rate to assume carbs will absorb if no CI observed
  let remainingCATime = remainingCATimeMin;
  if (meal_data.carbs !== 0) {
    // if carbs * assumedCarbAbsorptionRate > remainingCATimeMin, raise it
    // so <= 90g is assumed to take 3h, and 120g=4h
    remainingCATimeMin = Math.max(remainingCATimeMin, meal_data.mealCOB / assumedCarbAbsorptionRate);
    const lastCarbAge = round((systemTime - meal_data.lastCarbTime) / 60000.0);
    const fractionCOBAbsorbed = (meal_data.carbs - meal_data.mealCOB) / meal_data.carbs;
    remainingCATime = remainingCATimeMin + 1.5 * lastCarbAge / 60;
    remainingCATime = round(remainingCATime, 1);
    consoleError.push('Last carbs ' + lastCarbAge + 'minutes ago; remainingCATime:' + kd(remainingCATime) + 'hours;' + round(fractionCOBAbsorbed * 100) + '% carbs absorbed');
  }

  // calculate the number of carbs absorbed over remainingCATime hours at current CI
  // CI (mg/dL/5m) * (5m)/5 (m) * 60 (min/hr) * 4 (h) / 2 (linear decay factor) = total carb impact (mg/dL)
  const totalCI = Math.max(0.0, ci / 5 * 60 * remainingCATime / 2);
  // totalCI (mg/dL) / CSF (mg/dL/g) = total carbs absorbed (g)
  const totalCA = totalCI / csf;
  const remainingCarbsCap = Math.min(90, profile.remainingCarbsCap);
  let remainingCarbs = Math.max(0.0, meal_data.mealCOB - totalCA);
  remainingCarbs = Math.min(remainingCarbsCap, remainingCarbs);
  // assume remainingCarbs will absorb in a /\ shaped bilinear curve
  // peaking at remainingCATime / 2 and ending at remainingCATime hours
  // area of the /\ triangle is the same as a remainingCIpeak-height rectangle out to remainingCATime/2
  // remainingCIpeak (mg/dL/5m) = remainingCarbs (g) * CSF (mg/dL/g) * 5 (m/5m) * 1h/60m / (remainingCATime/2) (h)
  const remainingCIpeak = remainingCarbs * csf * 5 / 60 / (remainingCATime / 2);

  // calculate peak deviation in last hour, and slope from that to current deviation
  const slopeFromMaxDeviation = round(meal_data.slopeFromMaxDeviation, 2);
  // calculate lowest deviation in last hour, and slope from that to current deviation
  const slopeFromMinDeviation = round(meal_data.slopeFromMinDeviation, 2);
  // assume deviations will drop back down at least at 1/3 the rate they ramped up
  const slopeFromDeviations = Math.min(slopeFromMaxDeviation, -slopeFromMinDeviation / 3);

  const aci = 10;
  // 5m data points = g * (1U/10g) * (40mg/dL/1U) / (mg/dL/5m)
  // duration (in 5m data points) = COB (g) * CSF (mg/dL/g) / ci (mg/dL/5m)
  // limit cid to remainingCATime hours: the reset goes to remainingCI
  if (ci === 0.0) {
    // avoid divide by zero
    cid = 0.0;
  } else {
    cid = Math.min(remainingCATime * 60 / 5 / 2, Math.max(0.0, meal_data.mealCOB * csf / ci));
  }
  const acid = Math.max(0.0, meal_data.mealCOB * csf / aci);
  // duration (hours) = duration (5m) * 5 / 60 * 2 (to account for linear decay)
  consoleError.push(`Carb Impact: ${kd(ci)} mg/dL per 5m; CI Duration: ${kd(round(cid * 5 / 60 * 2, 1))} hours; remaining CI (~2h peak): ${kd(round(remainingCIpeak, 1))} mg/dL per 5m`);
  let minIOBPredBG = 999.0;
  let minCOBPredBG = 999.0;
  let minUAMPredBG = 999.0;
  let minGuardBG;
  let minCOBGuardBG = 999.0;
  let minUAMGuardBG = 999.0;
  let minIOBGuardBG = 999.0;
  let minZTGuardBG = 999.0;
  let minPredBG;
  let avgPredBG;
  let IOBpredBG = eventualBG;
  let maxIOBPredBG = bg;
  let maxCOBPredBG = bg;
  let lastIOBpredBG;
  let lastCOBpredBG = null;
  let lastUAMpredBG = null;
  let UAMduration = 0.0;
  let remainingCItotal = 0.0;
  const remainingCIs = [];
  const predCIs = [];
  let UAMpredBG = null;
  let COBpredBG = null;
  let aCOBpredBG;
  // Dynamic ISF: the ISF at a predicted glucose.
  const dynSens = (g) => 1800 / (profile.TDD * (Math.log((Math.max(g, 39.0) / profile.insulinDivisor) + 1)));
  for (const iobTick of iobArray) {
    const predBGI = round((-iobTick.activity * sens * 5), 2);
    const IOBpredBGI = dynIsfMode ? round((-iobTick.activity * dynSens(IOBpredBGs[IOBpredBGs.length - 1]) * 5), 2) : predBGI;
    if (!iobTick.iobWithZeroTemp) throw new Error('iobTick.iobWithZeroTemp missing');
    const predZTBGI = dynIsfMode
      ? round((-iobTick.iobWithZeroTemp.activity * dynSens(ZTpredBGs[ZTpredBGs.length - 1]) * 5), 2)
      : round((-iobTick.iobWithZeroTemp.activity * sens * 5), 2);
    const predUAMBGI = dynIsfMode ? round((-iobTick.activity * dynSens(UAMpredBGs[UAMpredBGs.length - 1]) * 5), 2) : predBGI;
    // for IOBpredBGs, predicted deviation impact drops linearly from current deviation down to zero
    // over 60 minutes (data points every 5m)
    const predDev = ci * (1 - Math.min(1.0, IOBpredBGs.length / (60.0 / 5.0)));
    IOBpredBG = IOBpredBGs[IOBpredBGs.length - 1] + IOBpredBGI + predDev;
    // calculate predBGs with long zero temp without deviations
    const ZTpredBG = ZTpredBGs[ZTpredBGs.length - 1] + predZTBGI;
    // for COBpredBGs, predicted carb impact drops linearly from current carb impact down to zero
    // eventually accounting for all carbs (if they can be absorbed over DIA)
    const predCI = Math.max(0.0, Math.max(0.0, ci) * (1 - COBpredBGs.length / Math.max(cid * 2, 1.0)));
    const predACI = Math.max(0.0, Math.max(0, aci) * (1 - COBpredBGs.length / Math.max(acid * 2, 1.0)));
    // if any carbs aren't absorbed after remainingCATime hours, assume they'll absorb in a /\ shaped
    // bilinear curve peaking at remainingCIpeak at remainingCATime/2 hours (remainingCATime/2*12 * 5m)
    // and ending at remainingCATime h (remainingCATime*12 * 5m intervals)
    const intervals = Math.min(COBpredBGs.length, ((remainingCATime * 12) - COBpredBGs.length));
    const remainingCI = Math.max(0.0, intervals / (remainingCATime / 2 * 12) * remainingCIpeak);
    remainingCItotal += predCI + remainingCI;
    remainingCIs.push(round(remainingCI));
    predCIs.push(round(predCI));
    COBpredBG = COBpredBGs[COBpredBGs.length - 1] + predBGI + Math.min(0.0, predDev) + predCI + remainingCI;
    aCOBpredBG = aCOBpredBGs[aCOBpredBGs.length - 1] + predBGI + Math.min(0.0, predDev) + predACI;
    // for UAMpredBGs, predicted carb impact drops at slopeFromDeviations
    // calculate predicted CI from UAM based on slopeFromDeviations
    const predUCIslope = Math.max(0.0, uci + (UAMpredBGs.length * slopeFromDeviations));
    // if slopeFromDeviations is too flat, predicted deviation impact drops linearly from
    // current deviation down to zero over 3h (data points every 5m)
    const predUCImax = Math.max(0.0, uci * (1 - UAMpredBGs.length / Math.max(3.0 * 60 / 5, 1.0)));
    // predicted CI from UAM is the lesser of CI based on deviationSlope or DIA
    const predUCI = Math.min(predUCIslope, predUCImax);
    if (predUCI > 0) {
      UAMduration = round((UAMpredBGs.length + 1) * 5 / 60.0, 1);
    }
    UAMpredBG = UAMpredBGs[UAMpredBGs.length - 1] + predUAMBGI + Math.min(0.0, predDev) + predUCI;
    // truncate all BG predictions at 4 hours
    if (IOBpredBGs.length < 48) IOBpredBGs.push(IOBpredBG);
    if (COBpredBGs.length < 48) COBpredBGs.push(COBpredBG);
    if (aCOBpredBGs.length < 48) aCOBpredBGs.push(aCOBpredBG);
    if (UAMpredBGs.length < 48) UAMpredBGs.push(UAMpredBG);
    if (ZTpredBGs.length < 48) ZTpredBGs.push(ZTpredBG);
    // calculate minGuardBGs without a wait from COB, UAM, IOB predBGs
    if (COBpredBG < minCOBGuardBG) minCOBGuardBG = round(COBpredBG);
    if (UAMpredBG < minUAMGuardBG) minUAMGuardBG = round(UAMpredBG);
    if (IOBpredBG < minIOBGuardBG) minIOBGuardBG = IOBpredBG;
    if (ZTpredBG < minZTGuardBG) minZTGuardBG = round(ZTpredBG, 0);

    // set minPredBGs starting when currently-dosed insulin activity will peak
    // look ahead 60m (regardless of insulin type) so as to be less aggressive on slower insulins
    // add 30m to allow for insulin delivery (SMBs or temps)
    const insulinPeakTime = 90;
    const insulinPeak5m = (insulinPeakTime / 60.0) * 12.0;

    // wait 90m before setting minIOBPredBG
    if (IOBpredBGs.length > insulinPeak5m && (IOBpredBG < minIOBPredBG)) minIOBPredBG = round(IOBpredBG, 0);
    if (IOBpredBG > maxIOBPredBG) maxIOBPredBG = IOBpredBG;
    // wait 85-105m before setting COB and 60m for UAM minPredBGs
    if ((cid !== 0.0 || remainingCIpeak > 0) && COBpredBGs.length > insulinPeak5m && (COBpredBG < minCOBPredBG)) minCOBPredBG = round(COBpredBG, 0);
    if ((cid !== 0.0 || remainingCIpeak > 0) && COBpredBG > maxIOBPredBG) maxCOBPredBG = COBpredBG;
    if (enableUAM && UAMpredBGs.length > 12 && (UAMpredBG < minUAMPredBG)) minUAMPredBG = round(UAMpredBG, 0);
  }
  // set eventualBG to include effect of carbs
  if (meal_data.mealCOB > 0) {
    consoleError.push('predCIs (mg/dL/5m):' + predCIs.join(' '));
    consoleError.push('remainingCIs:      ' + remainingCIs.join(' '));
  }
  rT.predBGs = {};
  const clip = (list) => list.map((v) => round(Math.min(401.0, Math.max(39.0, v)), 0));
  // Drops the flat end of a curve: while the last two values are equal, from index `from` on.
  const trimFlat = (list, from) => {
    for (let i = list.length - 1; i >= from; i--) {
      if (list[i - 1] !== list[i]) break;
      else list.pop();
    }
  };
  IOBpredBGs = clip(IOBpredBGs);
  trimFlat(IOBpredBGs, 13);
  rT.predBGs.IOB = IOBpredBGs.slice();
  lastIOBpredBG = round(IOBpredBGs[IOBpredBGs.length - 1]);
  ZTpredBGs = clip(ZTpredBGs);
  for (let i = ZTpredBGs.length - 1; i >= 7; i--) {
    // stop displaying ZTpredBGs once they're rising and above target
    if (ZTpredBGs[i - 1] >= ZTpredBGs[i] || ZTpredBGs[i] <= target_bg) break;
    else ZTpredBGs.pop();
  }
  rT.predBGs.ZT = ZTpredBGs.slice();
  if (meal_data.mealCOB > 0) {
    aCOBpredBGs = clip(aCOBpredBGs);
    trimFlat(aCOBpredBGs, 13);
  }
  if (meal_data.mealCOB > 0 && (ci > 0 || remainingCIpeak > 0)) {
    COBpredBGs = clip(COBpredBGs);
    trimFlat(COBpredBGs, 13);
    rT.predBGs.COB = COBpredBGs.slice();
    lastCOBpredBG = COBpredBGs[COBpredBGs.length - 1];
    eventualBG = Math.max(eventualBG, round(COBpredBGs[COBpredBGs.length - 1], 0));
  }
  if (ci > 0 || remainingCIpeak > 0) {
    if (enableUAM) {
      UAMpredBGs = clip(UAMpredBGs);
      trimFlat(UAMpredBGs, 13);
      rT.predBGs.UAM = UAMpredBGs.slice();
      lastUAMpredBG = UAMpredBGs[UAMpredBGs.length - 1];
      eventualBG = Math.max(eventualBG, round(UAMpredBGs[UAMpredBGs.length - 1], 0));
    }
    // set eventualBG based on COB or UAM predBGs
    rT.eventualBG = eventualBG;
  }

  consoleError.push(`UAM Impact: ${kd(uci)} mg/dL per 5m; UAM Duration: ${kd(UAMduration)} hours`);
  tlog.push(`EventualBG is ${kd(eventualBG)} ;`);

  minIOBPredBG = Math.max(39.0, minIOBPredBG);
  minCOBPredBG = Math.max(39.0, minCOBPredBG);
  minUAMPredBG = Math.max(39.0, minUAMPredBG);
  minPredBG = round(minIOBPredBG, 0);

  const fSensBG = Math.min(minPredBG, bg);

  let future_sens = 0.0;
  if (dynIsfMode) {
    const ln = Math.log;
    if (bg > target_bg && glucose_status.delta < 3 && glucose_status.delta > -3 && glucose_status.shortAvgDelta > -3 && glucose_status.shortAvgDelta < 3 && eventualBG > target_bg && eventualBG < bg) {
      future_sens = (1800 / (ln((((fSensBG * 0.5) + (bg * 0.5)) / profile.insulinDivisor) + 1) * profile.TDD));
      future_sens = round(future_sens, 1);
      consoleLog.push(`Future state sensitivity is ${kd(future_sens)} based on eventual and current bg due to flat glucose level above target`);
      rT.reason += `Dosing sensitivity: ${kd(future_sens)} using eventual BG;`;
    } else if ((glucose_status.delta > 0 && eventualBG > target_bg) || eventualBG > bg) {
      future_sens = (1800 / (ln((bg / profile.insulinDivisor) + 1) * profile.TDD));
      future_sens = round(future_sens, 1);
      consoleLog.push(`Future state sensitivity is ${kd(future_sens)} using current bg due to small delta or variation`);
      rT.reason += `Dosing sensitivity: ${kd(future_sens)} using current BG;`;
    } else {
      future_sens = (1800 / (ln((fSensBG / profile.insulinDivisor) + 1) * profile.TDD));
      future_sens = round(future_sens, 1);
      consoleLog.push(`Future state sensitivity is ${kd(future_sens)} based on eventual bg due to -ve delta`);
      rT.reason += `Dosing sensitivity: ${kd(future_sens)} using eventual BG;`;
    }
  }

  const fractionCarbsLeft = meal_data.mealCOB / meal_data.carbs;
  // if we have COB and UAM is enabled, average both
  if (minUAMPredBG < 999 && minCOBPredBG < 999) {
    // weight COBpredBG vs. UAMpredBG based on how many carbs remain as COB
    avgPredBG = round((1 - fractionCarbsLeft) * UAMpredBG + fractionCarbsLeft * COBpredBG, 0);
    // if UAM is disabled, average IOB and COB
  } else if (minCOBPredBG < 999) {
    avgPredBG = round((IOBpredBG + COBpredBG) / 2.0, 0);
    // if we have UAM but no COB, average IOB and UAM
  } else if (minUAMPredBG < 999) {
    avgPredBG = round((IOBpredBG + UAMpredBG) / 2.0, 0);
  } else {
    avgPredBG = round(IOBpredBG, 0);
  }
  // if avgPredBG is below minZTGuardBG, bring it up to that level
  if (minZTGuardBG > avgPredBG) avgPredBG = minZTGuardBG;

  // if we have both minCOBGuardBG and minUAMGuardBG, blend according to fractionCarbsLeft
  if (cid > 0.0 || remainingCIpeak > 0) {
    if (enableUAM) minGuardBG = fractionCarbsLeft * minCOBGuardBG + (1 - fractionCarbsLeft) * minUAMGuardBG;
    else minGuardBG = minCOBGuardBG;
  } else if (enableUAM) {
    minGuardBG = minUAMGuardBG;
  } else {
    minGuardBG = minIOBGuardBG;
  }
  minGuardBG = round(minGuardBG, 0);

  let minZTUAMPredBG = minUAMPredBG;
  // if minZTGuardBG is below threshold, bring down any super-high minUAMPredBG by averaging
  // this helps prevent UAM from giving too much insulin in case absorption falls off suddenly
  if (minZTGuardBG < threshold) {
    minZTUAMPredBG = (minUAMPredBG + minZTGuardBG) / 2.0;
    // if minZTGuardBG is between threshold and target, blend in the averaging
  } else if (minZTGuardBG < target_bg) {
    // target 100, threshold 70, minZTGuardBG 85 gives 50%: (85-70) / (100-70)
    const blendPct = (minZTGuardBG - threshold) / (target_bg - threshold);
    const blendedMinZTGuardBG = minUAMPredBG * blendPct + minZTGuardBG * (1 - blendPct);
    minZTUAMPredBG = (minUAMPredBG + blendedMinZTGuardBG) / 2.0;
    // if minUAMPredBG is below minZTGuardBG, bring minUAMPredBG up by averaging
    // this allows more insulin if lastUAMPredBG is below target, but minZTGuardBG is still high
  } else if (minZTGuardBG > minUAMPredBG) {
    minZTUAMPredBG = (minUAMPredBG + minZTGuardBG) / 2.0;
  }
  minZTUAMPredBG = round(minZTUAMPredBG, 0);
  // if any carbs have been entered recently
  if (meal_data.carbs !== 0) {
    // if UAM is disabled, use max of minIOBPredBG, minCOBPredBG
    if (!enableUAM && minCOBPredBG < 999) {
      minPredBG = round(Math.max(minIOBPredBG, minCOBPredBG), 0);
      // if we have COB, use minCOBPredBG, or blendedMinPredBG if it's higher
    } else if (minCOBPredBG < 999) {
      // calculate blendedMinPredBG based on how many carbs remain as COB
      const blendedMinPredBG = fractionCarbsLeft * minCOBPredBG + (1 - fractionCarbsLeft) * minZTUAMPredBG;
      // if blendedMinPredBG > minCOBPredBG, use that instead
      minPredBG = round(Math.max(minIOBPredBG, Math.max(minCOBPredBG, blendedMinPredBG)), 0);
      // if carbs have been entered, but have expired, use minUAMPredBG
    } else if (enableUAM) {
      minPredBG = minZTUAMPredBG;
    } else {
      minPredBG = minGuardBG;
    }
    // in pure UAM mode, use the higher of minIOBPredBG,minUAMPredBG
  } else if (enableUAM) {
    minPredBG = round(Math.max(minIOBPredBG, minZTUAMPredBG), 0);
  }
  // make sure minPredBG isn't higher than avgPredBG
  minPredBG = Math.min(minPredBG, avgPredBG);

  tlog.push(`minPredBG: ${kd(minPredBG)} minIOBPredBG: ${kd(minIOBPredBG)} minZTGuardBG: ${kd(minZTGuardBG)}`);
  if (minCOBPredBG < 999) tlog.push(` minCOBPredBG: ${kd(minCOBPredBG)}`);
  if (minUAMPredBG < 999) tlog.push(` minUAMPredBG: ${kd(minUAMPredBG)}`);
  consoleError.push(` avgPredBG: ${kd(avgPredBG)} COB: ${kd(meal_data.mealCOB)} / ${kd(meal_data.carbs)}`);
  // But if the COB line falls off a cliff, don't trust UAM too much:
  // use maxCOBPredBG if it's been set and lower than minPredBG
  if (maxCOBPredBG > bg) minPredBG = Math.min(minPredBG, maxCOBPredBG);

  rT.COB = meal_data.mealCOB;
  rT.IOB = iob_data.iob;
  rT.reason += `COB: ${withoutZeros(round(meal_data.mealCOB, 1))}, Dev: ${convert_bg(deviation)}, BGI: ${convert_bg(bgi)}, ISF: ${convert_bg(sens)}, CR: ${withoutZeros(round(profile.carb_ratio, 2))}, Target: ${convert_bg(target_bg)}, minPredBG ${convert_bg(minPredBG)}, minGuardBG ${convert_bg(minGuardBG)}, IOBpredBG ${convert_bg(lastIOBpredBG)}`;
  if (lastCOBpredBG != null) rT.reason += ', COBpredBG ' + convert_bg(lastCOBpredBG);
  if (lastUAMpredBG != null) rT.reason += ', UAMpredBG ' + convert_bg(lastUAMpredBG);
  rT.reason += '; ';
  // use naive_eventualBG if above 40, but switch to minGuardBG if both eventualBGs hit floor of 39
  let carbsReqBG = naive_eventualBG;
  if (carbsReqBG < 40) carbsReqBG = Math.min(minGuardBG, carbsReqBG);
  let bgUndershoot = threshold - carbsReqBG;
  // calculate how long until COB (or IOB) predBGs drop below min_bg
  let minutesAboveMinBG = 240;
  let minutesAboveThreshold = 240;
  const curve = meal_data.mealCOB > 0 && (ci > 0 || remainingCIpeak > 0) ? COBpredBGs : IOBpredBGs;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] < min_bg) { minutesAboveMinBG = 5 * i; break; }
  }
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] < threshold) { minutesAboveThreshold = 5 * i; break; }
  }

  if (enableSMB && minGuardBG < threshold) {
    consoleError.push(`minGuardBG ${convert_bg(minGuardBG)} projected below ${convert_bg(threshold)} - disabling SMB`);
    enableSMB = false;
  }
  // AutoISF: a full loop allows SMBs with deltas up to 30% of BG.
  const maxDeltaPercentage = autoIsf && input.loop_wanted_smb === 'fullLoop' ? 0.3 : 0.2;
  if (maxDelta > maxDeltaPercentage * bg) {
    const pct = autoIsf ? `${kd(100 * maxDeltaPercentage)}%` : '20%';
    consoleError.push(`maxDelta ${convert_bg(maxDelta)} > ${pct} of BG ${convert_bg(bg)} - disabling SMB`);
    rT.reason += 'maxDelta ' + convert_bg(maxDelta) + ' > ' + pct + ' of BG ' + convert_bg(bg) + ': SMB disabled; ';
    enableSMB = false;
  }

  consoleError.push(`BG projected to remain above ${convert_bg(min_bg)} for ${minutesAboveMinBG} minutes`);
  if (minutesAboveThreshold < 240 || minutesAboveMinBG < 60) {
    consoleError.push(`BG projected to remain above ${convert_bg(threshold)} for ${minutesAboveThreshold} minutes`);
  }
  // include at least minutesAboveThreshold worth of zero temps in calculating carbsReq
  // always include at least 30m worth of zero temp (carbs to 80, low temp up to target)
  const zeroTempDuration = minutesAboveThreshold;
  // BG undershoot, minus effect of zero temps until hitting min_bg, converted to grams, minus COB
  const zeroTempEffectDouble = profile.current_basal * sens * zeroTempDuration / 60;
  // don't count the last 25% of COB against carbsReq
  const COBforCarbsReq = Math.max(0.0, meal_data.mealCOB - 0.25 * meal_data.carbs);
  const carbsReq = round(((bgUndershoot - zeroTempEffectDouble) / csf - COBforCarbsReq));
  const zeroTempEffect = round(zeroTempEffectDouble);
  consoleError.push(`naive_eventualBG: ${kd(naive_eventualBG)} bgUndershoot: ${kd(bgUndershoot)} zeroTempDuration ${zeroTempDuration} zeroTempEffect: ${zeroTempEffect} carbsReq: ${carbsReq}`);
  if (carbsReq >= profile.carbsReqThreshold && minutesAboveThreshold <= 45) {
    rT.carbsReq = carbsReq;
    rT.carbsReqWithin = minutesAboveThreshold;
    rT.reason += `${carbsReq} add'l carbs req w/in ${minutesAboveThreshold}m; `;
  }

  // don't low glucose suspend if IOB is already super negative and BG is rising faster than predicted
  if (bg < threshold && iob_data.iob < -profile.current_basal * 20 / 60 && minDelta > 0 && minDelta > expectedDelta) {
    rT.reason += `IOB ${kd(iob_data.iob)} < ${kd(round(-profile.current_basal * 20 / 60, 2))}`;
    rT.reason += ` and minDelta ${convert_bg(minDelta)} > expectedDelta ${convert_bg(expectedDelta)}; `;
    // predictive low glucose suspend mode: BG is / is projected to be < threshold
  } else if (bg < threshold || minGuardBG < threshold) {
    rT.reason += `minGuardBG ${convert_bg(minGuardBG)} < ${convert_bg(threshold)}`;
    bgUndershoot = target_bg - minGuardBG;
    const worstCaseInsulinReq = bgUndershoot / sens;
    let durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);
    durationReq = round(durationReq / 30.0) * 30;
    // always set a 30-120m zero temp (oref0-pump-loop will let any longer SMB zero temp run)
    durationReq = Math.min(120, Math.max(30, durationReq));
    return setTempBasal(0.0, durationReq);
  }

  // if not in LGS mode, cancel temps before the top of the hour to reduce beeping/vibration
  const minutes = minuteOf(rT.deliverAt);
  if (profile.skip_neutral_temps && minutes >= 55) {
    rT.reason += '; Canceling temp at ' + minutes + 'm past the hour. ';
    return setTempBasal(0.0, 0);
  }

  if (eventualBG < min_bg) { // if eventual BG is below target:
    rT.reason += `Eventual BG ${convert_bg(eventualBG)} < ${convert_bg(min_bg)}`;
    // if 5m or 30m avg BG is rising faster than expected delta
    if (minDelta > expectedDelta && minDelta > 0 && carbsReq === 0) {
      // if naive_eventualBG < 40, set a 30m zero temp (oref0-pump-loop will let any longer SMB zero temp run)
      if (naive_eventualBG < 40) {
        rT.reason += ', naive_eventualBG < 40. ';
        return setTempBasal(0.0, 30);
      }
      if (glucose_status.delta > minDelta) {
        rT.reason += `, but Delta ${convert_bg(Number(tick))} > expectedDelta ${convert_bg(expectedDelta)}`;
      } else {
        rT.reason += `, but Min. Delta ${toFixed2(minDelta)} > Exp. Delta ${convert_bg(expectedDelta)}`;
      }
      if (currenttemp.duration > 15 && (round_basal(basal) === round_basal(currenttemp.rate))) {
        rT.reason += ', temp ' + kd(currenttemp.rate) + ' ~ req ' + withoutZeros(round(basal, 2)) + 'U/hr. ';
        return rT;
      } else {
        rT.reason += `; setting current basal of ${kd(round(basal, 2))} as temp. `;
        return setTempBasal(basal, 30);
      }
    }

    // calculate 30m low-temp required to get projected BG up to target
    // multiply by 2 to low-temp faster for increased hypo safety
    let insulinReq = dynIsfMode
      ? 2 * Math.min(0.0, (eventualBG - target_bg) / future_sens)
      : 2 * Math.min(0.0, (eventualBG - target_bg) / sens);
    insulinReq = round(insulinReq, 2);
    // calculate naiveInsulinReq based on naive_eventualBG
    let naiveInsulinReq = Math.min(0.0, (naive_eventualBG - target_bg) / sens);
    naiveInsulinReq = round(naiveInsulinReq, 2);
    if (minDelta < 0 && minDelta > expectedDelta) {
      // if we're barely falling, newinsulinReq should be barely negative
      insulinReq = round((insulinReq * (minDelta / expectedDelta)), 2);
    }
    // rate required to deliver insulinReq less insulin over 30m:
    let rate = basal + (2 * insulinReq);
    rate = round_basal(rate);

    // if required temp < existing temp basal
    const insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
    // if current temp would deliver a lot (30% of basal) less than the required insulin,
    // by both normal and naive calculations, then raise the rate
    const minInsulinReq = Math.min(insulinReq, naiveInsulinReq);
    if (insulinScheduled < minInsulinReq - basal * 0.3) {
      rT.reason += `, ${currenttemp.duration}m@${toFixed2(currenttemp.rate)} is a lot less than needed. `;
      return setTempBasal(rate, 30);
    }
    if (currenttemp.duration > 5 && rate >= currenttemp.rate * 0.8) {
      rT.reason += `, temp ${kd(currenttemp.rate)} ~< req ${kd(round(rate, 2))}U/hr. `;
      return rT;
    } else {
      // calculate a long enough zero temp to eventually correct back up to target
      if (rate <= 0) {
        bgUndershoot = (target_bg - naive_eventualBG);
        const worstCaseInsulinReq = bgUndershoot / sens;
        let durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);
        if (durationReq < 0) {
          durationReq = 0;
          // don't set a temp longer than 120 minutes
        } else {
          durationReq = round(durationReq / 30.0) * 30;
          durationReq = Math.min(120, Math.max(0, durationReq));
        }
        if (durationReq > 0) {
          rT.reason += `, setting ${durationReq}m zero temp. `;
          return setTempBasal(rate, durationReq);
        }
      } else {
        rT.reason += `, setting ${kd(round(rate, 2))}U/hr. `;
      }
      return setTempBasal(rate, 30);
    }
  }

  // if eventual BG is above min but BG is falling faster than expected Delta
  if (minDelta < expectedDelta) {
    // if in SMB mode, don't cancel SMB zero temp
    if (!(microBolusAllowed && enableSMB)) {
      if (glucose_status.delta < minDelta) {
        rT.reason += `Eventual BG ${convert_bg(eventualBG)} > ${convert_bg(min_bg)} but Delta ${convert_bg(Number(tick))} < Exp. Delta ${convert_bg(expectedDelta)}`;
      } else {
        rT.reason += `Eventual BG ${convert_bg(eventualBG)} > ${convert_bg(min_bg)} but Min. Delta ${toFixed2(minDelta)} < Exp. Delta ${convert_bg(expectedDelta)}`;
      }
      if (currenttemp.duration > 15 && (round_basal(basal) === round_basal(currenttemp.rate))) {
        rT.reason += ', temp ' + kd(currenttemp.rate) + ' ~ req ' + withoutZeros(round(basal, 2)) + 'U/hr. ';
        return rT;
      } else {
        rT.reason += `; setting current basal of ${kd(round(basal, 2))} as temp. `;
        return setTempBasal(basal, 30);
      }
    }
  }
  // eventualBG or minPredBG is below max_bg
  if (Math.min(eventualBG, minPredBG) < max_bg) {
    // if in SMB mode, don't cancel SMB zero temp
    if (!(microBolusAllowed && enableSMB)) {
      rT.reason += `${convert_bg(eventualBG)}-${convert_bg(minPredBG)} in range: no temp required`;
      if (currenttemp.duration > 15 && (round_basal(basal) === round_basal(currenttemp.rate))) {
        rT.reason += `, temp ${kd(currenttemp.rate)} ~ req ${withoutZeros(round(basal, 2))}U/hr. `;
        return rT;
      } else {
        rT.reason += `; setting current basal of ${kd(round(basal, 2))} as temp. `;
        return setTempBasal(basal, 30);
      }
    }
  }

  // eventual BG is at/above target
  // if iob is over max, just cancel any temps
  if (eventualBG >= max_bg) {
    rT.reason += 'Eventual BG ' + convert_bg(eventualBG) + ' >= ' + convert_bg(max_bg) + ', ';
  }
  if (iob_data.iob > max_iob) {
    rT.reason += `IOB ${kd(round(iob_data.iob, 2))} > max_iob ${kd(max_iob)}`;
    if (currenttemp.duration > 15 && (round_basal(basal) === round_basal(currenttemp.rate))) {
      rT.reason += `, temp ${kd(currenttemp.rate)} ~ req ${withoutZeros(round(basal, 2))}U/hr. `;
      return rT;
    } else {
      rT.reason += `; setting current basal of ${kd(round(basal, 2))} as temp. `;
      return setTempBasal(basal, 30);
    }
  } else { // otherwise, calculate 30m high-temp required to get projected BG down to target
    // insulinReq is the additional insulin required to get minPredBG down to target_bg
    let insulinReq = dynIsfMode
      ? round((Math.min(minPredBG, eventualBG) - target_bg) / future_sens, 2)
      : round((Math.min(minPredBG, eventualBG) - target_bg) / sens, 2);
    // if that would put us over max_iob, then reduce accordingly
    if (insulinReq > max_iob - iob_data.iob) {
      rT.reason += `max_iob ${kd(max_iob)}, `;
      insulinReq = max_iob - iob_data.iob;
    }

    // rate required to deliver insulinReq more insulin over 30m:
    let rate = basal + (2 * insulinReq);
    rate = round_basal(rate);
    insulinReq = round(insulinReq, 3);
    rT.insulinReq = insulinReq;
    // only allow microboluses with COB or low temp targets, or within DIA hours of a bolus
    let maxBolus;
    if (microBolusAllowed && enableSMB && bg > threshold) {
      // never bolus more than maxSMBBasalMinutes worth of basal
      const mealInsulinReq = round(meal_data.mealCOB / profile.carb_ratio, 3);
      // AutoISF: the SMB size limit stretched by smb_max_range_extension.
      const smb_max_range = autoIsf ? input.smb_max_range_extension : 1;
      if (iob_data.iob > mealInsulinReq && iob_data.iob > 0) {
        consoleError.push(`IOB ${kd(iob_data.iob)} > COB ${kd(meal_data.mealCOB)}; mealInsulinReq = ${kd(mealInsulinReq)}`);
        consoleError.push(`profile.maxUAMSMBBasalMinutes: ${profile.maxUAMSMBBasalMinutes} profile.current_basal: ${kd(profile.current_basal)}`);
        maxBolus = round(smb_max_range * profile.current_basal * profile.maxUAMSMBBasalMinutes / 60, 1);
      } else {
        consoleError.push(`profile.maxSMBBasalMinutes: ${profile.maxSMBBasalMinutes} profile.current_basal: ${kd(profile.current_basal)}`);
        maxBolus = round(smb_max_range * profile.current_basal * profile.maxSMBBasalMinutes / 60, 1);
      }
      // bolus 1/2 the insulinReq, up to maxBolus, rounding down to nearest bolus increment
      const roundSMBTo = 1 / profile.bolus_increment;
      let microBolus = Math.floor(Math.min(insulinReq / 2, maxBolus) * roundSMBTo) / roundSMBTo;
      if (autoIsf && variableIsf) {
        // AutoISF: its SMB delivery ratio instead of 1/2, capped at 130% of iobTH in a full loop.
        microBolus = Math.min(insulinReq * input.smb_ratio, maxBolus);
        if (microBolus > iobTHvirtual - iob_data.iob && (input.loop_wanted_smb === 'fullLoop' || input.loop_wanted_smb === 'enforced')) {
          microBolus = iobTHvirtual - iob_data.iob;
          consoleError.push(`Full loop capped SMB at ${kd(round(microBolus, 2))} to not exceed ${kd(iobTHtolerance)}% of effective iobTH ${kd(round(iobTHvirtual / iobTHtolerance * 100, 2))}U`);
        }
        microBolus = Math.floor(microBolus * roundSMBTo) / roundSMBTo;
      }
      // calculate a long enough zero temp to eventually correct back up to target
      const smbTarget = target_bg;
      const worstCaseInsulinReq = (smbTarget - (naive_eventualBG + minIOBPredBG) / 2.0) / sens;
      let durationReq = round(60 * worstCaseInsulinReq / profile.current_basal);

      // if insulinReq > 0 but not enough for a microBolus, don't set an SMB zero temp
      if (insulinReq > 0 && microBolus < profile.bolus_increment) durationReq = 0;

      let smbLowTempReq = 0.0;
      if (durationReq <= 0) {
        durationReq = 0;
        // don't set an SMB zero temp longer than 60 minutes
      } else if (durationReq >= 30) {
        durationReq = round(durationReq / 30.0) * 30;
        durationReq = Math.min(60, Math.max(0, durationReq));
      } else {
        // if SMB durationReq is less than 30m, set a nonzero low temp
        smbLowTempReq = round(basal * durationReq / 30.0, 2);
        durationReq = 30;
      }
      rT.reason += ` insulinReq ${kd(insulinReq)}`;
      if (microBolus >= maxBolus) rT.reason += `; maxBolus ${kd(maxBolus)}`;
      if (durationReq > 0) rT.reason += `; setting ${durationReq}m low temp of ${kd(smbLowTempReq)}U/h`;
      rT.reason += '. ';

      // seconds since last bolus
      const lastBolusAge = (systemTime - iob_data.lastBolusTime) / 1000.0;
      // allow SMBIntervals between 1 and 10 minutes
      const SMBInterval = Math.min(10, Math.max(1, profile.SMBInterval)) * 60.0; // in seconds
      consoleError.push(`naive_eventualBG ${kd(naive_eventualBG)},${durationReq}m ${kd(smbLowTempReq)}U/h temp needed; last bolus ${kd(round(lastBolusAge / 60.0, 1))}m ago; maxBolus: ${kd(maxBolus)}`);
      if (lastBolusAge > SMBInterval - 6.0) { // 6s tolerance
        if (microBolus > 0) {
          rT.units = microBolus;
          rT.reason += `Microbolusing ${kd(microBolus)}U. `;
        }
      } else {
        const nextBolusMins = (SMBInterval - lastBolusAge) / 60.0;
        const nextBolusSeconds = (SMBInterval - lastBolusAge) % 60;
        const waitingSeconds = round(nextBolusSeconds, 0) % 60;
        const waitingMins = round(nextBolusMins - waitingSeconds / 60.0, 0);
        rT.reason += `Waiting ${withoutZeros(waitingMins)}m ${withoutZeros(waitingSeconds)}s to microbolus again.`;
      }

      // if no zero temp is required, don't return yet; allow later code to set a high temp
      if (durationReq > 0) {
        rT.rate = smbLowTempReq;
        rT.duration = durationReq;
        return rT;
      }
    }

    const maxSafeBasal = getMaxSafeBasal();

    if (rate > maxSafeBasal) {
      rT.reason += `adj. req. rate: ${kd(round(rate, 2))} to maxSafeBasal: ${withoutZeros(maxSafeBasal)}, `;
      rate = round_basal(maxSafeBasal);
    }

    const insulinScheduled = currenttemp.duration * (currenttemp.rate - basal) / 60;
    if (insulinScheduled >= insulinReq * 2) { // if current temp would deliver >2x more than the required insulin, lower the rate
      rT.reason += `${currenttemp.duration}m@${toFixed2(currenttemp.rate)} > 2 * insulinReq. Setting temp basal of ${kd(round(rate, 2))}U/hr. `;
      return setTempBasal(rate, 30);
    }

    if (currenttemp.duration === 0) { // no temp is set
      rT.reason += 'no temp, setting ' + withoutZeros(round(rate, 2)) + 'U/hr. ';
      return setTempBasal(rate, 30);
    }

    if (currenttemp.duration > 5 && (round_basal(rate) <= round_basal(currenttemp.rate))) { // if required temp <~ existing temp basal
      rT.reason += `temp ${toFixed2(currenttemp.rate)} >~ req ${withoutZeros(round(rate, 2))}U/hr. `;
      return rT;
    }

    // required temp > existing temp basal
    rT.reason += `temp ${toFixed2(currenttemp.rate)} < ${withoutZeros(round(rate, 2))}U/hr. `;
    return setTempBasal(rate, 30);
  }
}
