import { SCHEMAS, PROFILE_FIELDS, SCHEDULE_KINDS, PREDICTION_SOURCES } from './schema.js';

export class BadFilterError extends Error {}

const quote = (col) => `"${col}"`;
const COMPARATORS = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const FIELD_RE = /^[A-Za-z0-9_$@-]+(\.[A-Za-z0-9_$@-]+)*$/;
const ISO_SQL = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Epoch milliseconds <-> timestamptz in SQL; exact for integers, and keeps the
// microseconds of fractional values, so comparisons match the numbers'.
const MS_TO_TS_SQL = (ms) => `(timestamptz 'epoch' + ${ms} * interval '1 millisecond')`;
const TS_TO_MS_SQL = (col) => `(extract(epoch FROM ${col}) * 1000)::bigint`;
// The epoch milliseconds a JavaScript Date holds from year 1 on (timestamptz starts at 4713 BC).
const MIN_MS = -62135596800000;
const MAX_MS = 8.64e15;

// --- document paths ----------------------------------------------------------

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function getPath (obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Deletes obj[a][b][c] and the parent objects left empty by that. */
function deletePath (obj, parts) {
  const parents = [];
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    parents.push(cur);
    cur = cur[p];
  }
  delete cur[parts[parts.length - 1]];
  for (let i = parts.length - 2; i >= 0; i--) {
    const child = parents[i][parts[i]];
    if (isPlainObject(child) && Object.keys(child).length === 0) delete parents[i][parts[i]];
    else break;
  }
}

