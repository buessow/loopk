// Glucose as the loop sees it: readings put into 5-minute buckets, the
// deltas, and the glucose status determine_basal gets (with the parabola
// fit and dura_ISF for AutoISF).
//
// A port of AndroidAPS (AGPL-3.0), commit 423a4502f2:
// - plugins/main/.../iobCobCalculator/data/AutosensDataStoreObject.kt (bucketing)
// - plugins/aps/.../openAPS/DeltaCalculator.kt
// - plugins/aps/.../openAPSSMB/GlucoseStatusCalculatorSMB.kt
// - plugins/aps/.../openAPSAutoISF/GlucoseStatusCalculatorAutoIsf.kt
// - core/interfaces/.../utils/Round.kt (roundTo)
// Readings are { timestamp, value } in mg/dL. No smoothing: AAPS's
// "recalculated" value is the reading's value.

const MIN = 60000;
const IRREGULAR_DATA_MS = 30 * 1000;

/** Round.roundTo: the multiple of `step` nearest to x, as the exact decimal product. */
export function roundTo (x, step) {
  if (Number.isNaN(x)) throw new Error('roundTo: NaN');
  if (x === 0) return 0;
  const n = Math.round(x / step); // roundToLong: ties toward +∞
  let digits = DECIMALS.get(step);
  if (digits === undefined) DECIMALS.set(step, digits = (String(step).split('.')[1] || '').length);
  // n × step to the step's decimals is the exact decimal product while it is far below 2^53
  if (Math.abs(n) < 1e12) return Number((n * step).toFixed(digits));
  const [int, frac = ''] = String(step).split('.');
  return Number(`${BigInt(n) * BigInt(int + frac)}e-${frac.length}`);
}
const DECIMALS = new Map();

/** The bucket store of one loop run: AutosensDataStoreObject's bucketing. */
export class BucketStore {
  /** `referenceTime`: the time the 5-minute grid is aligned to (AAPS: its first bucketing). */
  constructor (referenceTime = -1) {
    this.referenceTime = referenceTime;
  }

  adjustToReferenceTime (someTime) {
    if (this.referenceTime === -1) {
      this.referenceTime = someTime;
      return someTime;
    }
    let diff = Math.abs(someTime - this.referenceTime);
    diff %= 5 * MIN;
    return diff > 2.5 * MIN ? someTime + Math.abs(diff - 5 * MIN) : someTime - diff;
  }

  /** `bgReadings`: newest first. Returns the bucketed data, newest first, or null. */
  bucket (bgReadings) {
    this.bgReadings = bgReadings;
    this.mode = '5min';
    return isAbout5minData(bgReadings) ? this.bucket5min() : this.bucketRecalculated();
  }

  findNewer (time) {
    const r = this.bgReadings;
    let lastFound = r[0];
    if (lastFound.timestamp < time) return null;
    for (let i = 1; i < r.length; i++) {
      if (r[i].timestamp === time) return r[i];
      if (r[i].timestamp > time) continue;
      lastFound = r[i - 1];
      if (r[i].timestamp < time) break;
    }
    return lastFound;
  }

  findOlder (time) {
    const r = this.bgReadings;
    let lastFound = r[r.length - 1];
    if (lastFound.timestamp > time) return null;
    for (let i = r.length - 2; i >= 0; i--) {
      if (r[i].timestamp === time) return r[i];
      if (r[i].timestamp < time) continue;
      lastFound = r[i + 1];
      if (r[i].timestamp > time) break;
    }
    return lastFound;
  }

