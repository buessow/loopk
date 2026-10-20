import express from 'express';
import { UPLOAD_MODEL } from '../auth/index.js';
import { predict, recentReadings } from './index.js';
import { ModelStore, modelInfo, modelProblems } from './store.js';

/**
 * GET /api/prediction: glucose 15 and 30 minutes ahead (see index.js).
 * GET /api/prediction/model: the model in use.
 * PUT /api/prediction/model: upload a model (modelling/export.py --upload),
 * for model upload tokens and admins.
 */
export function createPredictionRoutes (ctx) {
  const router = express.Router();
  const store = new ModelStore(ctx.pool);
  const h = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.get('/', ctx.auth.require('api:entries:read'), h(async (req, res) => {
    const row = await store.current();
    if (!row) return res.json({ available: false, reason: 'no prediction model uploaded' });
    res.json(predict(await recentReadings(ctx.pool, row.model), { model: row.model }));
  }));

  router.get('/model', ctx.auth.require('api:entries:read'), h(async (req, res) => {
    const row = await store.current();
    if (!row) return res.status(404).json({ status: 404, message: 'No prediction model uploaded' });
    res.json(modelInfo(row));
  }));

  router.put('/model', ctx.auth.require(UPLOAD_MODEL), express.json({ limit: '5mb' }), h(async (req, res) => {
    const problems = modelProblems(req.body);
    if (problems.length) return res.status(422).json({ status: 422, message: 'Model rejected', problems });
    const auth = await ctx.auth.fromRequest(req);
    const row = await store.save(req.body, auth.user?.email || auth.subject?.name || null);
    res.status(201).json(modelInfo(row));
  }));

  return router;
}
