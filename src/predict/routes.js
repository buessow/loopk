import express from 'express';
import { UPLOAD_MODEL } from '../auth/index.js';
import { predict, recentRecords } from './index.js';
import { modelInfo, modelProblems } from './store.js';
import { recordedPredictions } from './recorder.js';

const DAY = 24 * 3600000;
const READ = 'This needs a token or account that may read glucose entries.';

/**
 * GET /api/prediction: glucose 15 and 30 minutes ahead (see index.js).
 * GET /api/prediction/history?from=&to=: the predictions recorded for that
 * time range (ms; default the last day, at most 32 days).
 * GET /api/prediction/model: the model in use.
 * PUT /api/prediction/model: upload a model (modelling/export.py --upload),
 * for model upload tokens and admins.
 */
export function createPredictionRoutes (ctx) {
  const router = express.Router();
  const store = ctx.models;
  const h = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.get('/', ctx.auth.require('api:entries:read', READ), h(async (req, res) => {
    const row = await store.current();
    if (!row) return res.json({ available: false, reason: 'no prediction model uploaded' });
    const { readings, treatments } = await recentRecords(ctx.pool, row.model);
    res.json(predict(readings, { model: row.model, treatments }));
  }));

  router.get('/history', ctx.auth.require('api:entries:read', READ), h(async (req, res) => {
    const to = req.query.to ? Number(req.query.to) : Date.now();
    const from = req.query.from ? Number(req.query.from) : to - DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return res.status(400).json({ status: 400, message: 'from and to must be times in ms, from before to' });
    }
    if (to - from > 32 * DAY) return res.status(400).json({ status: 400, message: 'at most 32 days at once' });
    res.json(await recordedPredictions(ctx.pool, from, to));
  }));

  router.get('/model', ctx.auth.require('api:entries:read', READ), h(async (req, res) => {
    const row = await store.current();
    if (!row) return res.status(404).json({ status: 404, message: 'No prediction model uploaded' });
    res.json(modelInfo(row));
  }));

  router.put('/model', ctx.auth.require(UPLOAD_MODEL,
    'Only admins and tokens with the access "Upload model" may upload models; create one under Access on the admin page.'), express.json({ limit: '5mb' }), h(async (req, res) => {
    const problems = modelProblems(req.body);
    if (problems.length) return res.status(422).json({ status: 422, message: 'Model rejected', problems });
    const auth = await ctx.auth.fromRequest(req);
    const row = await store.save(req.body, auth.user?.email || auth.subject?.name || null);
    ctx.predictions.schedule();
    res.status(201).json(modelInfo(row));
  }));

  return router;
}