  bucketRecalculated () {
    const r = this.bgReadings;
    this.mode = 'recalculated';
    if (r.length < 3) return null;
    const out = [];
    let currentTime = r[0].timestamp;
    const adjustedTime = this.adjustToReferenceTime(currentTime);
    // after adjusting time may be newer. In this case use T-5min
    currentTime = adjustedTime > currentTime ? adjustedTime - 5 * MIN : adjustedTime;
    for (;;) {
      const newer = this.findNewer(currentTime);
      const older = this.findOlder(currentTime);
      if (newer == null || older == null) break;
      if (older.timestamp === newer.timestamp) { // direct hit
        out.push({ timestamp: currentTime, value: newer.value, filledGap: false });
      } else {
        const bgDelta = newer.value - older.value;
        const timeDiffToNew = newer.timestamp - currentTime;
        const timeDiffToOlder = currentTime - older.timestamp;
        const filledGap = Math.min(timeDiffToOlder, timeDiffToNew) > IRREGULAR_DATA_MS;
        const currentBg = newer.value - timeDiffToNew / (newer.timestamp - older.timestamp) * bgDelta;
        out.push({ timestamp: currentTime, value: Math.round(currentBg), filledGap });
      }
      currentTime -= 5 * MIN;
    }
    return out;
  }

  bucket5min () {
    const r = this.bgReadings;
    if (r.length < 3) return null;
    const bData = [{ timestamp: r[0].timestamp, value: r[0].value, filledGap: false }];
    let j = 0;
    for (let i = 1; i < r.length; i++) {
      const bgTime = r[i].timestamp;
      let lastBgTime = r[i - 1].timestamp;
      let elapsedMinutes = Math.trunc((bgTime - lastBgTime) / MIN);
      if (Math.abs(elapsedMinutes) > 8) {
        // interpolate missing data points
        let lastBgValue = r[i - 1].value;
        elapsedMinutes = Math.abs(elapsedMinutes);
        while (elapsedMinutes > 5) {
          const nextBgTime = lastBgTime - 5 * MIN;
          j++;
          const gapDelta = r[i].value - lastBgValue;
          const nextBg = lastBgValue + 5.0 / elapsedMinutes * gapDelta;
          bData.push({ timestamp: nextBgTime, value: Math.round(nextBg), filledGap: true });
          elapsedMinutes -= 5;
          lastBgValue = nextBg;
          lastBgTime = nextBgTime;
        }
        j++;
        bData.push({ timestamp: bgTime, value: r[i].value, filledGap: false });
      } else if (Math.abs(elapsedMinutes) > 2) {
        j++;
        bData.push({ timestamp: bgTime, value: r[i].value, filledGap: false });
      } else {
        bData[j].value = (bData[j].value + r[i].value) / 2;
      }
    }
    // Normalize bucketed data
    const oldest = bData[bData.length - 1];
    oldest.timestamp = this.adjustToReferenceTime(oldest.timestamp);
    for (let i = bData.length - 2; i >= 0; i--) {
      const current = bData[i];
      const previous = bData[i + 1];
      const adjusted = Math.trunc((current.timestamp - previous.timestamp - 5 * MIN) / 1000);
      if (Math.abs(adjusted) > 90) {
        // too big adjustment, fallback to non 5 min data
        return this.bucketRecalculated();
      }
      current.timestamp = previous.timestamp + 5 * MIN;
    }
    return bData;
  }
}

/** Whether readings (newest first) come every 5 minutes, within 30 s. */
export function isAbout5minData (bgReadings) {
  if (bgReadings.length < 3) return true;
  let totalDiff = 0;
  for (let i = 1; i < bgReadings.length; i++) {
    let diff = (bgReadings[i - 1].timestamp - bgReadings[i].timestamp) % (5 * MIN);
    if (diff > 2.5 * MIN) diff -= 5 * MIN;
    totalDiff += diff;
    if (Math.abs(diff) > IRREGULAR_DATA_MS) return false;
  }
  // Long division in Kotlin: truncates toward zero.
  const averageDiff = Math.trunc(Math.trunc(totalDiff / bgReadings.length) / 1000);
  return averageDiff < 1;
}

const average = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0.0);

