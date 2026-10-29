import express from 'express';
import { MANAGE_ACCESS } from '../auth/index.js';
import { loadHistory } from './inputs.js';
import { simulatePeriod, MAX_PERIOD } from './period.js';
import { SimulationError, loadProfileStore, parseChanges, simulateRun } from './simulate.js';
import { DEFAULTS, loadSettings, saveSettings, validSetting } from './settings.js';
import { TEST_PROFILE, copyTestProfile, deleteTestProfile, fromStore, loadTestProfile, newestStore } from './testprofile.js';

const READ = 'This needs a token or account that may read glucose entries, treatments and device status.';
const HOUR = 3600000;

/**
 * The simulator (docs/simulator-plan.md), on AAPS's algorithms ported to
 * src/oref:
 * POST /api/simulate/run { time, changes }: one loop decision as recorded
 *   and with changes (simulate.js).
 * POST /api/simulate/period { from, to, changes, k }: a period dosed with
 *   the changes, glucose by insulin difference (period.js).
 * GET /api/simulate/settings?at=: the loop settings at a time with where
 *   each came from, the profile in effect and the names of the stored
 *   profiles one can switch to.
 * PUT /api/simulate/settings { values, validFrom }: enters settings AAPS
 *   doesn't upload (admins).
 * GET /api/simulate/test-profile: the "AI Test" profile agents edit
 *   (testprofile.js) and the profiles of the newest profile store.
 * POST /api/simulate/test-profile/copy { to }: copies it into that profile
 *   of the store, which AAPS then receives (admins).
 * DELETE /api/simulate/test-profile: removes it (admins).
 */
export function createSimulateRoutes (ctx) {
  const router = express.Router();
  const { auth, pool } = ctx;
  const read = ['api:entries:read', 'api:treatments:read', 'api:devicestatus:read'].map((p) => auth.require(p, READ));
  const json = express.json({ limit: '16kb' });
  const h = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof SimulationError) return res.status(err.status).json({ status: err.status, message: err.message });
      next(err);
    }
  };
  const time = (v, name) => {
    const t = typeof v === 'string' && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
    if (!Number.isFinite(t)) throw new SimulationError(`${name} must be a time (ms or ISO 8601)`);
    return t;
  };

  router.post('/run', ...read, json, h(async (req, res) => {
    const body = req.body || {};
    res.json(await simulateRun(pool, { time: time(body.time, 'time'), changes: parseChanges(body.changes) }));
  }));

  router.post('/period', ...read, json, h(async (req, res) => {
    const body = req.body || {};
    const from = time(body.from, 'from');
    const to = time(body.to, 'to');
    if (!(from < to)) throw new SimulationError('from must be before to');
    if (to - from > MAX_PERIOD) throw new SimulationError(`At most ${MAX_PERIOD / 24 / HOUR} days at once`);
    if (body.k != null && !(typeof body.k === 'number' && body.k > 0 && body.k <= 3)) throw new SimulationError('k must be a number above 0, at most 3');
    res.json(await simulatePeriod(pool, { from, to: Math.min(to, Date.now()), changes: parseChanges(body.changes), k: body.k ?? undefined }));
  }));

  router.get('/settings', ...read, h(async (req, res) => {
    const at = req.query.at ? time(req.query.at, 'at') : Date.now();
    const history = await loadHistory(pool, { from: at - HOUR, to: at });
    const settings = await loadSettings(pool, { to: at, tempTargets: history.tempTargets });
    const profile = history.profiles.at(-1) || null;
    const [stored, test] = await Promise.all([loadProfileStore(pool, at), loadTestProfile(pool)]);
    const profiles = [...(test ? [TEST_PROFILE] : []), ...stored.map((p) => p.name).filter((n) => n !== TEST_PROFILE)];
    res.json({ at, ...settings, defaults: DEFAULTS, profile: profile && { ...profile, timeZone: undefined }, profiles });
  }));

  // stores: every profile to compare with, those of the newest profile
  // store (which a copy can go into) with inStore, then those known only
  // from AAPS's profile switches
  router.get('/test-profile', ...read, h(async (req, res) => {
    const [test, doc, known] = await Promise.all([loadTestProfile(pool), newestStore(pool), loadProfileStore(pool, Date.now())]);
    const inStore = Object.entries(doc?.store || {}).map(([name, p]) => ({ ...fromStore(name, p), inStore: true }));
    const others = known.filter((p) => !doc?.store?.[p.name]).map((p) => ({ ...p, inStore: false }));
    res.json({ name: TEST_PROFILE, profile: test, stores: [...inStore, ...others], defaultProfile: doc?.defaultProfile ?? null, storeDate: doc?.date ?? null });
  }));

  const admin = auth.require(MANAGE_ACCESS, 'Only admins may change profiles.');
  router.post('/test-profile/copy', admin, json, h(async (req, res) => {
    const to = req.body?.to;
    if (typeof to !== 'string' || !to) throw new SimulationError('to must name a profile of the profile store');
    const a = await auth.fromRequest(req);
    const utcOffset = Number.isInteger(req.body?.utcOffset) ? req.body.utcOffset : 0;
    const doc = await copyTestProfile(ctx, { to, by: a.user?.email ?? a.subject?.name ?? null, utcOffset });
    res.json({ copied: to, date: doc.date, identifier: doc.identifier });
  }));

  router.delete('/test-profile', admin, h(async (req, res) => {
    await deleteTestProfile(pool);
    res.json({ name: TEST_PROFILE, profile: null });
  }));

  router.put('/settings', auth.require(MANAGE_ACCESS, 'Only admins may enter loop settings.'), json, h(async (req, res) => {
    const body = req.body || {};
    const values = body.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SimulationError('values must be an object of settings');
    for (const [key, value] of Object.entries(values)) {
      if (!validSetting(key, value)) throw new SimulationError(`Not a loop setting value: ${key} = ${JSON.stringify(value)}`);
    }
    const validFrom = body.validFrom != null ? time(body.validFrom, 'validFrom') : Date.now();
    const a = await auth.fromRequest(req);
    await saveSettings(pool, values, { validFrom, by: a.user?.email ?? a.subject?.name ?? null });
    res.json(await loadSettings(pool, { to: Math.max(validFrom, Date.now()) }));
  }));

  return router;
}