function setPath (obj, parts, value) {
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

// --- values ------------------------------------------------------------------

/** The column value for a document value, or undefined if it does not fit the column. */
function toColumn (type, v) {
  switch (type) {
    case 'text': return typeof v === 'string' ? v : undefined;
    case 'double': return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    case 'bigint': return Number.isSafeInteger(v) ? v : undefined;
    case 'int': return Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? v : undefined;
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'ts': {
      if (typeof v !== 'string') return undefined;
      const d = new Date(v);
      // Only timestamps that render back identically, so documents round-trip.
      return !Number.isNaN(d.getTime()) && d.toISOString() === v ? d : undefined;
    }
    case 'ms': return Number.isSafeInteger(v) && v >= MIN_MS && v <= MAX_MS ? new Date(v) : undefined;
    case 'textArray': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
    case 'json': return JSON.stringify(v);
    case 'jsonString': {
      if (typeof v !== 'string') return undefined;
      try {
        const parsed = JSON.parse(v);
        return isPlainObject(parsed) ? JSON.stringify(parsed) : undefined;
      } catch {
        return undefined;
      }
    }
    default: throw new Error(`Unknown column type ${type}`);
  }
}

function fromColumn (type, v) {
  if (type === 'ts') return v.toISOString();
  if (type === 'ms') return v.getTime();
  if (type === 'jsonString') return JSON.stringify(v);
  return v;
}

/**
 * Splits a document into column values and `extra`: the fields without a
 * column, and values whose type does not fit their column (including null).
 */
export function docToColumns (fields, doc) {
  const rest = structuredClone(doc);
  const values = {};
  for (const [path, col, type] of fields) {
    const parts = path.split('.');
    const v = getPath(rest, parts);
    if (v === undefined || v === null) continue;
    const c = toColumn(type, v);
    if (c === undefined) continue;
    values[col] = c;
    deletePath(rest, parts);
  }
  return { values, extra: Object.keys(rest).length ? rest : null };
}

export function columnsToDoc (fields, row) {
  const doc = row.extra ? structuredClone(row.extra) : {};
  for (const [path, col, type] of fields) {
    const v = row[col];
    if (v !== null && v !== undefined) setPath(doc, path.split('.'), fromColumn(type, v));
  }
  return doc;
}

function json (v) {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

// Postgres takes at most 65535 parameters per statement.
const MAX_PARAMS = 60000;

/**
 * Inserts rows (objects of column values) with multi-row INSERTs; `suffix`
 * is appended to each statement (e.g. ON CONFLICT ...).
 */
async function insertRows (client, table, rows, { columns, suffix = '' } = {}) {
  if (!rows.length) return;
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const params = [];
    const tuples = chunk.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(', ')})`);
    await client.query(`INSERT INTO ${table} (${cols.map(quote).join(', ')}) VALUES ${tuples.join(', ')} ${suffix}`, params);
  }
}

// --- profiles (profile.store entries and treatments' profileJson) -------------

const STORE_FIELDS = [...PROFILE_FIELDS, ['startDate', 'start_date', 'text']];
const SCHEDULE_KEYS = ['time', 'timeAsSeconds', 'value'];

/** Schedule rows for a list of { time, timeAsSeconds, value }, or null if it has another shape. */
function scheduleRows (list) {
  if (!Array.isArray(list)) return null;
  const rows = [];
  for (const [position, e] of list.entries()) {
    if (!isPlainObject(e) || Object.keys(e).some((k) => !SCHEDULE_KEYS.includes(k))) return null;
    const { time = null, timeAsSeconds: seconds = null, value } = e;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (time !== null && typeof time !== 'string') return null;
    if (seconds !== null && !Number.isInteger(seconds)) return null;
    rows.push({ position, time, seconds, value });
  }
  return rows;
}

/** Splits a profile into columns, schedules and extra. */
function splitProfile (body, fields) {
  const rest = { ...body };
  const schedules = {};
  for (const kind of SCHEDULE_KINDS) {
    const rows = scheduleRows(rest[kind]);
    if (rows) {
      schedules[kind] = rows;
      delete rest[kind];
    }
  }
  return { ...docToColumns(fields, rest), schedules };
}

function joinProfile (fields, row, schedules) {
  const body = columnsToDoc(fields, row);
  for (const kind of SCHEDULE_KINDS) {
    if (!schedules.some((s) => s.kind === kind)) continue;
    body[kind] = schedules
      .filter((s) => s.kind === kind)
      .sort((a, b) => a.position - b.position)
      .map((s) => {
        const e = {};
        if (s.time !== null) e.time = s.time;
        if (s.seconds !== null) e.timeAsSeconds = s.seconds;
        e.value = s.value;
        return e;
      });
  }
  return body;
}

function scheduleTableRows (key, schedules) {
  return Object.entries(schedules).flatMap(([kind, rows]) => rows.map((r) => ({ ...key, kind, ...r })));
}

// --- child tables ----------------------------------------------------------------

/**
 * Nested structures stored in child tables, per collection: `split` takes
 * them out of the document (before the column mapping), `rows` turns them
 * into rows per child table (`tables`, parents first, all keyed by `key`;
 * deleting from the first cascades to the others), `load` reads them for a
 * set of documents and `join` puts them back.
 */
const CHILDREN = {
  treatments: {
    split (doc) {
      if (typeof doc.profileJson !== 'string') return null;
      let body;
      try {
        body = JSON.parse(doc.profileJson);
      } catch {
        return null;
      }
      if (!isPlainObject(body)) return null;
      delete doc.profileJson;
      return splitProfile(body, PROFILE_FIELDS);
    },
    key: 'treatment_identifier',
    tables: ['treatment_profiles', 'treatment_profile_schedules'],
    rows (id, profile) {
      return {
        treatment_profiles: [{ treatment_identifier: id, ...profile.values, extra: json(profile.extra) }],
        treatment_profile_schedules: scheduleTableRows({ treatment_identifier: id }, profile.schedules),
      };
    },
    async load (db, ids) {
      const [profiles, schedules] = await Promise.all([
        db.query('SELECT * FROM treatment_profiles WHERE treatment_identifier = ANY($1)', [ids]),
        db.query('SELECT * FROM treatment_profile_schedules WHERE treatment_identifier = ANY($1)', [ids]),
      ]);
      return (id) => {
        const row = profiles.rows.find((p) => p.treatment_identifier === id);
        if (!row) return null;
        return joinProfile(PROFILE_FIELDS, row, schedules.rows.filter((s) => s.treatment_identifier === id));
      };
    },
    join (doc, profile) {
      if (profile) doc.profileJson = JSON.stringify(profile);
    },
  },

  profile: {
    split (doc) {
      if (!isPlainObject(doc.store)) return null;
      const stores = Object.entries(doc.store);
      if (!stores.every(([, body]) => isPlainObject(body))) return null;
      delete doc.store;
      return stores.map(([name, body]) => ({ name, ...splitProfile(body, STORE_FIELDS) }));
    },
    key: 'profile_identifier',
    tables: ['profile_stores', 'profile_store_schedules'],
    rows (id, stores) {
      return {
        profile_stores: stores.map((s) => ({ profile_identifier: id, name: s.name, ...s.values, extra: json(s.extra) })),
        profile_store_schedules: stores.flatMap((s) => scheduleTableRows({ profile_identifier: id, name: s.name }, s.schedules)),
      };
    },
    async load (db, ids) {
      const [stores, schedules] = await Promise.all([
        db.query('SELECT * FROM profile_stores WHERE profile_identifier = ANY($1) ORDER BY name', [ids]),
        db.query('SELECT * FROM profile_store_schedules WHERE profile_identifier = ANY($1)', [ids]),
      ]);
      return (id) => {
        const mine = stores.rows.filter((s) => s.profile_identifier === id);
        if (!mine.length) return null;
        const store = {};
        for (const s of mine) {
          const own = schedules.rows.filter((x) => x.profile_identifier === id && x.name === s.name);
          store[s.name] = joinProfile(STORE_FIELDS, s, own);
        }
        return store;
      };
    },
    join (doc, store) {
      if (store) doc.store = store;
    },
  },

  // Predicted glucose curves: one row per curve, its values as an array.
  devicestatus: {
    split (doc) {
      const curves = [];
      for (const source of PREDICTION_SOURCES) {
        const pred = getPath(doc, ['openaps', source, 'predBGs']);
        if (!isPlainObject(pred) || !Object.keys(pred).length) continue;
        const entries = Object.entries(pred);
        if (!entries.every(([, list]) => Array.isArray(list) && list.every((v) => typeof v === 'number' && Number.isFinite(v)))) continue;
        for (const [curve, values] of entries) curves.push({ source, curve, values });
        deletePath(doc, ['openaps', source, 'predBGs']);
      }
      return curves.length ? curves : null;
    },
    key: 'devicestatus_identifier',
    tables: ['devicestatus_predictions'],
    rows (id, curves) {
      return { devicestatus_predictions: curves.map((c) => ({ devicestatus_identifier: id, ...c })) };
    },
    async load (db, ids) {
      const { rows } = await db.query(
        `SELECT devicestatus_identifier, source, curve, "values" FROM devicestatus_predictions
         WHERE devicestatus_identifier = ANY($1) ORDER BY devicestatus_identifier, source, curve`, [ids]);
      const byId = new Map();
      for (const r of rows) {
        if (!byId.has(r.devicestatus_identifier)) byId.set(r.devicestatus_identifier, []);
        byId.get(r.devicestatus_identifier).push(r);
      }
      return (id) => byId.get(id) || null;
    },
    join (doc, rows) {
      for (const r of rows || []) setPath(doc, ['openaps', r.source, 'predBGs', r.curve], r.values);
    },
  },
};

/**
 * How a document of `table` is stored: column values, `extra`, and the part
 * kept in child tables (null if none; arrays/objects with their own `extra`).
 */
export function splitDocument (table, doc) {
  const copy = structuredClone(doc);
  const children = CHILDREN[table] ? CHILDREN[table].split(copy) : null;
  return { ...docToColumns(SCHEMAS[table], copy), children };
}

// --- queries -------------------------------------------------------------------

// A parameter typed like its column lets Postgres use the column's index:
// comparing a bigint column with a numeric value casts every row instead.
const NUMBER_SQL_TYPES = { bigint: 'bigint', int: 'bigint', double: 'double precision' };
const NOT_NULL_COLUMNS = new Set(['identifier', 'srv_created', 'srv_modified']);

/** The SQL type to cast number parameters for field `f` to; numeric keeps fractions exact for integer columns. */
function numberCast (f, values) {
  if (f.numberType === 'bigint') return values.every(Number.isSafeInteger) ? 'bigint' : 'numeric';
  return f.numberType || 'numeric';
}

/**
 * Translates Nightscout filter definitions ({ field, operator, value }) and
 * sorts into SQL: mapped fields compare their column, other fields the value
 * at their path in `extra`.
 */
class QueryBuilder {
  constructor (fieldsByPath) {
    this.fieldsByPath = fieldsByPath;
    this.params = [];
  }

  param (value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  field (name) {
    const f = this.fieldsByPath.get(name);
    if (f) {
      const [, col, type] = f;
      const kind = { json: 'jsonb', jsonString: 'jsonb', double: 'number', bigint: 'number', int: 'number', bool: 'boolean' }[type] || type;
      return { sql: quote(col), type: kind, numberType: NUMBER_SQL_TYPES[type], notNull: NOT_NULL_COLUMNS.has(col) };
    }
    if (!FIELD_RE.test(name)) throw new BadFilterError(`Invalid field ${name}`);
    return { sql: `(extra #> ${this.param(name.split('.'))}::text[])`, type: 'jsonb' };
  }

  condition ({ field, operator, value }) {
    const f = this.field(field);

    if (operator === 'in' || operator === 'nin') {
      const values = String(value).split('|');
      let match;
      if (f.type === 'jsonb') {
        match = `(jsonb_typeof(${f.sql}) IN ('string', 'number') AND ${f.sql} #>> '{}' = ANY(${this.param(values)}::text[]))`;
      } else if (f.type === 'number') {
        const numbers = values.map(Number).filter(Number.isFinite);
        match = `${f.sql} = ANY(${this.param(numbers)}::${numberCast(f, numbers)}[])`;
      } else if (f.type === 'ms') {
        const numbers = values.map(Number).filter(Number.isFinite);
        match = `${f.sql} = ANY(ARRAY(SELECT ${MS_TO_TS_SQL('ms')} FROM unnest(${this.param(numbers)}::double precision[]) ms))`;
      } else if (f.type === 'ts') {
        match = `${f.sql} = ANY(${this.param(values.filter((v) => !Number.isNaN(Date.parse(v))))}::timestamptz[])`;
      } else {
        match = `${f.sql}::text = ANY(${this.param(values)}::text[])`;
      }
      return operator === 'in' ? match : `(${f.sql} IS NULL OR NOT ${match})`;
    }

    if (operator === 're') {
      const re = this.param(String(value));
      if (f.type === 'jsonb') return `(jsonb_typeof(${f.sql}) = 'string' AND ${f.sql} #>> '{}' ~ ${re})`;
      if (f.type === 'ts') return `${ISO_SQL(f.sql)} ~ ${re}`;
      if (f.type === 'ms') return `${TS_TO_MS_SQL(f.sql)}::text ~ ${re}`;
      return `${f.sql}::text ~ ${re}`;
    }

    if (operator !== 'ne' && !COMPARATORS[operator]) throw new BadFilterError(`Unsupported filter operator ${operator}`);

    if (f.type === 'jsonb') {
      const p = this.param(JSON.stringify(value));
      if (operator === 'ne') return `${f.sql} IS DISTINCT FROM ${p}::jsonb`;
      if (operator === 'eq') return `${f.sql} = ${p}::jsonb`;
      // Mongo only compares values of the same type.
      return `(jsonb_typeof(${f.sql}) = jsonb_typeof(${p}::jsonb) AND ${f.sql} ${COMPARATORS[operator]} ${p}::jsonb)`;
    }

    const typed = this.typedParam(f, value);
    if (typed === null) return operator === 'ne' ? 'TRUE' : 'FALSE';
    if (operator === 'ne') return `${f.sql} IS DISTINCT FROM ${typed}`;
    return `${f.sql} ${COMPARATORS[operator]} ${typed}`;
  }

  /** The value as a typed parameter, or null if no value of the column can match it (Mongo semantics). */
  typedParam ({ type, ...f }, value) {
    if (type === 'number') return typeof value === 'number' ? `${this.param(value)}::${numberCast(f, [value])}` : null;
    if (type === 'ms') return typeof value === 'number' && Number.isFinite(value) ? MS_TO_TS_SQL(`${this.param(value)}::double precision`) : null;
    if (type === 'boolean') return typeof value === 'boolean' ? `${this.param(value)}::boolean` : null;
    if (type === 'ts') return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? `${this.param(value)}::timestamptz` : null;
    return typeof value === 'string' ? `${this.param(value)}::text` : null;
  }

  where (filter, { logicalOperator = 'and', onlyValid = false } = {}) {
    const clauses = (filter || []).map((item) => this.condition(item));
    let sql = clauses.length ? clauses.join(logicalOperator === 'or' ? ' OR ' : ' AND ') : 'TRUE';
    if (onlyValid) sql = `(${sql}) AND is_valid IS DISTINCT FROM false`;
    return sql;
  }

  orderBy (sort) {
    const parts = Object.entries(sort || {}).map(([name, dir]) => {
      const f = this.field(name);
      // Mongo sorts nulls lowest. The date indexes are built NULLS FIRST to
      // match; columns without nulls use the plain order their index has.
      if (f.notNull) return dir < 0 ? `${f.sql} DESC` : `${f.sql} ASC`;
      return dir < 0 ? `${f.sql} DESC NULLS LAST` : `${f.sql} ASC NULLS FIRST`;
    });
    parts.push('identifier');
    return parts.join(', ');
  }
}

