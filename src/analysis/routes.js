import express from 'express';
import { findMisses } from './misses.js';

const READ = 'This needs an account that may read glucose entries, treatments and device status.';
const DAY = 24 * 3600000;
// The search for misses looks at most this far at once.
const MAX_MISSES_WINDOW = 366 * DAY;

/** GET /api/analysis/misses?from=&to=: see below. */
export function createAnalysisRoutes (ctx) {
  const router = express.Router();
  const { auth, pool } = ctx;
  const read = [
    auth.require('api:entries:read', READ),
    auth.require('api:treatments:read', READ),
    auth.require('api:devicestatus:read', READ),
  ];
  const fail = (res, status, message) => res.status(status).json({ status, message });

  // GET /api/analysis/misses?from=&to=: times the loop got it wrong (misses.js), default the last 30 days.
  router.get('/misses', read, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const to = req.query.to ? Number(req.query.to) : Date.now();
      const from = req.query.from ? Number(req.query.from) : to - 30 * DAY;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return fail(res, 400, 'from and to must be times in ms, from before to');
      if (to - from > MAX_MISSES_WINDOW) return fail(res, 400, `Search at most ${MAX_MISSES_WINDOW / DAY} days at once`);
      res.json({ from, to, misses: await findMisses(pool, { from, to }) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