/** DeltaCalculator.calculateDeltas over bucketed data (newest first). */
export function calculateDeltas (data) {
  if (data.length < 2) return { delta: 0.0, shortAvgDelta: 0.0, longAvgDelta: 0.0 };
  const lastDeltas = [];
  const shortDeltas = [];
  const longDeltas = [];
  const now = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i].value > 39.0) {
      const then = data[i];
      const minutesAgo = (now.timestamp - then.timestamp) / MIN;
      const avgDel = (now.value - then.value) / minutesAgo * 5;
      if (minutesAgo >= 2.5 && minutesAgo <= 7.5) lastDeltas.push(avgDel);
      if (minutesAgo >= 2.5 && minutesAgo <= 17.5) shortDeltas.push(avgDel);
      if (minutesAgo >= 17.5 && minutesAgo <= 42.5) longDeltas.push(avgDel);
      else if (minutesAgo > 42.5) break;
    }
  }
  const shortAvgDelta = average(shortDeltas);
  return {
    delta: lastDeltas.length ? average(lastDeltas) : shortAvgDelta,
    shortAvgDelta,
    longAvgDelta: average(longDeltas),
  };
}

/**
 * The SMB glucose status from bucketed data (newest first), rounded as
 * asRounded() does; null without data.
 */
export function glucoseStatusSMB (data) {
  if (!data || !data.length) return null;
  const now = data[0];
  const d = data.length === 1 ? { delta: 0, shortAvgDelta: 0, longAvgDelta: 0 } : calculateDeltas(data);
  return {
    glucose: roundTo(now.value, 0.1),
    noise: 0.0,
    delta: roundTo(d.delta, 0.01),
    shortAvgDelta: roundTo(d.shortAvgDelta, 0.01),
    longAvgDelta: roundTo(d.longAvgDelta, 0.01),
    date: now.timestamp,
  };
}

