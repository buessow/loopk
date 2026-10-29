import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BucketStore, roundTo } from '../src/oref/glucose.js';
import { doubledReadings, enteredLate, plannedTempDurations, tempTargetAt } from '../src/oref/inputs.js';
import { PhoneClock, secondsFromMidnight } from '../src/oref/profile.js';
import { sameAction } from '../src/oref/replay.js';
import { DEFAULTS, fromAapsPreferences, inferSettings, validSetting } from '../src/oref/settings.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const T = Date.UTC(2026, 9, 20, 12);

test('roundTo rounds to the step as AAPS does, ties up', () => {
  assert.equal(roundTo(0.125, 0.05), 0.15);
  assert.equal(roundTo(1.234, 0.01), 1.23);
  assert.equal(roundTo(-0.025, 0.05), 0);
  assert.equal(roundTo(2.5, 1), 3);
  assert.equal(roundTo(0.1 + 0.2, 0.1), 0.3);
  assert.equal(roundTo(0, 0.05), 0);
  assert.throws(() => roundTo(NaN, 0.1));
});

test('two readings within 20 seconds among the newest put the loop at max IOB 0', () => {
  const readings = (gaps) => {
    let t = T;
    return gaps.map((g) => ({ timestamp: (t -= g) }));
  };
  assert.equal(doubledReadings(readings([0, 300000, 300000, 300000, 300000])), false);
  assert.equal(doubledReadings(readings([0, 300000, 15000, 300000, 300000])), true);
});

test('the temp target at a time is the latest set before it, while it runs', () => {
  const targets = [{ timestamp: T, duration: HOUR, low: 140, high: 140 }, { timestamp: T + 2 * HOUR, duration: 0, low: 0, high: 0 }];
  assert.equal(tempTargetAt(targets, T - 1), null);
  assert.equal(tempTargetAt(targets, T + 30 * MIN).low, 140);
  assert.equal(tempTargetAt(targets, T + HOUR), null);
  assert.equal(tempTargetAt(targets, T + 2 * HOUR), null);
});

test('temps get the duration the run that set them planned, or 30 minutes when cut', () => {
  const temps = [
    { timestamp: T, duration: 10 * MIN, rate: 2 },
    { timestamp: T + 10 * MIN, duration: 5 * MIN, rate: 0 },
    { timestamp: T + 15 * MIN, duration: 20 * MIN, rate: 1 },
  ];
  const runs = [{ timestamp: T - 20 * 1000, rate: 2, duration: 30 }, { timestamp: T + 15 * MIN + 5000, rate: 1, duration: 120 }];
  plannedTempDurations(temps, runs);
  assert.deepEqual(temps.map((t) => t.planned), [30 * MIN, 30 * MIN, 120 * MIN]);
});

test('a treatment uploaded late while the phone uploaded promptly was entered late', () => {
  const prompt = [T + 2 * MIN, T + 7 * MIN, T + 12 * MIN, T + 17 * MIN];
  const known = enteredLate(prompt);
  // entered 20 minutes after its time: AAPS knew of it from then
  assert.equal(known(T, T + 20 * MIN), T + 20 * MIN);
  // uploaded within 5 minutes: known at its time
  assert.equal(known(T, T + 4 * MIN), T);
  // nothing else uploaded meanwhile: the phone was offline, AAPS knew of it at its time
  assert.equal(enteredLate([])(T, T + 20 * MIN), T);
  assert.equal(known(T, null), T);
});

test('the phone clock follows the offsets AAPS wrote, changing on the half hour', () => {
  // daylight saving ends at 01:00 UTC: temps at 00:50 (+120) and 01:10 (+60)
  const clock = new PhoneClock([
    { timestamp: T - 12 * HOUR, offset: 120 }, { timestamp: T - 11 * HOUR + 50 * MIN, offset: 120 },
    { timestamp: T - 11 * HOUR + 70 * MIN, offset: null }, { timestamp: T - 10 * HOUR + 10 * MIN, offset: 60 },
  ]);
  assert.equal(clock.offsetAt(T - 24 * HOUR), 120);
  assert.equal(clock.offsetAt(T - 10 * HOUR - 1), 120);
  assert.equal(clock.offsetAt(T - 10 * HOUR), 60);
  assert.equal(clock.offsetAt(T), 60);
  assert.equal(secondsFromMidnight(T, clock), 13 * 3600);
  assert.equal(new PhoneClock([{ timestamp: T, offset: null }]).empty, true);
});

