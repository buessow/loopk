// Fills a Nightscout with made-up data in the shapes AAPS uploads, for
// testing without anyone's health data: a profile (stored, switched to and in
// effect), CGM readings every 5 minutes, meals with their boluses, snacks,
// rescue carbs, walks with an activity temp target, site changes, and a
// simple SMB loop that sets temp basals and SMBs and writes its device
// status (IOB, COB, predictions).
// Glucose follows a small model: insulin acts on an exponential curve, the
// carbs eaten differ from the carbs entered, and the body's basal need drifts
// (with a dawn rise), so the loop has something to correct.
//
//   [TARGET_URL=… TARGET_TOKEN=…] [SEED=1] \
//     node scripts/nightscout-fake.js [days=14] [--replace] [--dry-run]
//
// TARGET_URL defaults to the test Nightscout (NS_URL in .cache/nightscout.env)
// and TARGET_TOKEN to its NS_ADMIN_TOKEN.
// --replace first deletes the entries, treatments, device status and
// profiles of the test Nightscout's database (nightscout-test.sh only).
// --dry-run makes the data and prints its summary without sending it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NightscoutClient } from '../src/sync/client.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.cache', 'nightscout.env');
const local = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)))
  : {};

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) || 14);
const replace = args.includes('--replace');
const dryRun = args.includes('--dry-run');
// The test Nightscout's address, as nightscout-test.sh last started it.
const TEST_URL = local.NS_URL || 'http://localhost:1340';
const targetUrl = process.env.TARGET_URL || TEST_URL;
// The test Nightscout's token only for the test Nightscout.
const target = new NightscoutClient({ url: targetUrl, token: process.env.TARGET_TOKEN || (targetUrl === TEST_URL ? local.NS_ADMIN_TOKEN : '') || '' });
if (!dryRun && !target.token) {
  console.error('usage: [TARGET_URL=… TARGET_TOKEN=…] node scripts/nightscout-fake.js [days] [--replace] [--dry-run]');
  process.exit(2);
}

