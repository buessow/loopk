import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Auth } from './auth/index.js';
import { createApi2 } from './api2/index.js';
import { createApi3 } from './api3/index.js';
import { createSessionRoutes } from './web/session.js';
import { Following } from './sync/following.js';
import { logRequests } from './monitoring/requests.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createContext (config, pool) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const auth = new Auth(pool, config);
  await auth.init();
  const ctx = { config, pool, bus, auth };
  // The server to follow (Access page, or FOLLOW_URL). The server starts the
  // follower, ctx.follower; while there is one, the API refuses data changes.
  ctx.following = new Following(ctx, config.follow);
  await ctx.following.load();
  return ctx;
}

/** Fails fast when setup-databases.sh has not applied every migration to this database. */
export async function checkSchema (pool) {
  const files = (await fs.readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql'));
  let applied = new Set();
  try {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    applied = new Set(rows.map((r) => r.filename));
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length) {
    throw new Error(`Database schema is not current (pending: ${pending.join(', ')}). Run ./setup-databases.sh.`);
  }
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
  app.use('/api', (req, res, next) => (req.path.startsWith('/session') || req.path.startsWith('/admin') ? next() : res.status(404).json({ status: 404, message: 'Not found' })));
  app.use(createSessionRoutes(ctx));

  const pub = path.join(root, 'public');
  app.get(['/login', '/admin'], (req, res) => res.sendFile(path.join(pub, `${req.path.slice(1)}.html`)));
  app.use(express.static(pub, { index: 'index.html', extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 500, message: 'Internal Server Error' });
  });
  return app;
}
