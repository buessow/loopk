import { v5 as uuidv5 } from 'uuid';

export const API3_VERSION = '3.0.3-alpha';
export const SERVER_VERSION = '15.0.3';
export const API3_MAX_LIMIT = 1000;
export const MIN_TIMESTAMP = 946684800000;
export const MIN_UTC_OFFSET = -1440;
export const MAX_UTC_OFFSET = 1440;

export const HTTP = {
  OK: 200,
  CREATED: 201,
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  GONE: 410,
  PRECONDITION_FAILED: 412,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_ERROR: 500,
};

export const MSG = {
  HTTP_400_BAD_LAST_MODIFIED: 'Bad or missing Last-Modified header/parameter',
  HTTP_400_BAD_LIMIT: 'Parameter limit out of tolerance',
  HTTP_400_BAD_REQUEST_BODY: 'Bad or missing request body',
  HTTP_400_BAD_FIELD_IDENTIFIER: 'Bad or missing identifier field',
  HTTP_400_BAD_FIELD_DATE: 'Bad or missing date field',
  HTTP_400_BAD_FIELD_UTC: 'Bad or missing utcOffset field',
  HTTP_400_BAD_FIELD_APP: 'Bad or missing app field',
  HTTP_400_BAD_SKIP: 'Parameter skip out of tolerance',
  HTTP_400_SORT_SORT_DESC: 'Parameters sort and sort_desc cannot be combined',
  HTTP_400_UNSUPPORTED_FILTER_OPERATOR: 'Unsupported filter operator {0}',
  HTTP_400_IMMUTABLE_FIELD: 'Field {0} cannot be modified by the client',
  HTTP_401_BAD_TOKEN: 'Bad access token or JWT',
  HTTP_401_MISSING_OR_BAD_TOKEN: 'Missing or bad access token or JWT',
  HTTP_403_MISSING_PERMISSION: 'Missing permission {0}',
  HTTP_404_BAD_OPERATION: 'Bad operation or collection',
  HTTP_406_UNSUPPORTED_FORMAT: 'Unsupported output format requested',
  HTTP_422_READONLY_MODIFICATION: 'Trying to modify read-only document',
  HTTP_500_INTERNAL_ERROR: 'Internal Server Error',
  STORAGE_ERROR: 'Database error',
  SOCKET_MISSING_OR_BAD_ACCESS_TOKEN: 'Missing or bad accessToken',
  SOCKET_UNAUTHORIZED_TO_ANY: 'Unauthorized to receive any collection',
};

// Thrown after a response has been sent, to stop the operation.
export class ResponseSent extends Error {}

export function sendJSON (res, { status = HTTP.OK, result, fields } = {}) {
  const json = { status };
  if (result !== undefined) json.result = result;
  if (fields) Object.assign(json, fields);
  res.status(status).json(json);
}

export function sendStatus (res, status, message, description) {
  const json = { status };
  if (message) json.message = message;
  if (description) json.description = description;
  res.status(status).json(json);
  return new ResponseSent(message);
}

export function isNumberInString (str) {
  return !isNaN(parseFloat(str)) && isFinite(str);
}

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const RFC2822_OFFSET_RE = /([+-])(\d{2})(\d{2})\s*$/;

/**
 * Parses a timestamp (epoch ms, epoch seconds, ISO 8601 or RFC 2822) like
 * Nightscout's moment.parseZone based parser. Accepts an array of candidates.
 * Returns { ms, utcOffset } (offset in minutes) or null.
 */
export function parseDate (value) {
  if (Array.isArray(value)) {
    for (const v of value) {
      const parsed = parseDate(v);
      if (parsed) return parsed;
    }
    return null;
  }
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'string' && isNumberInString(value)) value = parseFloat(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    let ms = value;
    if (ms < MIN_TIMESTAMP) ms = value * 1000;
    if (ms < MIN_TIMESTAMP || Number.isNaN(new Date(ms).getTime())) return null;
    return { ms, utcOffset: -new Date(ms).getTimezoneOffset() };
  }

  if (typeof value === 'string') {
    const s = value.trim();
    let ms;
    let utcOffset = 0;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const m = OFFSET_RE.exec(s);
      // Strings without a zone are taken as UTC, like moment.parseZone does.
      ms = Date.parse(m ? s : s.length > 10 ? `${s}Z` : s);
      if (m) utcOffset = parseOffset(m[1]);
    } else {
      ms = Date.parse(s);
      const m = RFC2822_OFFSET_RE.exec(s);
      if (m) utcOffset = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    }
    if (Number.isNaN(ms) || ms < MIN_TIMESTAMP) return null;
    return { ms, utcOffset };
  }
  return null;
}

