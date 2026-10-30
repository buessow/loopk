import crypto from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { MANAGE_ACCESS } from '../auth/index.js';

const STATE_COOKIE = 'loopk_oauth_state';

/**
 * Google sign-in for the web UI (OAuth 2.0 authorization code flow), the
 * session endpoint the UI reads, and administration of who may sign in.
 */
export function createSessionRoutes (ctx) {
  const { auth, config, data } = ctx;
  const router = express.Router();
  const callbackUrl = `${config.baseUrl}/auth/google/callback`;
  const google = config.google.clientId
    ? new OAuth2Client(config.google.clientId, config.google.clientSecret, callbackUrl)
    : null;

  const cookieOpts = (maxAge) => ({
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge,
  });

  const h = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.get('/auth/google', (req, res) => {
    if (!google) return res.status(503).send('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, cookieOpts(10 * 60 * 1000));
    res.redirect(google.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    }));
  });

  router.get('/auth/google/callback', h(async (req, res) => {
    if (!google) return res.status(503).send('Google sign-in is not configured.');
    const expected = req.cookies[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (req.query.error) return res.redirect('/login?error=' + encodeURIComponent(req.query.error));
    if (!expected || req.query.state !== expected || !req.query.code) return res.redirect('/login?error=state');

    const { tokens } = await google.getToken(String(req.query.code));
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return res.redirect('/login?error=unverified');

    const user = await signInUser(data, config, payload);
    if (!user) return res.redirect('/login?error=denied');
    res.cookie(auth.sessionCookieName(), auth.signSession(user), cookieOpts(30 * 24 * 3600 * 1000));
    res.redirect('/');
  }));

  router.post('/auth/logout', (req, res) => {
    res.clearCookie(auth.sessionCookieName(), { path: '/' });
    res.json({ ok: true });
  });

  router.get('/api/session', h(async (req, res) => {
    const a = await auth.fromRequest(req);
    if (!a.user) return res.status(401).json({ status: 401, message: 'Not signed in', googleConfigured: !!google });
    res.json({
      user: { email: a.user.email, name: a.user.name, picture: a.user.picture },
      isAdmin: auth.can(a, MANAGE_ACCESS),
      follow: ctx.follower ? ctx.follower.status : null,
      // Whether the Sport button shows: an admin set sport mode up.
      sport: !!ctx.sport?.configured,
      permissions: a.permissions,
    });
  }));

  // --- people (who may sign in), for admins ------------------------------

  const admin = auth.require(MANAGE_ACCESS, 'Only admins may do this.');
  const userJson = (u) => ({ email: u.email, name: u.name, picture: u.picture, isAdmin: u.is_admin, last_login: u.last_login, created_at: u.created_at });
  // Admins cannot demote or remove themselves, so there is always one left.
  const isSelf = async (req, email) => (await auth.fromRequest(req)).user?.email === email;

  router.use('/api/admin', express.json());
  router.get('/api/admin/users', admin, h(async (req, res) => {
    res.json((await data.users.list()).map(userJson));
  }));
  // Adds a person, or changes whether they are an admin.
  router.post('/api/admin/users', admin, h(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const isAdmin = req.body?.isAdmin ?? false;
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ status: 400, message: 'Valid email is required' });
    if (typeof isAdmin !== 'boolean') return res.status(400).json({ status: 400, message: 'isAdmin must be true or false' });
    if (!isAdmin && await isSelf(req, email)) return res.status(409).json({ status: 409, message: 'You cannot remove your own admin rights' });
    res.json(userJson(await data.users.setAdmin(email, isAdmin)));
  }));
  router.delete('/api/admin/users/:email', admin, h(async (req, res) => {
    const email = req.params.email.toLowerCase();
    if (await isSelf(req, email)) return res.status(409).json({ status: 409, message: 'You cannot remove yourself' });
    res.json({ ok: await data.users.remove(email) });
  }));

  // --- following another Nightscout server, for admins -------------------

  router.get('/api/admin/follow', admin, h(async (req, res) => {
    res.json(await ctx.following.view());
  }));
  // { url, token (omit to keep the saved one), enabled }: checks the server, saves, follows.
  router.put('/api/admin/follow', admin, h(async (req, res) => {
    const { url, token, enabled = true } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ status: 400, message: 'enabled must be true or false' });
    const by = (await auth.fromRequest(req)).user?.email;
    try {
      await ctx.following.configure({ url, token: token ? String(token).trim() : '', enabled }, by);
    } catch (err) {
      return res.status(400).json({ status: 400, message: err.message });
    }
    res.json(await ctx.following.view());
  }));
  router.delete('/api/admin/follow', admin, h(async (req, res) => {
    await ctx.following.remove();
    res.json(await ctx.following.view());
  }));

  return router;
}

/**
 * Decides whether a Google account may sign in and records the login.
 * ADMIN_EMAILS are always admins; ALLOWED_EMAILS and people added by an
 * admin may sign in (as admins if an admin made them one).
 */
export async function signInUser (data, config, { email, name, picture }) {
  email = email.toLowerCase();
  const isAdmin = config.adminEmails.includes(email);
  const listed = config.allowedEmails.includes(email);
  if (!isAdmin && !listed && !await data.users.get(email)) return null;
  return data.users.signedIn({ email, name, picture, isAdmin });
}
