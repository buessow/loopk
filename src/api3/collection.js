import path from 'node:path';
import { BadFilterError, REMOVED } from '../data/index.js';
import {
  HTTP, MSG, ResponseSent, sendJSON, sendStatus, parseDate, floorSeconds, resolveIdentifier,
  validateUpdate, validateCommon, projector, render, isNumberInString, API3_MAX_LIMIT,
} from './tools.js';

/** The generic APIv3 collections. */
export const COLLECTIONS = {
  devicestatus: {},
  entries: {},
  food: {},
  heartrate: {},
  profile: {},
  settings: {},
  treatments: {},
};

const RESERVED_PARAMS = ['token', 'sort', 'sort$desc', 'limit', 'skip', 'fields', 'now'];
const FILTER_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 're'];
const FILTER_RE = /(.*)\$([a-zA-Z]+)/;

/**
 * One APIv3 collection: its storage plus the generic CRUD/search/history
 * operations, with Nightscout's semantics (deduplication, soft delete,
 * srvModified bookkeeping, socket broadcast).
 */
export class Collection {
  constructor ({ ctx, colName }) {
    this.ctx = ctx;
    this.colName = colName;
    this.storage = ctx.data.collection(colName);
  }

  // --- helpers ---------------------------------------------------------------

  async demand (req, res, permission) {
    if (this.ctx.data.upstream && !permission.endsWith(':read') && !permission.endsWith(':admin')) {
      throw sendStatus(res, HTTP.FORBIDDEN, `This server shows the data of ${this.ctx.data.upstream} and accepts no changes; send them to that server`);
    }
    if (this.ctx.follower && !permission.endsWith(':read') && !permission.endsWith(':admin')) {
      throw sendStatus(res, HTTP.FORBIDDEN, `This server follows ${this.ctx.follower.url} and accepts no changes; make them there.`);
    }
    const auth = await this.ctx.auth.fromRequest(req);
    if (!this.ctx.auth.can(auth, permission)) {
      throw sendStatus(res, HTTP.FORBIDDEN, MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', permission));
    }
  }

  readPermission () {
    return this.colName === 'settings' ? `api:${this.colName}:admin` : `api:${this.colName}:read`;
  }

  parseLimit (req, res) {
    const maxLimit = API3_MAX_LIMIT;
    if (req.query.limit === undefined) return maxLimit;
    const limit = Number(req.query.limit);
    if (!isNaN(limit) && limit > 0 && limit <= maxLimit) return parseInt(req.query.limit, 10);
    throw sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_LIMIT);
  }

  /** Parses date (or created_at) into date + utcOffset and a normalized created_at. */
  parseDocDate (doc) {
    if (!doc || typeof doc !== 'object') return;
    const parsed = parseDate([doc.date, doc.created_at]);
    if (!parsed) return;
    doc.date = parsed.ms;
    if (doc.utcOffset === undefined) doc.utcOffset = parsed.utcOffset;
    doc.created_at = new Date(parsed.ms).toISOString();
  }


  emit (event, payload) {
    this.ctx.bus.emit(event, { colName: this.colName, ...payload });
    this.ctx.bus.emit('data-received', { colName: this.colName });
  }

  // --- routing ---------------------------------------------------------------

  wrap (fn) {
    return async (req, res) => {
      try {
        const auth = await this.ctx.auth.fromRequest(req);
        if (!auth.attempted || auth.failed) {
          const msg = auth.failed ? MSG.HTTP_401_BAD_TOKEN : MSG.HTTP_401_MISSING_OR_BAD_TOKEN;
          return sendStatus(res, HTTP.UNAUTHORIZED, msg);
        }
        await fn.call(this, req, res);
      } catch (err) {
        if (err instanceof ResponseSent) return;
        if (err instanceof BadFilterError) {
          if (!res.headersSent) sendStatus(res, HTTP.BAD_REQUEST, err.message);
          return;
        }
        console.error(err);
        if (!res.headersSent) sendStatus(res, HTTP.INTERNAL_ERROR, MSG.STORAGE_ERROR);
      }
    };
  }