function parseOffset (s) {
  if (s.toUpperCase() === 'Z') return 0;
  const sign = s[0] === '-' ? -1 : 1;
  const digits = s.slice(1).replace(':', '');
  return sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
}

export function floorSeconds (ms) {
  return ms - (ms % 1000);
}

const UUID_NAMESPACE = [...Buffer.from('NightscoutRocks!', 'ascii')];

export function calculateIdentifier (doc) {
  let key = doc.device + '_' + doc.date;
  if (doc.eventType) key += '_' + doc.eventType;
  return uuidv5(key, UUID_NAMESPACE);
}

export function resolveIdentifier (doc) {
  const identifier = calculateIdentifier(doc);
  if (!doc.identifier) doc.identifier = identifier;
  else if (doc.identifier !== identifier) {
    console.warn(`APIv3: Identifier mismatch (expected: ${identifier}, received: ${doc.identifier})`);
  }
}

/** Validates date, utcOffset and app. Returns an error message or null. */
export function validateCommon (doc, { isPatching = false } = {}) {
  if ((!isPatching || doc.date !== undefined)
    && (typeof doc.date !== 'number' || doc.date <= MIN_TIMESTAMP)) {
    return MSG.HTTP_400_BAD_FIELD_DATE;
  }
  if ((!isPatching || doc.utcOffset !== undefined)
    && (typeof doc.utcOffset !== 'number' || doc.utcOffset < MIN_UTC_OFFSET || doc.utcOffset > MAX_UTC_OFFSET)) {
    return MSG.HTTP_400_BAD_FIELD_UTC;
  }
  if ((!isPatching || doc.app !== undefined)
    && (typeof doc.app !== 'string' || !doc.app.trim())) {
    return MSG.HTTP_400_BAD_FIELD_APP;
  }
  return null;
}

const IMMUTABLE = ['identifier', 'date', 'utcOffset', 'eventType', 'device', 'app',
  'srvCreated', 'subject', 'srvModified', 'modifiedBy', 'isValid'];

/** Validates an update of storedDoc with doc. Returns [status, message] or null. */
export function validateUpdate (doc, storedDoc, { isPatching = false, isDeduplication = false } = {}) {
  if (storedDoc.isReadOnly === true || storedDoc.readOnly === true || storedDoc.readonly === true) {
    return [HTTP.UNPROCESSABLE_ENTITY, MSG.HTTP_422_READONLY_MODIFICATION];
  }
  if (storedDoc.isValid !== false) {
    for (const field of IMMUTABLE) {
      if (field === 'identifier' && isDeduplication) continue;
      if (doc[field] !== undefined && !sameValue(doc[field], storedDoc[field])) {
        return [HTTP.BAD_REQUEST, MSG.HTTP_400_IMMUTABLE_FIELD.replace('{0}', field)];
      }
    }
  }
  const err = validateCommon(doc, { isPatching });
  return err ? [HTTP.BAD_REQUEST, err] : null;
}

function sameValue (a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Projection by the `fields` query parameter. */
export function projector (fieldsParam) {
  const specific = fieldsParam && fieldsParam !== '_all' ? fieldsParam.split(',') : null;
  return (doc) => {
    if (!specific) return doc;
    const out = {};
    for (const f of specific) if (doc[f] !== undefined) out[f] = doc[f];
    return out;
  };
}

/** Renders a result as json (default), csv or xml depending on Accept. */
export function render (res, data) {
  res.format({
    json: () => res.send({ status: HTTP.OK, result: data }),
    csv: () => res.type('csv').send(toCsv(Array.isArray(data) ? data : [data])),
    xml: () => res.type('xml').send(toXml(data)),
    default: () => sendStatus(res, HTTP.NOT_ACCEPTABLE, MSG.HTTP_406_UNSUPPORTED_FORMAT),
  });
}

function csvCell (v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv (rows) {
  const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';
}

function xmlEscape (s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function xmlNode (name, value) {
  const tag = /^[A-Za-z_][\w.-]*$/.test(name) ? name : 'field';
  if (Array.isArray(value)) return value.map((v) => xmlNode(tag, v)).join('');
  if (value && typeof value === 'object') {
    return `<${tag}>${Object.entries(value).map(([k, v]) => xmlNode(k, v)).join('')}</${tag}>`;
  }
  return `<${tag}>${xmlEscape(value ?? '')}</${tag}>`;
}

function toXml (data) {
  const body = Array.isArray(data) ? data.map((d) => xmlNode('item', d)).join('') : xmlNode('item', data);
  return `<?xml version="1.0" encoding="utf-8"?>\n<response>${body}</response>`;
}
