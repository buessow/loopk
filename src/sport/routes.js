import express from 'express';
import { MANAGE_ACCESS } from '../auth/index.js';
import { SportError } from './mode.js';

const SWITCH = 'api:treatments:create';

/**
 * GET /api/sport: whether sport mode is set up and on; POST /api/sport/start
 * { duration?, utcOffset } and /api/sport/stop { utcOffset } switch it, for
 * people signed in who may write treatments. /api/admin/sport: its setting.
 */
export function createSportRoutes (ctx) {
  const router = express.Router();
  const { auth } = ctx;
  const fail = (res, status, message) => res.status(status).json({ status, message });
  const h = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SportError) return fail(res, err.status, err.message);
      next(err);
    }
  };
  const admin = auth.require(MANAGE_ACCESS, 'Only admins may do this.');
  const json = express.json({ limit: '4kb' });

  router.get('/api/sport', auth.require('api:treatments:read'), h(async (req, res) => {
    const a = await auth.fromRequest(req);
    res.set('Cache-Control', 'no-store');
    res.json({ ...await ctx.sport.state(), canSwitch: Boolean(a.user) && auth.can(a, SWITCH) && !ctx.follower, following: ctx.follower?.url ?? null });
  }));

  const switching = (fn) => h(async (req, res) => {
    const a = await auth.fromRequest(req);
    if (!a.user) return fail(res, a.attempted && !a.failed ? 403 : 401, 'Sport mode is switched by people signed in to the web page');
    if (!auth.can(a, SWITCH)) return fail(res, 403, 'Switching sport mode needs an account that may write treatments');
    const utcOffset = Number.isInteger(req.body?.utcOffset) && Math.abs(req.body.utcOffset) <= 16 * 60 ? req.body.utcOffset : 0;
    res.json(await fn(req.body || {}, { utcOffset, by: a.user.email }));
  });
  router.post('/api/sport/start', json, switching(({ duration }, o) => ctx.sport.start({ ...o, duration })));
  router.post('/api/sport/stop', json, switching((body, o) => ctx.sport.stop(o)));

  router.get('/api/admin/sport', admin, h(async (req, res) => res.json(await ctx.sport.view())));
  router.put('/api/admin/sport', admin, json, h(async (req, res) => {
    const { percentage, duration = 0, target = null, profile = null } = req.body || {};
    const by = (await auth.fromRequest(req)).user?.email;
    try {
      await ctx.sport.configure({ percentage, duration, target, profile }, by);
    } catch (err) {
      return fail(res, 400, err.message);
    }
    res.json(await ctx.sport.view());
  }));
  router.delete('/api/admin/sport', admin, h(async (req, res) => {
    await ctx.sport.remove();
    res.json(await ctx.sport.view());
  }));

  return router;
}