  mapRoutes (router) {
    const prefix = '/' + this.colName;
    router.get(prefix, this.wrap(this.search));
    router.post(prefix, this.wrap(this.create));
    router.get(prefix + '/history', this.wrap(this.history));
    router.get(prefix + '/history/:lastModified', this.wrap(this.history));
    router.get(prefix + '/:identifier', this.wrap(this.read));
    router.put(prefix + '/:identifier', this.wrap(this.update));
    router.patch(prefix + '/:identifier', this.wrap(this.patch));
    router.delete(prefix + '/:identifier', this.wrap(this.remove));
  }

  // --- SEARCH ----------------------------------------------------------------

  parseFilter (req, res) {
    const filter = [];
    for (const param of Object.keys(req.query)) {
      if (RESERVED_PARAMS.includes(param)) continue;
      let field = param;
      let operator = 'eq';
      const match = FILTER_RE.exec(param);
      if (match) {
        operator = match[2];
        field = match[1];
        if (!FILTER_OPERATORS.includes(operator)) {
          throw sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_UNSUPPORTED_FILTER_OPERATOR.replace('{0}', operator));
        }
      }
      let raw = req.query[param];
      if (Array.isArray(raw)) raw = raw[raw.length - 1];
      filter.push({ field, operator, value: parseFilterValue(field, raw) });
    }
    return filter;
  }

  parseSort (req, res) {
    if (req.query.sort && req.query.sort$desc) {
      throw sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_SORT_SORT_DESC);
    }
    const sort = {};
    let dir = 1;
    if (req.query.sort$desc) {
      dir = -1;
      sort[req.query.sort$desc] = dir;
    } else if (req.query.sort) {
      sort[req.query.sort] = dir;
    }
    for (const f of ['identifier', 'created_at', 'date']) if (!(f in sort)) sort[f] = dir;
    return sort;
  }

  parseSkip (req, res) {
    if (req.query.skip === undefined) return 0;
    const skip = Number(req.query.skip);
    if (!isNaN(skip) && skip >= 0) return parseInt(req.query.skip, 10);
    throw sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_SKIP);
  }

  async search (req, res) {
    await this.demand(req, res, this.readPermission());
    const project = projector(req.query.fields);
    const filter = this.parseFilter(req, res);
    const sort = this.parseSort(req, res);
    const limit = this.parseLimit(req, res);
    const skip = this.parseSkip(req, res);
    const docs = await this.storage.findMany({ filter, sort, limit, skip, onlyValid: true });
    res.status(HTTP.OK);
    render(res, docs.map(project));
  }

  // --- READ ------------------------------------------------------------------

  async read (req, res) {
    await this.demand(req, res, `api:${this.colName}:read`);
    const doc = await this.storage.findOne(req.params.identifier);
    if (!doc) return sendJSON(res, { status: HTTP.NOT_FOUND });
    if (doc.isValid === false) return sendJSON(res, { status: HTTP.GONE });

    const modified = doc.srvModified;
    if (modified) {
      res.setHeader('Last-Modified', new Date(modified).toUTCString());
      const ims = req.get('If-Modified-Since');
      if (ims && floorSeconds(modified) <= floorSeconds(new Date(ims).getTime())) {
        return res.status(HTTP.NOT_MODIFIED).end();
      }
    }
    res.status(HTTP.OK);
    render(res, projector(req.query.fields)(doc));
  }

  // --- CREATE ----------------------------------------------------------------

  async create (req, res, retry = true) {
    const doc = req.body;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Object.keys(doc).length) {
      return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_REQUEST_BODY);
    }
    this.parseDocDate(doc);
    resolveIdentifier(doc);
    const existing = typeof doc.identifier === 'string' ? await this.storage.findOne(doc.identifier) : null;
    if (existing) return this.replace(req, res, doc, existing, { isDeduplication: true });
    try {
      await this.insert(req, res, doc);
    } catch (err) {
      // A concurrent request inserted the same identifier: deduplicate.
      if (err.code === '23505' && retry && !res.headersSent) return this.create(req, res, false);
      throw err;
    }
  }

  async insert (req, res, doc) {
    await this.demand(req, res, `api:${this.colName}:create`);
    if (typeof doc.identifier !== 'string' || !doc.identifier.trim()) {
      return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
    }
    const error = validateCommon(doc);
    if (error) return sendStatus(res, HTTP.BAD_REQUEST, error);

    const auth = await this.ctx.auth.fromRequest(req);
    const now = Date.now();
    doc.srvModified = now;
    doc.srvCreated = now;
    if (auth.subject?.name) doc.subject = auth.subject.name;

    const stored = await this.storage.insert(doc);
    res.setHeader('Last-Modified', new Date(now).toUTCString());
    res.setHeader('Location', path.posix.join(req.baseUrl, req.path, stored.identifier));
    sendJSON(res, { status: HTTP.CREATED, fields: { identifier: stored.identifier, lastModified: now } });

    // A duplicate treatment is answered as stored, so that the uploader
    // doesn't retry, but kept in removed_treatments.
    const removed = stored[REMOVED] || [];
    if (!removed.includes(stored.identifier)) this.emit('storage-socket-create', { doc: stored });
    for (const identifier of removed) {
      if (identifier !== stored.identifier) this.emit('storage-socket-delete', { identifier });
    }
  }

  async replace (req, res, doc, storedDoc, { isDeduplication = false } = {}) {
    await this.demand(req, res, `api:${this.colName}:update`);
    const error = validateUpdate(doc, storedDoc, { isDeduplication });
    if (error) return sendStatus(res, ...error);

    const auth = await this.ctx.auth.fromRequest(req);
    const now = Date.now();
    doc.srvModified = now;
    doc.srvCreated = storedDoc.srvCreated || now;
    if (auth.subject?.name) doc.subject = auth.subject.name;

    const stored = await this.storage.replace(doc);

    res.setHeader('Last-Modified', new Date(now).toUTCString());
    const fields = { lastModified: now };
    if (isDeduplication) {
      res.setHeader('Location', path.posix.join(req.baseUrl, req.path, doc.identifier));
      fields.identifier = doc.identifier;
      fields.isDeduplication = true;
    }
    sendJSON(res, { status: HTTP.OK, fields });

    this.emit('storage-socket-update', { doc: stored });
  }

  // --- UPDATE (PUT) ----------------------------------------------------------

  async update (req, res) {
    const doc = req.body;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Object.keys(doc).length) {
      return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_REQUEST_BODY);
    }
    this.parseDocDate(doc);
    resolveIdentifier(doc);
    const identifier = req.params.identifier;
    const storedDoc = await this.storage.findOne(identifier);
    doc.identifier = identifier;

    if (!storedDoc) return this.insert(req, res, doc);

    if (storedDoc.isValid === false) return sendStatus(res, HTTP.GONE);
    const ius = req.get('If-Unmodified-Since');
    if (ius && floorSeconds(storedDoc.srvModified) > floorSeconds(new Date(ius).getTime())) {
      return sendStatus(res, HTTP.PRECONDITION_FAILED);
    }
    return this.replace(req, res, doc, storedDoc);
  }

  // --- PATCH -----------------------------------------------------------------

  async patch (req, res) {
    const doc = req.body;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Object.keys(doc).length) {
      return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_REQUEST_BODY);
    }
    await this.demand(req, res, `api:${this.colName}:update`);

    const storedDoc = await this.storage.findOne(req.params.identifier);
    if (!storedDoc) return sendStatus(res, HTTP.NOT_FOUND);
    if (storedDoc.isValid === false) return sendStatus(res, HTTP.GONE);

    const ius = req.get('If-Unmodified-Since');
    if (ius && floorSeconds(storedDoc.srvModified) > floorSeconds(new Date(ius).getTime())) {
      return sendStatus(res, HTTP.PRECONDITION_FAILED);
    }

    const error = validateUpdate(doc, storedDoc, { isPatching: true });
    if (error) return sendStatus(res, ...error);

    const auth = await this.ctx.auth.fromRequest(req);
    const now = Date.now();
    doc.srvModified = now;
    if (auth.subject?.name) doc.modifiedBy = auth.subject.name;

    const stored = await this.storage.patch(storedDoc.identifier, doc);
    if (!stored) return sendStatus(res, HTTP.NOT_FOUND);
    res.setHeader('Last-Modified', new Date(now).toUTCString());
    sendStatus(res, HTTP.OK);

    this.emit('storage-socket-update', { doc: stored });
  }

  // --- DELETE ----------------------------------------------------------------

  async remove (req, res) {
    await this.demand(req, res, `api:${this.colName}:delete`);
    const identifier = req.params.identifier;
    const doc = await this.storage.findOne(identifier);
    if (!doc) return sendJSON(res, { status: HTTP.NOT_FOUND });
    if (doc.isReadOnly === true || doc.readOnly === true || doc.readonly === true) {
      return sendStatus(res, HTTP.UNPROCESSABLE_ENTITY, MSG.HTTP_422_READONLY_MODIFICATION);
    }

    if (req.query.permanent === 'true') {
      await this.storage.deleteOne(identifier);
    } else {
      const auth = await this.ctx.auth.fromRequest(req);
      const fields = { isValid: false, srvModified: Date.now() };
      if (auth.subject?.name) fields.modifiedBy = auth.subject.name;
      await this.storage.patch(identifier, fields);
    }
    sendJSON(res, { status: HTTP.OK });
    this.emit('storage-socket-delete', { identifier });
  }

  // --- HISTORY ---------------------------------------------------------------

  async history (req, res) {
    await this.demand(req, res, this.readPermission());
    const project = projector(req.query.fields);

    let lastModified;
    let operator;
    if (req.params.lastModified) {
      // "0" (nothing loaded yet) is accepted as the epoch.
      const parsed = /^0+$/.test(req.params.lastModified) ? { ms: 0 } : parseDate(req.params.lastModified);
      if (!parsed) return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_LAST_MODIFIED);
      lastModified = parsed.ms;
      operator = 'gt';
    } else {
      const header = req.get('Last-Modified');
      const ms = header ? new Date(header).getTime() : NaN;
      if (Number.isNaN(ms)) return sendStatus(res, HTTP.BAD_REQUEST, MSG.HTTP_400_BAD_LAST_MODIFIED);
      lastModified = floorSeconds(ms);
      operator = 'gte';
    }

    const limit = this.parseLimit(req, res);
    const docs = await this.storage.findMany({
      filter: [{ field: 'srvModified', operator, value: lastModified }],
      sort: { srvModified: 1 },
      limit,
    });
    if (docs.length) {
      const max = Math.max(...docs.map((d) => d.srvModified || 0));
      res.setHeader('Last-Modified', new Date(max).toUTCString());
      res.setHeader('ETag', `W/"${max}"`);
    }
    res.status(HTTP.OK);
    render(res, docs.map(project));
  }
}

function parseFilterValue (param, value) {
  if (isNumberInString(value)) value = parseFloat(value);
  if (value === 'true') value = true;
  if (value === 'false') value = false;
  if (typeof value === 'string' && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  if (['date', 'srvModified', 'srvCreated'].includes(param)) {
    const parsed = parseDate(value);
    if (parsed) value = parsed.ms;
  }
  if (param === 'created_at') {
    const parsed = parseDate(value);
    if (parsed) value = new Date(parsed.ms).toISOString();
  }
  return value;
}
