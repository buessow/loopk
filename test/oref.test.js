import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoIsfSens, orefCases } from './orefcases.js';
import { determineBasal } from '../src/oref/determinebasal.js';
import { determineVarSmbRatio, interpolate, loopSmb } from '../src/oref/autoisf.js';
import { convertBg, decimalFormat, kd, round, toFixed2, withoutZeros } from '../src/oref/format.js';

// The fields AAPS's ReplayApsResultsTest compares between its Kotlin port and
// the JavaScript oref1 (the reason text is worded differently in Kotlin).
const FIELDS = ['tick', 'eventualBG', 'targetBG', 'insulinReq', 'carbsReq', 'carbsReqWithin', 'units',
  'sensitivityRatio', 'duration', 'rate', 'COB', 'IOB'];
const CURVES = ['IOB', 'ZT', 'COB', 'UAM'];

// Cases where Kotlin AAPS (and so the port) decides differently from the
// JavaScript that wrote the expected output: AutoISF's naive eventual BG
// uses the AutoISF sensitivity also for negative IOB, where JavaScript took
// the lower of it and the profile ISF.
const KOTLIN_CHANGES = {
  '2024-01-05_114747.json': { eventualBG: 104 },
  '2024-01-05_115511.json': { eventualBG: 149 },
};

function comparable (field, value) {
  if (['carbsReq', 'carbsReqWithin', 'duration'].includes(field)) return value ?? 0;
  if (field === 'tick') return String(value ?? '');
  return value ?? null;
}

const cases = orefCases();

test('the fixtures cover SMB, Dynamic ISF and AutoISF', () => {
  const count = (a) => cases.filter((c) => c.algorithm === a).length;
  assert.equal(count('OpenAPSSMBPlugin'), 16);
  assert.equal(count('OpenAPSSMBDynamicISFPlugin'), 44);
  assert.equal(count('OpenAPSSMBAutoISFPlugin'), 22);
});

for (const c of cases) {
  test(`determine_basal matches AAPS for ${c.algorithm} ${c.file}`, () => {
    const result = determineBasal(c.input, { autoIsf: c.autoIsf });
    const expected = { ...c.output, ...KOTLIN_CHANGES[c.file] };
    const fields = c.dyn || (c.autoIsf && c.output.variable_sens != null) ? [...FIELDS, 'variable_sens'] : FIELDS;
    for (const field of fields) {
      assert.equal(comparable(field, result[field]), comparable(field, expected[field]), field);
    }
    for (const curve of CURVES) {
      assert.deepEqual(result.predBGs[curve], c.output.predBGs?.[curve], `predBGs.${curve}`);
    }
  });
}

test('the AutoISF sensitivity matches AAPS', () => {
  const withSens = cases.filter((c) => c.autoIsf && c.output.variable_sens != null);
  assert.ok(withSens.length >= 10);
  for (const c of withSens) assert.equal(autoIsfSens(c.raw), c.output.variable_sens, c.file);
  // Older cases only show the ISF, rounded, in the reason.
  for (const c of cases.filter((x) => x.autoIsf && x.output.variable_sens == null)) {
    const shown = Number(/ISF: ([\d.]+)/.exec(c.output.reason)[1]);
    assert.equal(Math.round(autoIsfSens(c.raw)), shown, c.file);
  }
});

test('reasons read as AAPS writes them', () => {
  const c = cases.find((x) => x.file === '2023-10-28_133013.json');
  const result = determineBasal(c.input);
  assert.equal(result.reason, c.output.reason);
  // Kotlin's wording where it differs from JavaScript.
  const low = determineBasal(cases.find((x) => x.file === '2023-10-28_134014.json').input);
  assert.match(low.reason, /minGuardBG -3\.4 < 3\.9$/);
});

