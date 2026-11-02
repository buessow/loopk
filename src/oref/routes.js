import express from 'express';
import { MANAGE_ACCESS } from '../auth/index.js';
import { simulateApi } from './api.js';
import { SimulationError } from './simulate.js';
import { TEST_PROFILE, copyTestProfile, deleteTestProfile, saveTestProfile } from './testprofile.js';

const READ = 'This needs a token or account that may read glucose entries, treatments and device status.';

/**
 * The simulator's server side (docs/simulator-plan.md). The simulation runs
 * in the browser (public/localworker.js, over api.js) and for agents in
 * src/mcp; the server keeps what is saved:
 * GET /api/simulate/stored: the loop settings entered and the AI Test
 *   profile, for the browser's worker.
 * PUT /api/simulate/settings { values, validFrom }: enters settings AAPS
 *   doesn't upload (admins).
 * GET /api/simulate/test-profile: the "AI Test" profile agents edit
 *   (testprofile.js) and the profiles of the newest profile store.
 * PUT /api/simulate/test-profile { profile, basedOn, note }: writes it, for
 *   agents that run loopk's MCP themselves (src/mcp/local.js); a read token
 *   may, as through /mcp, since AAPS never sees it.
 * POST /api/simulate/test-profile/copy { to }: copies it into that profile
 *   of the store (adding a profile known only from switches), which AAPS
 *   then receives (admins).
 * DELETE /api/simulate/test-profile: removes it (admins).
 */
export function createSimulateRoutes (ctx) {
  const router = express.Router();
  const { auth, data } = ctx;
  const api = simulateApi(data, { follows: () => ctx.follower?.url ?? null });
  const read = ['api:entries:read', 'api:treatments:read', 'api:devicestatus:read'].map((p) => auth.require(p, READ));
  const json = express.json({ limit: '16kb' });
  const h = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof SimulationError || err.expose) return res.status(err.status).json({ status: err.status, message: err.message });
      next(err);
    }
  };

  router.get('/stored', ...read, h(async (req, res) => res.json(await api.stored())));
  router.get('/test-profile', ...read, h(async (req, res) => res.json(await api.testProfile())));

  router.put('/test-profile', ...read, json, h(async (req, res) => {
    const a = await auth.fromRequest(req);
    const { profile, basedOn = null, note = null } = req.body || {};
    res.json(await saveTestProfile(data, { profile, basedOn, note }, a.user?.email ?? a.subject?.name ?? null));
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
    await deleteTestProfile(data);
    res.json({ name: TEST_PROFILE, profile: null });
  }));

  router.put('/settings', auth.require(MANAGE_ACCESS, 'Only admins may enter loop settings.'), json, h(async (req, res) => {
    const a = await auth.fromRequest(req);
    res.json(await api.saveSettings(req.body || {}, a.user?.email ?? a.subject?.name ?? null));
  }));

  return router;
}