/** The AutoISF glucose status: the SMB one plus dura_ISF and the parabola fit. */
export function glucoseStatusAutoIsf (data) {
  if (!data || !data.length) return null;
  const now = data[0];
  const nowDate = now.timestamp;
  if (data.length === 1) {
    return {
      ...glucoseStatusSMB(data),
      duraISFminutes: 0.0, duraISFaverage: roundTo(now.value, 0.1), parabolaMinutes: 0.0, deltaPl: 0.0, deltaPn: 0.0,
      bgAcceleration: 0.0, a0: roundTo(now.value, 0.1), a1: 0.0, a2: 0.0, corrSqu: 0.0,
    };
  }
  // calculate 2 variables for 5% range; still using 5 minute data
  const bw = 0.05;
  let sumBG = now.value;
  let oldAvg = sumBG;
  let minutesDur = 0;
  let n = 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i].value > 39 && !data[i].filledGap) {
      n += 1;
      const then = data[i];
      // stop the series if there was a CGM gap greater than 13 minutes, i.e. 2 regular readings
      if (Math.round((nowDate - then.timestamp) / MIN) - minutesDur > 13) break;
      if (then.value > oldAvg * (1 - bw) && then.value < oldAvg * (1 + bw)) {
        sumBG += then.value;
        oldAvg = sumBG / n;
        minutesDur = Math.round((nowDate - then.timestamp) / MIN);
      } else {
        break;
      }
    }
  }

  // best parabola through the last 47.5 minutes, extended 5 minutes ahead
  let duraP = 0.0;
  let deltaPl = 0.0;
  let deltaPn = 0.0;
  let bgAcceleration = 0.0;
  let corrMax = 0.0;
  let a0 = 0.0;
  let a1 = 0.0;
  let a2 = 0.0;
  if (data.length > 3) {
    let sy = 0.0;
    let sx = 0.0;
    let sx2 = 0.0;
    let sx3 = 0.0;
    let sx4 = 0.0;
    let sxy = 0.0;
    let sx2y = 0.0;
    const time0 = data[0].timestamp;
    let tiLast = 0.0;
    const scaleTime = 300.0; // in 5m; values are 0, -1, -2, -3, -4, ...
    const scaleBg = 50.0;
    let m = 0;
    for (let i = 0; i < data.length; i++) {
      if (!(data[i].value > 39 && !data[i].filledGap)) continue;
      m += 1;
      const bg = data[i].value / scaleBg;
      const ti = (data[i].timestamp - time0) / 1000.0 / scaleTime;
      if (-ti * scaleTime > 47 * 60) { // skip records older than 47.5 minutes
        break;
      } else if (ti < tiLast - 11.0 * 60 / scaleTime) { // stop scan if a CGM gap > 11 minutes is detected
        if (i < 3) { // history too short for fit
          duraP = -tiLast * scaleTime / 60.0;
          deltaPl = 0.0;
          deltaPn = 0.0;
          bgAcceleration = 0.0;
          corrMax = 0.0;
          a0 = 0.0;
          a1 = 0.0;
          a2 = 0.0;
        }
        break;
      }
      tiLast = ti;
      sx += ti;
      sx2 += ti ** 2;
      sx3 += ti ** 3;
      sx4 += ti ** 4;
      sy += bg;
      sxy += ti * bg;
      sx2y += ti ** 2 * bg;
      let detH = 0.0;
      let detA = 0.0;
      let detB = 0.0;
      let detC = 0.0;
      if (m > 3) {
        detH = sx4 * (sx2 * m - sx * sx) - sx3 * (sx3 * m - sx * sx2) + sx2 * (sx3 * sx - sx2 * sx2);
        detA = sx2y * (sx2 * m - sx * sx) - sxy * (sx3 * m - sx * sx2) + sy * (sx3 * sx - sx2 * sx2);
        detB = sx4 * (sxy * m - sy * sx) - sx3 * (sx2y * m - sy * sx2) + sx2 * (sx2y * sx - sxy * sx2);
        detC = sx4 * (sx2 * sy - sx * sxy) - sx3 * (sx3 * sy - sx * sx2y) + sx2 * (sx3 * sxy - sx2 * sx2y);
      }
      if (detH !== 0.0) {
        const a = detA / detH;
        const b = detB / detH;
        const c = detC / detH;
        const yMean = sy / m;
        let sSquares = 0.0;
        let sResidualSquares = 0.0;
        for (let j = 0; j <= i; j++) {
          const before = data[j];
          sSquares += (before.value / scaleBg - yMean) ** 2;
          const deltaT = (before.timestamp - time0) / 1000.0 / scaleTime;
          const bgj = a * deltaT ** 2 + b * deltaT + c;
          sResidualSquares += (before.value / scaleBg - bgj) ** 2;
        }
        let rSqu = 0.64;
        if (sSquares !== 0.0) rSqu = 1 - sResidualSquares / sSquares;
        if (rSqu >= corrMax) {
          corrMax = rSqu;
          duraP = -ti * scaleTime / 60.0; // remember we are going backwards in time
          const delta5Min = 5 * 60 / scaleTime;
          deltaPl = -scaleBg * (a * (-delta5Min) ** 2 - b * delta5Min);
          deltaPn = scaleBg * (a * delta5Min ** 2 + b * delta5Min);
          bgAcceleration = 2 * a * scaleBg;
          a0 = c * scaleBg;
          a1 = b * scaleBg;
          a2 = a * scaleBg;
        }
      }
    }
  }
  const zeroOr = (v, step) => (v === 0 ? 0 : roundTo(v, step));
  return {
    ...glucoseStatusSMB(data),
    duraISFminutes: zeroOr(minutesDur, 0.1),
    duraISFaverage: roundTo(oldAvg, 0.1),
    parabolaMinutes: zeroOr(duraP, 0.1),
    deltaPl,
    deltaPn,
    corrSqu: zeroOr(corrMax, 0.0001),
    bgAcceleration,
    a0: zeroOr(a0, 0.1),
    a1: zeroOr(a1, 0.01),
    a2: zeroOr(a2, 0.01),
  };
}