test('numbers are formatted as Kotlin and Java do', () => {
  assert.deepEqual([1, 0.25, -2, 0, 1e-4, 153.5].map(kd), ['1.0', '0.25', '-2.0', '0.0', '1.0E-4', '153.5']);
  // DecimalFormat rounds half to even on the exact binary value.
  assert.equal(decimalFormat(0.125, 0, 2), '0.12');
  assert.equal(decimalFormat(0.375, 0, 2), '0.38');
  assert.equal(decimalFormat(2.675, 0, 2), '2.67');
  assert.equal(withoutZeros(1), '1');
  assert.equal(withoutZeros(0.935), '0.94');
  assert.equal(toFixed2(0), '0.00');
  assert.equal(toFixed2(-10.5), '-10.50');
  assert.equal(convertBg(128.7, 'mmol/L'), '7.1');
  assert.equal(convertBg(-0.5, 'mmol/L'), '0.0');
  assert.equal(convertBg(98.5, 'mg/dL'), '98');
  assert.equal(round(2.5), 3);
  assert.equal(round(-2.5), -2);
  assert.equal(round(1.005, 2), 1);
});

const AUTOISF_SETTINGS = {
  lower_ISFrange_weight: 1, higher_ISFrange_weight: 1,
  smb_delivery_ratio: 0.5, smb_delivery_ratio_min: 0.6, smb_delivery_ratio_max: 0.9, smb_delivery_ratio_bg_range: 0,
  enableSMB_EvenOn_OddOff_always: true, iob_threshold_percent: 100,
};

test('AutoISF interpolates its glucose factor over the polygon', () => {
  assert.equal(interpolate(100, AUTOISF_SETTINGS), 0);
  assert.equal(interpolate(130, AUTOISF_SETTINGS), 0.25);
  assert.equal(interpolate(40, AUTOISF_SETTINGS), -0.5);
  assert.ok(Math.abs(interpolate(220, AUTOISF_SETTINGS) - 0.7) < 1e-12);
  assert.equal(interpolate(130, { ...AUTOISF_SETTINGS, higher_ISFrange_weight: 2 }), 0.5);
});

test('AutoISF lets an even target enable SMBs and an odd one block them', () => {
  const run = (target_bg, out_units = 'mg/dL') =>
    loopSmb({ microBolusAllowed: true, profile: { max_iob: 3, target_bg, out_units }, iob_data_iob: 0, useIobTh: false, iobThEffective: 0, settings: AUTOISF_SETTINGS });
  assert.equal(run(90), 'fullLoop');
  assert.equal(run(110), 'enforced');
  assert.equal(run(91), 'blocked');
  assert.equal(run(99, 'mmol/L'), 'blocked'); // 5.5 mmol/L: odd tenths
  assert.equal(run(97.2, 'mmol/L'), 'fullLoop'); // 5.4 mmol/L
  assert.equal(loopSmb({ microBolusAllowed: false, profile: { max_iob: 3, target_bg: 90 }, settings: AUTOISF_SETTINGS }), 'AAPS');
  assert.equal(loopSmb({ microBolusAllowed: true, profile: { max_iob: 3, target_bg: 90 }, settings: { ...AUTOISF_SETTINGS, enableSMB_EvenOn_OddOff_always: false } }), 'AAPS');
});

test('AutoISF raises the SMB ratio with glucose above target', () => {
  const settings = { ...AUTOISF_SETTINGS, smb_delivery_ratio_bg_range: 40 };
  const ratio = (bg, loop_wanted_smb = 'AAPS', s = settings) => determineVarSmbRatio({ bg, target_bg: 100, loop_wanted_smb, settings: s });
  assert.equal(ratio(90), 0.6);
  assert.ok(Math.abs(ratio(120) - 0.75) < 1e-12);
  assert.equal(ratio(150), 0.9);
  assert.equal(ratio(150, 'AAPS', AUTOISF_SETTINGS), 0.5);
  assert.equal(ratio(90, 'fullLoop'), 0.6);
});