test('two decisions dose the same with the same temp and SMB, within rounding', () => {
  assert.equal(sameAction({ rate: 1, duration: 30, units: 0.5 }, { rate: 1.02, duration: 30, units: 0.5 }), true);
  assert.equal(sameAction({ rate: 1, duration: 30, units: 0.5 }, { rate: 1, duration: 30, units: 0.6 }), false);
  assert.equal(sameAction({ rate: null, units: 0 }, { units: null }), true);
  assert.equal(sameAction({ rate: 0, duration: 30 }, { rate: null }), false);
});

test('irregular readings are bucketed on a grid through the newest one', () => {
  // AAPS's store forgets its reference time with each calculation
  const readings = [
    { timestamp: T + 1000, value: 176 }, { timestamp: T - 5 * MIN + 45000, value: 170 },
    { timestamp: T - 10 * MIN + 44000, value: 160 }, { timestamp: T - 15 * MIN + 46000, value: 150 },
  ];
  const store = new BucketStore();
  const bucketed = store.bucket(readings);
  assert.equal(store.mode, 'recalculated');
  assert.deepEqual(bucketed.map((b) => b.timestamp), [T + 1000, T - 5 * MIN + 1000, T - 10 * MIN + 1000]);
  assert.equal(bucketed[0].value, 176);
  assert.equal(bucketed[1].value, 169);
});

test('settings come from the configuration and the loop logs, else AAPS defaults', () => {
  const config = { insulin: 'LYUMJEV', sensitivity_settings: { autosens_min: 0.7, autosens_max: 1.2, openaps_smb_min_5m_carbimpact: 8 } };
  const runs = [
    { timestamp: T, reason: 'max_iob 7, maxSafeBasal: 3.2', console: ['profile.maxSMBBasalMinutes: 60', 'SMB enabled due to enableSMB_always'] },
    { timestamp: T + 5 * MIN, reason: 'max_iob 0', console: ['profile.maxSMBBasalMinutes: 60'] },
  ];
  const { values, sources } = inferSettings(config, runs);
  assert.equal(values.autosensMax, 1.2);
  assert.equal(sources.autosensMax, 'configuration');
  assert.equal(values.maxSMBBasalMinutes, 60);
  assert.equal(sources.maxSMBBasalMinutes, 'console');
  // 0 is the duplicate-reading limit, not the setting
  assert.equal(values.max_iob, 7);
  assert.equal(values.enableSMB_always, true);
  assert.equal(values.maxUAMSMBBasalMinutes, DEFAULTS.maxUAMSMBBasalMinutes);
  assert.equal(sources.maxUAMSMBBasalMinutes, 'default');
});

test('setting values must match their defaults\' types', () => {
  assert.equal(validSetting('max_iob', 5), true);
  assert.equal(validSetting('max_iob', '5'), false);
  assert.equal(validSetting('enableUAM', false), true);
  assert.equal(validSetting('enableUAM', 1), false);
  assert.equal(validSetting('lgsThreshold', null), true);
  assert.equal(validSetting('nonsense', 1), false);
  // steps the code divides by
  assert.equal(validSetting('bolus_increment', 0), false);
  assert.equal(validSetting('bolus_increment', 0.1), true);
});

test('AAPS preferences become the settings the algorithm gets', () => {
  const prefs = {
    openapsmb_max_iob: '10.0', smbmaxminutes: '60', use_uam: 'true', enableSMB_always: 'true', enableSMB_after_carbs: 'true',
    enableSMB_with_high_temptarget: 'false', lgsThreshold: '70.2', high_temptarget_raises_sensitivity: true, autoISF_max: '1.0', unrelated: 'x',
  };
  assert.deepEqual(fromAapsPreferences(prefs), {
    max_iob: 10, maxSMBBasalMinutes: 60, enableUAM: true, enableSMB_always: true, enableSMB_after_carbs: true,
    allowSMB_with_high_temptarget: false, lgsThreshold: 70, highTemptargetRaisesSensitivity: true, autoISF_max: 1,
  });
  // in mmol/L, and without advanced filtering SMB always and after carbs are off
  const plain = fromAapsPreferences({ lgsThreshold: '3.9', enableSMB_always: 'true', enableSMB_after_carbs: 'true' }, { advancedFiltering: false });
  assert.deepEqual(plain, { lgsThreshold: 70, enableSMB_always: false, enableSMB_after_carbs: false });
});
