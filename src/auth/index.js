import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { hasPermission } from './permissions.js';

const SESSION_COOKIE = 'loopk_session';

// What an access token may do: read, or read and write (AAPS). Neither
// includes managing access, which is for admins signed in to the web UI.
// Model upload tokens (modelling/export.py) may only manage prediction
// models, which are outside `api` so that write tokens do not get it.
const TOKEN_READ = ['api:*:read'];
const TOKEN_WRITE = ['api'];
const TOKEN_MODEL = ['model'];
/** The permission uploading a prediction model requires. */
export const UPLOAD_MODEL = 'model:upload';
// People read; admins may do everything.
const PERSON = ['api:*:read'];
const ADMIN = ['*'];
/** The permission access management requires. */
export const MANAGE_ACCESS = 'admin';
// Lifetime of JWTs handed to API clients (Nightscout uses 8 hours too).
const JWT_LIFETIME = '8h';

function timingSafeEqualStr (a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Authentication and authorization: access tokens ("subjects" in Nightscout)
 * that read or read and write, JWTs derived from them, and Google signed-in
 * browser sessions of people and admins.
 */
export class Auth {
  constructor (pool, config) {
    this.pool = pool;
    this.config = config;
    this.subjects = [];
  }

  async init () {
    // The JWT signing key is generated on first start and kept in the database.
    const { rows } = await this.pool.query(
      `INSERT INTO server_keys (name, value) VALUES ('jwt', $1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING value`,
      [crypto.randomBytes(48).toString('base64url')]);
    this.jwtSecret = rows[0].value;
    await this.reload();
  }

  async reload () {
    const { rows } = await this.pool.query(
      'SELECT id, name, can_write, can_upload_model, notes, access_token, created_at FROM subjects ORDER BY name');
    this.subjects = rows;
  }

  static subjectPermissions (subject) {
    if (subject.can_upload_model) return TOKEN_MODEL;
    return subject.can_write ? TOKEN_WRITE : TOKEN_READ;
  }

  static userPermissions (user) {
    return user.is_admin ? ADMIN : PERSON;
  }

  // --- access tokens ---------------------------------------------------------

  static generateAccessToken (name) {
    const abbrev = name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
    return `${abbrev}-${crypto.randomBytes(8).toString('hex')}`;
  }

  findSubject (accessToken) {
    if (!accessToken) return null;
    return this.subjects.find((s) => timingSafeEqualStr(s.access_token, accessToken)) || null;
  }

  async createSubject ({ name, canWrite = false, canUploadModel = false, notes = null }) {
    const token = Auth.generateAccessToken(name);
    const { rows } = await this.pool.query(
      `INSERT INTO subjects (name, can_write, can_upload_model, notes, access_token) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, canWrite, canUploadModel, notes, token]);
    await this.reload();
    return rows[0];
  }

  async updateSubject (id, { name, canWrite, canUploadModel, notes }) {
    const { rows } = await this.pool.query(
      `UPDATE subjects SET name = coalesce($2, name), can_write = coalesce($3, can_write),
              can_upload_model = coalesce($4, can_upload_model), notes = coalesce($5, notes)
       WHERE id = $1 RETURNING *`, [id, name ?? null, canWrite ?? null, canUploadModel ?? null, notes ?? null]);
    await this.reload();
    return rows[0] || null;
  }

  async deleteSubject (id) {
    const { rowCount } = await this.pool.query('DELETE FROM subjects WHERE id = $1', [id]);
    await this.reload();
    return rowCount > 0;
  }

  // --- JWT -------------------------------------------------------------------

  signJWT (payload, expiresIn = JWT_LIFETIME) {
    return jwt.sign(payload, this.jwtSecret, { expiresIn });
  }

  verifyJWT (token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch {
      return null;
    }
  }

  /**
   * Exchanges an access token (or a still valid JWT) for a fresh JWT
   * (GET /api/v2/authorization/request/:accessToken).
   */
  authorize (accessToken) {
    const decoded = this.verifyJWT(accessToken);
    const subject = this.findSubject(decoded?.accessToken || accessToken);
    if (!subject) return null;
    const token = this.signJWT({ accessToken: subject.access_token });
    const { iat, exp } = this.verifyJWT(token);
    return {
      token,
      sub: subject.name,
      permissionGroups: [Auth.subjectPermissions(subject)],
      iat,
      exp,
    };
  }

  // --- sessions --------------------------------------------------------------

  sessionCookieName () {
    return SESSION_COOKIE;
  }

  signSession (user) {
    return this.signJWT({ typ: 'session', email: user.email }, '30d');
  }

  async userForSession (cookie) {
    const decoded = cookie && this.verifyJWT(cookie);
    if (decoded?.typ === 'session') {
      const { rows } = await this.pool.query('SELECT * FROM users WHERE email = $1', [decoded.email]);
      if (rows[0]) return rows[0];
    }
    // Local development without Google sign-in (AUTH_DISABLED, localhost only).
    if (this.config.authDisabled) return { email: 'local@localhost', name: 'Local', is_admin: true };
    return null;
  }

  // --- resolution ------------------------------------------------------------

  forSubject (subject) {
    return {
      subject: { name: subject.name, id: subject.id },
      permissions: Auth.subjectPermissions(subject),
    };
  }

  /** Resolves an access token, or a JWT made from one, to permissions. */
  resolveToken (tokenOrJwt) {
    const decoded = this.verifyJWT(tokenOrJwt);
    const subject = this.findSubject(decoded?.accessToken || tokenOrJwt);
    return subject ? this.forSubject(subject) : null;
  }

  /**
   * Resolves the caller's permissions from a request. Returns
   * { permissions, subject?, user?, attempted, failed }.
   */
  async fromRequest (req) {
    if (req._auth) return req._auth;
    const result = await this.resolveRequest(req);
    req._auth = result;
    return result;
  }

  async resolveRequest (req) {
    const header = req.get('authorization') || '';
    const bearer = /^bearer\s+(.*)$/i.exec(header);
    if (bearer) {
      const decoded = this.verifyJWT(bearer[1].trim());
      const subject = decoded && !decoded.typ && this.findSubject(decoded.accessToken);
      if (subject) return { ...this.forSubject(subject), attempted: true };
      // Fall through to other mechanisms only when no token was given at all.
      if (bearer[1].trim()) return { permissions: [], attempted: true, failed: true };
    }

    const token = req.query.token;
    if (token) {
      const resolved = this.resolveToken(token);
      if (resolved) return { ...resolved, attempted: true };
      return { permissions: [], attempted: true, failed: true };
    }

    const user = await this.userForSession(req.cookies?.[SESSION_COOKIE]);
    if (user) {
      return {
        user,
        subject: { name: user.email },
        permissions: Auth.userPermissions(user),
        attempted: true,
      };
    }

    return { permissions: [], attempted: false };
  }

  can (auth, permission) {
    return hasPermission(auth?.permissions, permission);
  }

  /** Express middleware factory: demands a permission (401 if not signed in, 403 if not allowed). */
  require (permission) {
    return async (req, res, next) => {
      try {
        const auth = await this.fromRequest(req);
        if (this.can(auth, permission)) return next();
        if (auth.attempted && !auth.failed) return res.status(403).json({ status: 403, message: 'Forbidden', description: 'Only admins may do this' });
        res.status(401).json({ status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
      } catch (err) {
        next(err);
      }
    };
  }
}