// --- duplicate treatments --------------------------------------------------------

/**
 * On a document returned by CollectionStore.insert: identifiers that the
 * write moved to removed_treatments as duplicates, possibly including the
 * document's own (see migrations/0010_treatment_cleanup.sql).
 */
export const REMOVED = Symbol('removed');

// Duplicates are within 60 s of each other; documents this close together
// are checked as one stretch.
const DUPLICATE_MS = 60000;
const STRETCH_MS = 10 * DUPLICATE_MS;

/** [from, to] stretches (ms) covering the dates, merging close ones. */
function stretches (dates) {
  const sorted = dates.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d - last[1] <= STRETCH_MS) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

// --- store -----------------------------------------------------------------------

/** A collection table (and its child tables), read and written as APIv3 documents. */
export class CollectionStore {
  constructor (pool, table) {
    if (!SCHEMAS[table]) throw new Error(`Unknown collection ${table}`);
    this.pool = pool;
    this.table = table;
    this.fields = SCHEMAS[table];
    this.fieldsByPath = new Map(this.fields.map((f) => [f[0], f]));
    this.columns = [...this.fields.map((f) => f[1]), 'extra'];
    this.children = CHILDREN[table] || null;
  }

  async toDocs (db, rows) {
    const lookup = this.children && rows.length
      ? await this.children.load(db, rows.map((r) => r.identifier))
      : null;
    return rows.map((row) => {
      const doc = columnsToDoc(this.fields, row);
      if (lookup) this.children.join(doc, lookup(row.identifier));
      return doc;
    });
  }

