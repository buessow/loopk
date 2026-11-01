// A loopk that keeps nothing of anyone's: each caller brings an access token
// on a Nightscout server (NIGHTSCOUT_URL, or the one they name at sign-in
// when none is set) and is served by a loopk of their own over it: a
// Nightscout data source with its in-memory cache, a context and an app,
// made on first use and dropped after IDLE without requests. What the token
// may do on that server is what the caller may do here.
//
// The token comes with every request, the server keeps none: ?token=, a JWT
// from /api/v2/authorization/request (which carries the token sealed), or
// the session cookie that signing in sets (the token sealed, src/auth/seal.js).

import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { Sealer } from '../auth/seal.js';
import { nightscoutSource } from '../data/nightscout/index.js';
import { createApp, createContext, createPageRoutes, errorHandler } from '../app.js';
import { logRequests } from '../monitoring/requests.js';

const SESSION_COOKIE = 'loopk_session';
const SESSION_LIFETIME = 30 * 24 * 3600 * 1000;
// A caller's cache is dropped after this long without requests.
const IDLE = 30 * 60000;
// Lifetime of JWTs handed to API clients (as in src/auth).
const JWT_LIFETIME = '8h';

/** The loopks of the callers, one per server and token. */
export class Callers {
  constructor (config, { idle = IDLE, source = nightscoutSource } = {}) {
    this.config = config;
    this.idle = idle;
    this.source = source;
    this.callers = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(idle, 60000));
    this.timer.unref();
  }

  /** The caller's loopk for { url, token }, made on first use; throws if the server refuses the token. */
  async get ({ url, token }) {
    const key = crypto.createHash('sha256').update(`${url}\n${token}`).digest('base64url');
    let caller = this.callers.get(key);
    if (!caller) {
      caller = { key, url, active: 0 };
      caller.ready = this.make(caller, token);
      this.callers.set(key, caller);
      caller.ready.catch(() => {
        if (this.callers.get(key) === caller) this.callers.delete(key);
      });
    }
    caller.used = Date.now();
    await caller.ready;
    return caller;
  }

  async make (caller, token) {
    const data = await this.source({ url: caller.url, token });
    try {
      caller.ctx = await createContext(this.config, data);
    } catch (err) {
      await data.close();
      throw err;
    }
    caller.data = data;
    caller.access = data.access;
    caller.app = createApp(caller.ctx);
  }

  /** Hands the request to the caller's app, which stays while it answers. */
  dispatch (caller, req, res, next) {
    caller.active++;
    res.once('close', () => {
      caller.active--;
      caller.used = Date.now();
    });
    caller.app(req, res, next);
  }

  /** Drops the callers idle for longer than `idle`. */
  sweep (now = Date.now()) {
    for (const [key, caller] of this.callers) {
      if (caller.data && !caller.active && now - caller.used > this.idle) {
        this.callers.delete(key);
        caller.data.close().catch(console.error);
      }
    }
  }

  get size () {
    return this.callers.size;
  }

  async close () {
    clearInterval(this.timer);
    const all = [...this.callers.values()];
    this.callers.clear();
    await Promise.all(all.map((c) => c.ready.then(() => c.data.close(), () => {})));
  }
}