// The same SEED makes the same data for the same end time (mulberry32).
let seed = Number(process.env.SEED || 1) >>> 0;
function random () {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * random();
const chance = (p) => random() < p;
const round = (v, step) => Math.round(v / step) * step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const MIN = 60000;
const STEP = 5;
const MMOL = 18.0182;
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const APP = 'loopk-fake';
const PROFILE = 'Test';

// The profile, in mmol/L as AAPS keeps it: [start hour, value].
const SCHEDULE = {
  basal: [[0, 0.8], [4, 1.0], [8, 0.9], [12, 0.8], [18, 0.9], [22, 0.8]],
  carbratio: [[0, 10], [6, 8], [11, 10]],
  sens: [[0, 2.5]],
  target_low: [[0, 5.5]],
  target_high: [[0, 5.5]],
};
const DIA = 6;
const entries = (list) => list.map(([h, value]) => ({ time: `${String(h).padStart(2, '0')}:00`, timeAsSeconds: h * 3600, value }));
const store = {
  dia: DIA, carbs_hr: 20, delay: 20, timezone: ZONE, units: 'mmol', startDate: '1970-01-01T00:00:00.000Z',
  ...Object.fromEntries(Object.entries(SCHEDULE).map(([k, list]) => [k, entries(list)])),
};
const hourOf = (t) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
const at = (list, t) => list.filter(([h]) => h <= hourOf(t)).at(-1)[1];
const basalAt = (t) => at(SCHEDULE.basal, t);
const isf = (t) => at(SCHEDULE.sens, t) * MMOL; // mg/dL per U
const csf = (t) => isf(t) / at(SCHEDULE.carbratio, t); // mg/dL per g
const MAX_IOB = 4;
const TARGET = SCHEDULE.target_low[0][1] * MMOL;

// Insulin still to act, of one unit given `min` minutes ago (exponential
// curve, peak at TAU, about 1% left after DIA).
const TAU = 55;
const iobLeft = (min) => (min <= 0 ? 1 : (1 + min / TAU) * Math.exp(-min / TAU));
// Carbs absorbed of one gram eaten `min` minutes ago.
const absorbed = (min, duration) => clamp((min - 10) / duration, 0, 1);

const docs = { profile: [], treatments: [], entries: [], devicestatus: [] };
const stamp = (t) => ({ app: APP, identifier: crypto.randomUUID(), date: t, created_at: new Date(t).toISOString(), utcOffset: -new Date(t).getTimezoneOffset() });
const treatment = (t, fields) => docs.treatments.push({ ...stamp(t), ...fields });

const now = Math.floor(Date.now() / (STEP * MIN)) * STEP * MIN;
const start = now - days * 24 * 60 * MIN;

// What happens each day, planned ahead in local time.
const plan = [];
for (let d = new Date(start); d.getTime() < now; d.setDate(d.getDate() + 1)) {
  const day = (h) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + h * 60 * MIN;
  const meal = (p, hour, spread, lo, hi, bolus = true) => {
    if (chance(p)) plan.push({ kind: bolus ? 'meal' : 'snack', t: day(hour + between(-spread, spread)), g: round(between(lo, hi), 5) });
  };
  meal(0.9, 7.25, 0.7, 35, 60);
  meal(0.85, 12.5, 0.75, 45, 80);
  meal(0.4, 16, 1, 15, 25, false);
  meal(0.95, 19, 0.75, 50, 90);
  if (chance(0.3)) plan.push({ kind: 'walk', t: day(17.5 + between(-1, 1)), minutes: round(between(45, 90), 5) });
  if (d.getDate() % 3 === 0) plan.push({ kind: 'site', t: day(20 + between(0, 1)) });
}
plan.sort((a, b) => a.t - b.t);

docs.profile.push({ ...stamp(start), startDate: new Date(start).toISOString(), mills: start, defaultProfile: PROFILE, units: 'mmol', store: { [PROFILE]: store } });
treatment(start, {
  eventType: 'Profile Switch', profile: PROFILE, originalProfileName: PROFILE, percentage: 100, timeshift: 0,
  duration: 0, durationInMilliseconds: 0, originalDuration: 0, profileJson: JSON.stringify(store),
});
// The switch as it took effect: AAPS uploads it as a note with the profile,
// which the simulator replays runs with.
treatment(start + MIN, {
  eventType: 'Note', notes: PROFILE, originalProfileName: PROFILE, originalCustomizedName: PROFILE, originalPercentage: 100,
  originalTimeshift: 0, originalDuration: 0, originalEnd: 0, profileJson: JSON.stringify(store),
});

let bg = 110;
let need = 1; // the body's basal need over the profile's
let dayFactor = 1;
let lastDay = -1;
let sgv = null;
let reservoir = 200;
let battery = 100;
let rescueAt = -Infinity;
let tempBasal = null; // { t, rate } while one runs
let tempTarget = null; // { from, to, mgdl }
let active = null; // { from, to } of a walk
const doses = []; // { t, u, basal }: boluses, SMBs and the basal above or below the profile
const eaten = []; // { t, g, duration }: what the body absorbs
const entered = []; // { t, g }: what the loop was told
const pending = [...plan];

function endTempBasal (t) {
  if (!tempBasal) return;
  const duration = Math.round((t - tempBasal.t) / MIN);
  treatment(tempBasal.t, {
    eventType: 'Temp Basal', type: 'NORMAL', rate: tempBasal.rate, absolute: tempBasal.rate,
    duration, durationInMilliseconds: duration * MIN, pumpType: 'GENERIC_AAPS', pumpSerial: 'fake',
  });
  tempBasal = null;
}

function bolus (t, u, fields) {
  doses.push({ t, u });
  reservoir -= u;
  treatment(t, { eventType: 'Correction Bolus', insulin: u, type: 'SMB', isBasalInsulin: false, pumpType: 'GENERIC_AAPS', pumpSerial: 'fake', ...fields });
}

for (let t = start; t <= now; t += STEP * MIN) {
  const date = new Date(t);
  if (date.getDate() !== lastDay) {
    lastDay = date.getDate();
    dayFactor = between(0.85, 1.2);
  }

  // The day's events.
  while (pending.length && pending[0].t <= t) {
    const e = pending.shift();
    if (e.kind === 'meal' || e.kind === 'snack') {
      eaten.push({ t, g: e.g * between(0.75, 1.4), duration: between(120, 300) });
      entered.push({ t, g: e.g });
      treatment(t, { eventType: e.kind === 'meal' ? 'Meal Bolus' : 'Carb Correction', carbs: e.g });
      // Now and then the bolus comes late.
      const late = chance(0.15) ? round(between(20, 45), 5) : 1;
      if (e.kind === 'meal') bolus(t + late * MIN, round((e.g / at(SCHEDULE.carbratio, t)) * between(0.8, 1), 0.05), { eventType: 'Meal Bolus', type: 'NORMAL' });
    } else if (e.kind === 'walk') {
      active = { from: t, to: t + e.minutes * MIN };
      tempTarget = { from: t - 45 * MIN, to: active.to, mgdl: 8 * MMOL };
      treatment(tempTarget.from, {
        eventType: 'Temporary Target', reason: 'Activity', units: 'mg/dl', targetTop: tempTarget.mgdl, targetBottom: tempTarget.mgdl,
        duration: (tempTarget.to - tempTarget.from) / MIN, durationInMilliseconds: tempTarget.to - tempTarget.from,
      });
    } else if (e.kind === 'site') {
      reservoir = 200;
      treatment(t, { eventType: 'Site Change', enteredBy: APP, duration: 0, durationInMilliseconds: 0 });
    }
  }

  // The body over the last 5 minutes.
  const sens = dayFactor * (active && t >= active.from && t < active.to + 120 * MIN ? (t < active.to ? 1.8 : 1.4) : 1);
  need = clamp(need + between(-0.02, 0.02), 0.8, 1.25);
  const dawn = hourOf(t) >= 4 && hourOf(t) < 8 ? 1.25 : 1;
  const from = t - STEP * MIN;
  const insulin = doses.reduce((s, d) => s + d.u * (iobLeft((from - d.t) / MIN) - iobLeft((t - d.t) / MIN)), 0);
  const carbs = eaten.reduce((s, c) => s + c.g * (absorbed((t - c.t) / MIN, c.duration) - absorbed((from - c.t) / MIN, c.duration)), 0);
  const drift = (need * dawn / sens - 1) * basalAt(t) * (STEP / 60) * isf(t);
  bg = clamp(bg + carbs * csf(t) - insulin * isf(t) * sens + drift + between(-1, 1), 40, 400);

  // The CGM.
  const reading = Math.round(clamp(bg + between(-3, 3), 39, 400));
  const perMinute = sgv == null ? 0 : (reading - sgv) / STEP;
  const direction = perMinute > 3 ? 'DoubleUp' : perMinute > 2 ? 'SingleUp' : perMinute > 1 ? 'FortyFiveUp'
    : perMinute >= -1 ? 'Flat' : perMinute >= -2 ? 'FortyFiveDown' : perMinute >= -3 ? 'SingleDown' : 'DoubleDown';
  const delta = sgv == null ? 0 : reading - sgv;
  sgv = reading;
  docs.entries.push({ ...stamp(t), device: APP, type: 'sgv', sgv, direction, units: 'mg/dl' });

  // Rescue carbs below 70.
  if (sgv < 70 && t - rescueAt > 20 * MIN) {
    rescueAt = t;
    eaten.push({ t, g: 15, duration: 45 });
    entered.push({ t, g: 15 });
    treatment(t, { eventType: 'Carb Correction', carbs: 15, notes: 'Hypo' });
  }

  // The loop: what it knows is the profile, the carbs entered and the doses.
  const iob = doses.reduce((s, d) => s + d.u * iobLeft((t - d.t) / MIN), 0);
  const cobLeft = (min) => entered.reduce((s, c) => s + c.g * (1 - absorbed((t + min * MIN - c.t) / MIN, 180)), 0);
  const cob = cobLeft(0);
  const goal = tempTarget && t >= tempTarget.from && t < tempTarget.to ? tempTarget.mgdl : TARGET;
  const predict = (withCarbs) => Array.from({ length: 48 }, (_, k) => {
    const acted = doses.reduce((s, d) => s + d.u * (iobLeft((t - d.t) / MIN) - iobLeft((t + k * STEP * MIN - d.t) / MIN)), 0);
    return Math.round(clamp(sgv - acted * isf(t) + (withCarbs ? (cob - cobLeft(k * STEP)) * csf(t) : 0), 39, 400));
  });
  const predBGs = { IOB: predict(false), COB: predict(true) };
  const eventual = sgv - iob * isf(t) + cob * csf(t);
  const insulinReq = Math.round(((eventual - goal) / isf(t)) * 100) / 100;
  const low = sgv < 80 || Math.min(...predBGs.IOB.slice(0, 24)) < 65;
  const smb = !low && insulinReq > 0.1 && sgv >= 100 && iob < MAX_IOB ? round(Math.min(insulinReq / 3, 0.8, MAX_IOB - iob), 0.05) : 0;
  const scheduled = basalAt(t);
  let rate = low ? 0 : clamp(round(scheduled + 2 * Math.min(insulinReq - smb, 0) + Math.max(insulinReq - smb, 0), 0.05), 0, 3 * scheduled);
  if (Math.abs(rate - scheduled) < 0.05) rate = null;
  if (tempBasal && (rate == null || Math.abs(rate - tempBasal.rate) >= 0.05 || t - tempBasal.t >= 30 * MIN)) endTempBasal(t);
  if (rate != null && !tempBasal) tempBasal = { t, rate };
  if (smb > 0) bolus(t, smb, {});
  const delivered = tempBasal ? tempBasal.rate : scheduled;
  if (delivered !== scheduled) doses.push({ t, u: (delivered - scheduled) * (STEP / 60), basal: true });
  reservoir -= delivered * (STEP / 60);
  while (doses.length && t - doses[0].t > DIA * 60 * MIN) doses.shift();
  while (entered.length && t - entered[0].t > 4 * 60 * MIN) entered.shift();
  while (eaten.length && t - eaten[0].t > 5 * 60 * MIN) eaten.shift();

  const iso = date.toISOString();
  const mmol = (v) => (v / MMOL).toFixed(1);
  const suggested = {
    algorithm: 'SMB', timestamp: iso, deliverAt: iso, bg: sgv, tick: delta >= 0 ? `+${delta}` : String(delta),
    eventualBG: Math.round(eventual), targetBG: Math.round(goal), insulinReq, COB: Math.round(cob), IOB: Math.round(iob * 100) / 100,
    rate: delivered, duration: 30, sensitivityRatio: 1, variable_sens: isf(t), predBGs,
    reason: `COB: ${Math.round(cob)}, ISF: ${mmol(isf(t))}, CR: ${at(SCHEDULE.carbratio, t)}, Target: ${mmol(goal)}; Eventual BG ${mmol(eventual)}${low ? ', low: temp 0' : ''}${smb ? `, SMB ${smb} U` : ''}`,
  };
  const basaliob = Math.round(doses.filter((d) => d.basal).reduce((s, d) => s + d.u * iobLeft((t - d.t) / MIN), 0) * 100) / 100;
  battery = battery <= 20 ? 100 : battery - 0.2;
  docs.devicestatus.push({
    ...stamp(t), device: `openaps://${APP}`, uploaderBattery: Math.round(battery), isCharging: false,
    pump: { clock: iso, reservoir: Math.round(reservoir * 10) / 10, status: { status: 'normal', timestamp: iso }, extended: { ActiveProfile: PROFILE, BaseBasalRate: scheduled } },
    openaps: {
      iob: { iob: Math.round(iob * 100) / 100, basaliob, activity: Math.round((insulin / STEP) * 10000) / 10000, time: iso },
      suggested,
      enacted: { ...suggested, smb, received: true },
    },
  });
}
endTempBasal(now);

// What came out, to see that it looks like a life with a loop.
const readings = docs.entries.map((e) => e.sgv);
const perDay = (f) => (docs.treatments.reduce((s, x) => s + (f(x) || 0), 0) / days).toFixed(1);
const count = (kind) => docs.treatments.filter((x) => x.eventType === kind || x.type === kind).length;
console.log(`${days} days to ${dryRun ? 'nowhere (dry run)' : target.url}:`);
console.log(`  readings ${readings.length}, mean ${(readings.reduce((s, v) => s + v, 0) / readings.length / MMOL).toFixed(1)} mmol/L, in range 3.9–10 ${Math.round((100 * readings.filter((v) => v >= 70 && v <= 180).length) / readings.length)} %, below 3.9 ${((100 * readings.filter((v) => v < 70).length) / readings.length).toFixed(1)} %`);
console.log(`  per day: carbs ${perDay((x) => x.carbs)} g, boluses ${perDay((x) => x.eventType === 'Meal Bolus' && x.insulin)} U, SMBs ${perDay((x) => x.type === 'SMB' && x.insulin)} U`);
console.log(`  treatments ${docs.treatments.length} (SMB ${count('SMB')}, temp basals ${count('Temp Basal')}), device status ${docs.devicestatus.length}`);
if (dryRun) process.exit(0);

try {
  await target.check();
} catch (err) {
  console.error(`${err.message}${target.url === TEST_URL ? ': is it running? (scripts/nightscout-test.sh start)' : ''}`);
  process.exit(1);
}

if (replace) {
  if (target.url !== TEST_URL) {
    console.error(`--replace only works on the test Nightscout (${TEST_URL})`);
    process.exit(2);
  }
  execFileSync('mongosh', ['--quiet', '--port', '27018', 'nightscout', '--eval',
    'for (const c of ["entries", "treatments", "devicestatus", "profile"]) print(c + ": " + db[c].deleteMany({}).deletedCount + " deleted")'], { stdio: 'inherit' });
}

async function send (collection, list) {
  let done = 0;
  let failed = 0;
  const queue = [...list];
  const worker = async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      try {
        await target.post(`/api/v3/${collection}`, doc);
        done++;
      } catch (err) {
        if (failed++ < 3) console.warn(`  ${collection} ${doc.identifier}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  console.log(`${collection}: ${done} sent${failed ? `, ${failed} failed` : ''}`);
}

for (const [collection, list] of Object.entries(docs)) await send(collection, list);
if (replace) console.log('Restart the test Nightscout (scripts/nightscout-test.sh stop, then start) so its own pages forget the old data.');
