import express from 'express';
import { Collection, COLLECTIONS } from './collection.js';
import { API3_VERSION, SERVER_VERSION, HTTP, MSG, sendJSON, sendStatus } from './tools.js';

const FORMATS = { json: 'application/json', csv: 'text/csv', xml: 'application/xml' };

/** Converts a URL extension (/entries.json) into an Accept header. */
function extension2accept (req, res, next) {
  const m = /^(.*?)\.([A-Za-z0-9]+)$/.exec(req.path);
  if (!m) return next();
  const mime = FORMATS[m[2].toLowerCase()];
  if (!mime) return sendStatus(res, HTTP.NOT_ACCEPTABLE, MSG.HTTP_406_UNSUPPORTED_FORMAT);
  req.headers.accept = mime;
  req.url = m[1] + req.url.slice(req.path.length);
  next();
}

export function createApi3 (ctx) {
  const router = express.Router();
  router.use(express.json({ limit: '50mb' }));
  router.use(extension2accept);
  router.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    next();
  });

  const collections = {};
  for (const colName of Object.keys(COLLECTIONS)) {
    collections[colName] = new Collection({ ctx, colName });
    collections[colName].mapRoutes(router);
  }
  ctx.collections = collections;

  async function versionInfo () {
    return {
      version: SERVER_VERSION,
      apiVersion: API3_VERSION,
      srvDate: Date.now(),
      storage: await ctx.data.storage(),
    };
  }

  async function authenticated (req, res) {
    const auth = await ctx.auth.fromRequest(req);
    if (!auth.attempted || auth.failed) {
      sendStatus(res, HTTP.UNAUTHORIZED, auth.failed ? MSG.HTTP_401_BAD_TOKEN : MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
      return null;
    }
    return auth;
  }

  const handler = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendStatus(res, HTTP.INTERNAL_ERROR, MSG.STORAGE_ERROR);
    }
  };

  router.get('/version', handler(async (req, res) => {
    sendJSON(res, { result: await versionInfo() });
  }));

  router.get('/status', handler(async (req, res) => {
    const auth = await authenticated(req, res);
    if (!auth) return;
    const info = await versionInfo();
    info.apiPermissions = {};
    for (const colName of Object.keys(collections)) {
      let perms = '';
      for (const [letter, op] of [['c', 'create'], ['r', 'read'], ['u', 'update'], ['d', 'delete']]) {
        if (ctx.auth.can(auth, `api:${colName}:${op}`)) perms += letter;
      }
      if (perms) info.apiPermissions[colName] = perms;
    }
    sendJSON(res, { result: info });
  }));

  router.get('/lastModified', handler(async (req, res) => {
    const auth = await authenticated(req, res);
    if (!auth) return;
    const result = { srvDate: Date.now(), collections: {} };
    await Promise.all(Object.values(collections).map(async (col) => {
      if (!ctx.auth.can(auth, `api:${col.colName}:read`)) return;
      const lm = await col.storage.lastModified();
      if (lm) result.collections[col.colName] = lm;
    }));
    sendJSON(res, { result });
  }));

  router.use((req, res) => sendStatus(res, HTTP.NOT_FOUND, MSG.HTTP_404_BAD_OPERATION));

  // Malformed JSON bodies and other errors.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_REQUEST_BODY);
    }
    console.error(err);
    sendStatus(res, HTTP.INTERNAL_ERROR, MSG.HTTP_500_INTERNAL_ERROR);
  });

  return router;
}