const httpUrl = (value) => {
  try {
    const u = new URL(String(value).trim());
    return /^https?:$/.test(u.protocol) ? u.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
};

/** The app of a server that keeps nothing: sign-in, then each caller's own loopk. */
export function createPassthroughApp (config, { requestLog = false, callers = new Callers(config) } = {}) {
  const fixed = config.nightscout.url ? config.nightscout.url.replace(/\/$/, '') : '';
  const sealer = new Sealer(config.sessionKey);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', true);
  if (requestLog) app.use(logRequests());
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
  const unauthorized = (res, description = 'Invalid/Missing') => res.status(401).json({ status: 401, message: 'Unauthorized', description });
  const refused = (err) => /did not accept the access token/.test(err.message);
  const h = (fn) => (req, res, next) => fn(req, res).catch(next);

  // Signing in: { token, url (only without NIGHTSCOUT_URL) }; the cookie carries both, sealed.
  app.post('/auth/token', express.json(), h(async (req, res) => {
    const url = fixed || httpUrl(req.body?.url);
    const token = String(req.body?.token ?? '').trim();
    if (!url) return res.status(400).json({ status: 400, message: 'The address of a Nightscout server is needed' });
    if (!token) return res.status(400).json({ status: 400, message: 'An access token is needed' });
    let caller;
    try {
      caller = await callers.get({ url, token });
    } catch (err) {
      return res.status(refused(err) ? 401 : 502).json({ status: refused(err) ? 401 : 502, message: err.message });
    }
    res.cookie(SESSION_COOKIE, sealer.seal({ url, token }), { ...cookieOpts, maxAge: SESSION_LIFETIME });
    res.json({ name: caller.access.sub, url });
  }));

  app.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // The token exchange of API clients: the JWT carries the token, sealed.
  app.get('/api/v2/authorization/request/:accessToken', h(async (req, res) => {
    if (!fixed) return res.status(400).json({ status: 400, message: 'This server has no NIGHTSCOUT_URL: sign in on its web page' });
    const token = req.params.accessToken;
    let caller;
    try {
      caller = await callers.get({ url: fixed, token });
    } catch (err) {
      return refused(err) ? unauthorized(res) : res.status(502).json({ status: 502, message: err.message });
    }
    const signed = jwt.sign({ sealed: sealer.seal({ url: fixed, token }) }, sealer.jwtSecret, { expiresIn: JWT_LIFETIME, subject: caller.access.sub ?? 'token' });
    const { iat, exp } = jwt.decode(signed);
    res.json({ token: signed, sub: caller.access.sub, permissionGroups: [caller.access.permissions], iat, exp });
  }));

  // Access is the Nightscout server's: there are no tokens, people or followed servers here.
  const where = fixed || 'the Nightscout server you sign in with';
  app.use(['/admin', '/api/admin', '/auth/google', '/api/v2/authorization/subjects'], (req, res) => {
    res.status(404).json({ status: 404, message: `This server keeps nothing: access tokens are made on ${where}` });
  });

  /** The server and token a request comes with: { url, token, via }, null for none, false for a bad one. */
  function credentials (req) {
    const bearer = /^bearer\s+(.*)$/i.exec(req.get('authorization') || '')?.[1].trim();
    if (bearer) {
      try {
        return { ...sealer.open(jwt.verify(bearer, sealer.jwtSecret).sealed), via: 'jwt' };
      } catch {
        return false;
      }
    }
    if (req.query.token) return fixed ? { url: fixed, token: String(req.query.token), via: 'token' } : false;
    const cookie = req.cookies?.[SESSION_COOKIE];
    const sealed = cookie && sealer.open(cookie);
    return sealed ? { ...sealed, via: 'session' } : null;
  }

  // What the caller may do: what their token may do on that server. Signed
  // in on the web page, they are a person too (dashboards, sport mode).
  const authFor = (caller, via) => {
    const name = caller.access.sub || 'token';
    return {
      permissions: caller.access.permissions,
      subject: { name },
      user: via === 'session' ? { email: `${name}@${new URL(caller.url).host}`, name } : undefined,
      attempted: true,
    };
  };

  app.use((req, res, next) => serve(req, res, next).catch(next));
  async function serve (req, res, next) {
    const c = credentials(req);
    if (c === false || (c && !(c.url && c.token))) return unauthorized(res);
    if (!c) return guest(req, res);
    let caller;
    try {
      caller = await callers.get(c);
    } catch (err) {
      if (c.via !== 'session') return refused(err) ? unauthorized(res) : res.status(502).json({ status: 502, message: err.message });
      // A token the server no longer takes signs the person out.
      if (refused(err)) res.clearCookie(SESSION_COOKIE, { path: '/' });
      else return res.status(502).json({ status: 502, message: err.message });
      return guest(req, res);
    }
    req._auth = authFor(caller, c.via);
    callers.dispatch(caller, req, res, (err) => (err ? next(err) : guest(req, res)));
  }

  // Without a token: the pages, and what signing in needs.
  const pages = createPageRoutes();
  function guest (req, res) {
    if (req.path === '/api/session') {
      return res.status(401).json({ status: 401, message: 'Not signed in', keepsNothing: true, nightscout: fixed || null });
    }
    if (req.path.startsWith('/api/') || req.path === '/mcp' || req.path.startsWith('/socket.io/')) return unauthorized(res);
    pages(req, res, () => res.status(404).json({ status: 404, message: 'Not found' }));
  }

  app.use(errorHandler);
  return app;
}
