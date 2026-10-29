// Number formatting and rounding as AAPS's Kotlin code does it, so the ported
// algorithms write the same reason text and round the same way.
//
// AndroidAPS (AGPL-3.0), commit 423a4502f2:
// plugins/aps/.../openAPSSMB/DetermineBasalSMB.kt (round, withoutZeros, toFixed2)
// implementation/.../profile/ProfileUtilImpl.kt (convert_bg via toUnitsString)

export const MMOLL_TO_MGDL = 18.0;
export const MGDL_TO_MMOLL = 1 / MMOLL_TO_MGDL;

/**
 * Kotlin's round(value, digits): Math.round(value * 10^digits) / 10^digits.
 * Java's Math.round gives a whole number, so −0.3 rounds to 0, not to
 * JavaScript's −0 (which DecimalFormat would write "-0"); + 0 makes it 0.
 */
export function round (value, digits = null) {
  if (digits == null) return Math.round(value) + 0; // value.roundToInt(): ties toward +∞
  if (Number.isNaN(value)) return NaN;
  const scale = 10 ** digits;
  return (Math.round(value * scale) + 0) / scale;
}

/**
 * java.text.DecimalFormat with `minFrac`..`maxFrac` fraction digits and its
 * default HALF_EVEN rounding of the exact binary value: "0.##" is (0, 2),
 * "0.0" is (1, 1), "0" is (0, 0).
 */
export function decimalFormat (value, minFrac, maxFrac) {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const negative = value < 0 || Object.is(value, -0);
  // The exact decimal expansion (doubles in this range need far fewer than 100 digits).
  const exact = Math.abs(value).toFixed(100);
  const [int, frac] = exact.split('.');
  let digits = int + frac.slice(0, maxFrac);
  const rest = frac.slice(maxFrac);
  const first = rest[0];
  const beyond = /[1-9]/.test(rest.slice(1));
  const last = Number(digits[digits.length - 1]);
  const up = first > '5' || (first === '5' && (beyond || last % 2 === 1));
  if (up) {
    const arr = digits.split('').map(Number);
    let i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === 9) { arr[i] = 0; i--; } else { arr[i]++; break; }
    }
    if (i < 0) arr.unshift(1);
    digits = arr.join('');
  }
  let intPart = digits.slice(0, digits.length - maxFrac) || '0';
  let fracPart = digits.slice(digits.length - maxFrac);
  intPart = intPart.replace(/^0+(?=\d)/, '');
  while (fracPart.length > minFrac && fracPart.endsWith('0')) fracPart = fracPart.slice(0, -1);
  return (negative ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
}

/** Kotlin's Double.toString ("$value" in a string template): 1.0, 0.25, 1.0E-4. */
export function kd (value) {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const a = Math.abs(value);
  if (a >= 1e-3 && a < 1e7) {
    const s = String(value);
    return s.includes('.') ? s : s + '.0';
  }
  const [m, e] = value.toExponential().split('e');
  return (m.includes('.') ? m : m + '.0') + 'E' + Number(e);
}

/** DecimalFormat("0.##"): Kotlin's withoutZeros(). */
export const withoutZeros = (v) => decimalFormat(v, 0, 2);
/** DecimalFormat("0.00#") of round(v, 2): Kotlin's toFixed2(). */
export const toFixed2 = (v) => decimalFormat(round(v, 2), 2, 3);

/** convert_bg: mg/dL as text in the output units, "-0.0" written "0.0". */
export function convertBg (value, units) {
  const s = units === 'mmol/L' ? decimalFormat(value * MGDL_TO_MMOLL, 1, 1) : decimalFormat(value, 0, 0);
  return s.replace('-0.0', '0.0');
}
