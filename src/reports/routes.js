import express from 'express';
import { hourlyTotals, validTimeZone } from './index.js';
import { profileUsage } from './profiles.js';

const READ = 'This needs a token or account that may read glucose entries and treatments.';
// Far above a real dashboard (a few KB); only guards the jsonb column.
const MAX_DASHBOARD_BYTES = 256 * 1024;

/**
 * GET /api/reports/hours?from=&to=&tz=: hourly totals (index.js) for that
 * time range (ms; default the last 30 days) in time zone tz (default UTC).
 * GET /api/reports/profiles?from=&to=&tz=: basal profiles in use (profiles.js), same parameters.
 * GET /api/reports/dashboard: the signed-in person's dashboard, 204 if none.
 * PUT /api/reports/dashboard: replaces it with the request body (JSON object).
 */
export function createReportRoutes (ctx) {
  const router = express.Router();
  const { auth, data } = ctx;
  const h = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const read = [auth.require('api:entries:read', READ), auth.require('api:treatments:read', READ)];

  // { from, to, timeZone } of the query, or null after answering 400.
  const range = (req, res) => {
    const to = req.query.to ? Number(req.query.to) : Date.now();
    const from = req.query.from ? Number(req.query.from) : to - 30 * 24 * 3600000;
    const timeZone = req.query.tz ? String(req.query.tz) : 'UTC';
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      res.status(400).json({ status: 400, message: 'from and to must be times in ms, from before to' });
      return null;
    }
    if (!validTimeZone(timeZone)) {
      res.status(400).json({ status: 400, message: `Unknown time zone ${timeZone}` });
      return null;
    }
    return { from, to, timeZone };
  };

  router.get('/hours', read, h(async (req, res) => {
    const q = range(req, res);
    if (q) res.json(await hourlyTotals(data, q));
  }));

  router.get('/profiles', read, h(async (req, res) => {
    const q = range(req, res);
    if (q) res.json(await profileUsage(data, q));
  }));

  // Dashboards belong to people signed in to the web UI, not to access tokens.
  const person = async (req, res) => {
    const a = await auth.fromRequest(req);
    if (a.user) return a.user.email;
    const status = a.attempted && !a.failed ? 403 : 401;
    res.status(status).json({ status, message: 'Dashboards are for people signed in to the web page' });
    return null;
  };

  router.get('/dashboard', read, h(async (req, res) => {
    const email = await person(req, res);
    if (!email) return;
    const dashboard = await data.dashboards.get(email);
    if (!dashboard) return res.status(204).end();
    res.json(dashboard);
  }));

  router.put('/dashboard', read, express.json({ limit: MAX_DASHBOARD_BYTES }), h(async (req, res) => {
    const email = await person(req, res);
    if (!email) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.widgets)) {
      return res.status(400).json({ status: 400, message: 'A dashboard is an object with a list of widgets' });
    }
    await data.dashboards.save(email, body);
    res.status(204).end();
  }));

  return router;
}