  async findMany ({ filter, sort, limit, skip = 0, onlyValid = false, logicalOperator = 'and' }) {
    const q = new QueryBuilder(this.fieldsByPath);
    const where = q.where(filter, { logicalOperator, onlyValid });
    const order = q.orderBy(sort);
    let sql = `SELECT * FROM ${this.table} WHERE ${where} ORDER BY ${order}`;
    if (limit) sql += ` LIMIT ${q.param(limit)}`;
    if (skip) sql += ` OFFSET ${q.param(skip)}`;
    const { rows } = await this.pool.query(sql, q.params);
    return this.toDocs(this.pool, rows);
  }

  async findOne (identifier, db = this.pool, { lock = false } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM ${this.table} WHERE identifier = $1${lock ? ' FOR UPDATE' : ''}`, [identifier]);
    return rows.length ? (await this.toDocs(db, rows))[0] : null;
  }

  async transaction (fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Replaces the child rows of documents: [{ identifier, children }] as split by splitDocument. */
  async writeChildren (client, parts) {
    const c = this.children;
    if (!c || !parts.length) return;
    await client.query(`DELETE FROM ${c.tables[0]} WHERE ${quote(c.key)} = ANY($1)`, [parts.map((p) => p.identifier)]);
    const rows = Object.fromEntries(c.tables.map((t) => [t, []]));
    for (const p of parts) {
      if (!p.children) continue;
      for (const [t, list] of Object.entries(c.rows(p.identifier, p.children))) rows[t].push(...list);
    }
    for (const t of c.tables) await insertRows(client, t, rows[t]);
  }

  /**
   * Moves the treatments that duplicate others near `dates` (ms) to
   * removed_treatments, as AAPS's re-syncs upload doses again under new
   * identifiers. Returns the identifiers moved.
   */
  async removeDuplicates (client, dates) {
    if (this.table !== 'treatments') return [];
    const removed = [];
    for (const [from, to] of stretches(dates)) {
      const { rows } = await client.query('SELECT remove_duplicate_treatments($1, $2) AS identifier',
        [new Date(from - DUPLICATE_MS), new Date(to + DUPLICATE_MS)]);
      removed.push(...rows.map((r) => r.identifier));
    }
    return removed;
  }

  /**
   * Stores a whole document: a new row, or every column of the existing one.
   * Returns the stored document; a new treatment may be moved away as a
   * duplicate (see REMOVED).
   */
  async write (client, doc, { insert }) {
    const { values, extra, children: childPart } = splitDocument(this.table, doc);
    const row = { ...values, extra: json(extra) };
    if (insert) {
      await insertRows(client, this.table, [row]);
    } else {
      const cols = this.columns.filter((c) => c !== 'identifier');
      const { rowCount } = await client.query(
        `UPDATE ${this.table} SET ${cols.map((c, i) => `${quote(c)} = $${i + 2}`).join(', ')} WHERE identifier = $1`,
        [doc.identifier, ...cols.map((c) => row[c] ?? null)]);
      if (!rowCount) throw new Error(`No ${this.table} document ${doc.identifier}`);
    }
    await this.writeChildren(client, [{ identifier: doc.identifier, children: childPart }]);
    const removed = insert ? await this.removeDuplicates(client, [doc.date]) : [];
    const stored = removed.includes(doc.identifier) ? { ...doc } : await this.findOne(doc.identifier, client);
    if (removed.length) stored[REMOVED] = removed;
    return stored;
  }

  /**
   * Inserts or replaces many documents (by identifier) in one transaction,
   * keeping their srvCreated/srvModified: for importing and following.
   * Returns the identifiers of treatments moved away as duplicates.
   */
  bulkUpsert (docs) {
    if (!docs.length) return Promise.resolve([]);
    // One row per identifier: a statement cannot upsert the same row twice.
    const latest = [...new Map(docs.map((d) => [d.identifier, d])).values()];
    const parts = latest.map((doc) => {
      const { values, extra, children } = splitDocument(this.table, doc);
      return { identifier: doc.identifier, row: { ...values, extra: json(extra) }, children };
    });
    const updates = this.columns.filter((c) => c !== 'identifier').map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ');
    return this.transaction(async (client) => {
      await insertRows(client, this.table, parts.map((p) => p.row), { columns: this.columns, suffix: `ON CONFLICT (identifier) DO UPDATE SET ${updates}` });
      await this.writeChildren(client, parts);
      return this.removeDuplicates(client, latest.map((d) => d.date));
    });
  }

  insert (doc) {
    return this.transaction((client) => this.write(client, doc, { insert: true }));
  }

  replace (doc) {
    return this.transaction((client) => this.write(client, doc, { insert: false }));
  }

  /** Shallow-merges `fields` into the stored document (Mongo $set); null if there is none. */
  patch (identifier, fields) {
    return this.transaction(async (client) => {
      const stored = await this.findOne(identifier, client, { lock: true });
      if (!stored) return null;
      return this.write(client, { ...stored, ...fields, identifier }, { insert: false });
    });
  }

  async deleteOne (identifier) {
    const { rowCount } = await this.pool.query(`DELETE FROM ${this.table} WHERE identifier = $1`, [identifier]);
    return rowCount;
  }

  async lastModified () {
    const { rows } = await this.pool.query(`SELECT max(srv_modified) AS m FROM ${this.table}`);
    return rows[0].m ? rows[0].m.getTime() : null;
  }
}
