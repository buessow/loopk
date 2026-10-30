import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Auth } from './auth/index.js';
import { createApi2 } from './api2/index.js';
import { createApi3 } from './api3/index.js';
import { createSessionRoutes } from './web/session.js';
import { createPredictionRoutes } from './predict/routes.js';
import { ModelStore } from './predict/store.js';
import { PredictionRecorder } from './predict/recorder.js';
import { createReportRoutes } from './reports/routes.js';
import { createAnalysisRoutes } from './analysis/routes.js';
import { SportMode } from './sport/mode.js';
import { createSportRoutes } from './sport/routes.js';
import { createMcpRoutes } from './mcp/server.js';
import { createSimulateRoutes } from './oref/routes.js';
import { Following } from './sync/following.js';
import { logRequests } from './monitoring/requests.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createContext (config, data) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const auth = new Auth(data, config);
  await auth.init();
  const ctx = { config, data, bus, auth };
  // The server to follow (Access page, or FOLLOW_URL). The server starts the
  // follower, ctx.follower; while there is one, the API refuses data changes.
  ctx.following = new Following(ctx, config.follow);
  await ctx.following.load();
  // The server starts the recorder, which predicts for each new reading.
  ctx.models = new ModelStore(data);
  ctx.predictions = new PredictionRecorder(ctx, ctx.models);
  // Sport mode: a profile percentage and temp target sent to AAPS.
  ctx.sport = new SportMode(ctx);
  await ctx.sport.load();
  return ctx;
}

export function createApp (ctx, { requestLog = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // APIv3 sets its own ETag (W/"<srvModified>"), which clients use as a sync cursor.
  app.set('etag', false);
  app.set('trust proxy', true);
  if (requestLog) app.use(logRequests());
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api/v3', createApi3(ctx));
  app.use('/api/v2', createApi2(ctx));
  app.use('/api/prediction', createPredictionRoutes(ctx));
  app.use('/api/reports', createReportRoutes(ctx));
  app.use('/api/analysis', createAnalysisRoutes(ctx));
  app.use('/api/simulate', createSimulateRoutes(ctx));
  app.use(createSportRoutes(ctx));
  // For agents: read-only tools over the data (src/mcp/server.js).
  app.use('/mcp', createMcpRoutes(ctx));
  app.use('/api', (req, res, next) => (req.path.startsWith('/session') || req.path.startsWith('/admin') ? next() : res.status(404).json({ status: 404, message: 'Not found' })));
  app.use(createSessionRoutes(ctx));

  const pub = path.join(root, 'public');
  app.get(['/login', '/admin', '/reports', '/profiles', '/simulate'], (req, res) => res.sendFile(path.join(pub, `${req.path.slice(1)}.html`)));
  app.use(express.static(pub, { index: 'index.html', extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 500, message: 'Internal Server Error' });
  });
  return app;
}
