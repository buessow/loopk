// Analyses the Nightscout MongoDB that is to be migrated: which fields the
// documents have (and had over time), with which types, how they would map
// onto the Postgres schema, and where identifiers or records are duplicated.
// Read-only.
//
//   node --env-file=.env scripts/mongo-analyze.js [--out DIR] [--collections a,b]
//        [--sample N] [--full-limit MB] [--full]
//
// MONGO_URL is the source database, e.g.
//   mongodb://user:pass@host/androidaps?authSource=admin&readPreference=secondary&directConnection=true
// Collections larger than --full-limit MB (default 500) are analysed on a
// random sample of --sample documents (default 100000) unless --full is given;
// the server-side checks always cover every document.
// Writes DIR/report.md and DIR/report.json (default DIR: ./mongo-analysis).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';
import { SCHEMAS } from '../src/db/schema.js';
import { splitDocument } from '../src/db/collection.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'mongo-analysis' },
    collections: { type: 'string' },
    sample: { type: 'string', default: '100000' },
    'full-limit': { type: 'string', default: '500' },
    full: { type: 'boolean', default: false },
  },
});

// Natural keys Nightscout's API v3 deduplicates on (lib/api3/generic/setup.js).
const NATURAL_KEYS = {
  entries: ['date', 'type'],
  treatments: ['created_at', 'eventType'],
  devicestatus: ['created_at', 'device'],
  heartrate: ['created_at'],
  food: ['created_at'],
  profile: ['created_at'],
};
const SANE_FROM = Date.UTC(2015, 0, 1);
const MAX_EXAMPLES = 3;
const MAX_ARRAY_ELEMENTS = 5; // array elements inspected per array

const log = (...a) => console.error(...a);

// --- values -------------------------------------------------------------------

function bsonType (v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (v instanceof ObjectId) return 'objectId';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'object') {
    const bt = v._bsontype;
    if (bt) return bt.toLowerCase();
    return 'object';
  }
  return typeof v;
}

/** The document as API v3 would serve it: BSON values as JSON values, identifier set. */
function toV3 (doc) {
  const conv = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(conv);
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v instanceof ObjectId) return v.toHexString();
    if (v._bsontype === 'Decimal128' || v._bsontype === 'Long' || v._bsontype === 'Double' || v._bsontype === 'Int32') return Number(v.toString());
    if (v._bsontype) return String(v);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
  };
  const out = conv(doc);
  delete out._id;
  if (typeof out.identifier !== 'string') out.identifier = doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id);
  return out;
}

/** When the document's data was recorded: date, else created_at, else the _id timestamp. */
function docTime (doc) {
  if (typeof doc.date === 'number' && Number.isFinite(doc.date)) return doc.date;
  if (doc.created_at instanceof Date) return doc.created_at.getTime();
  if (typeof doc.created_at === 'string') {
    const t = Date.parse(doc.created_at);
    if (!Number.isNaN(t)) return t;
  }
  if (doc._id instanceof ObjectId) return doc._id.getTimestamp().getTime();
  return null;
}

const month = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 7));

function createdAtFormat (v) {
  if (v === undefined) return 'missing';
  if (v instanceof Date) return 'BSON date';
  if (typeof v !== 'string') return bsonType(v);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return 'ISO, ms, Z';
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)) return 'ISO, s, Z';
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:?\d\d$/.test(v)) return 'ISO, offset';
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(v)) return 'ISO, no zone';
  if (/^\d+$/.test(v)) return 'digits';
  return Number.isNaN(Date.parse(v)) ? 'unparseable' : 'other parseable';
}

function example (v) {
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (v instanceof ObjectId) s = v.toHexString();
  else if (typeof v === 'object' && v !== null) return null;
  else s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

// --- statistics ---------------------------------------------------------------

class Counter extends Map {
  add (k, n = 1) { this.set(k, (this.get(k) || 0) + n); }
  sorted () { return [...this.entries()].sort((a, b) => b[1] - a[1]); }
}

class Span {
  constructor () { this.first = null; this.last = null; }
  add (t) {
    if (t == null) return;
    if (this.first == null || t < this.first) this.first = t;
    if (this.last == null || t > this.last) this.last = t;
  }
}

/** Per field path (arrays as `[]`): documents having it, types, time span, examples. */
class PathStats {
  constructor () { this.paths = new Map(); }

  entry (p) {
    let e = this.paths.get(p);
    if (!e) {
      e = { docs: 0, types: new Counter(), span: new Span(), examples: new Set() };
      this.paths.set(p, e);
    }
    return e;
  }

  addDoc (doc, t) {
    const seen = new Set();
    const walk = (v, p) => {
      const e = this.entry(p);
      const type = bsonType(v);
      e.types.add(type);
      if (!seen.has(p)) {
        seen.add(p);
        e.docs++;
        e.span.add(t);
      }
      if (e.examples.size < MAX_EXAMPLES) {
        const ex = example(v);
        if (ex !== null) e.examples.add(ex);
      }
      if (type === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
      else if (type === 'array') for (const x of v.slice(0, MAX_ARRAY_ELEMENTS)) walk(x, `${p}[]`);
    };
    for (const [k, x] of Object.entries(doc)) walk(x, k);
  }

  toJSON () {
    return Object.fromEntries([...this.paths.entries()].sort().map(([p, e]) => [p, {
      docs: e.docs, types: Object.fromEntries(e.types.sorted()), first: month(e.span.first), last: month(e.span.last), examples: [...e.examples],
    }]));
  }
}

/** Leaf paths of a plain JSON value (what ends up in an `extra` column). */
function leafPaths (v, p = '', out = new Set()) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leafPaths(x, p ? `${p}.${k}` : k, out);
  } else {
    out.add(p);
  }
  return out;
}

function getPath (obj, parts) {
  let cur = obj;
  for (const k of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function groupOf (colName, doc) {
  switch (colName) {
    case 'treatments': return doc.eventType ?? '(no eventType)';
    case 'entries': return doc.type ?? '(no type)';
    case 'devicestatus': {
      const device = typeof doc.device === 'string' ? doc.device.split('://')[0] : '(no device)';
      const roots = ['openaps', 'loop', 'pump', 'uploader', 'xdripjs', 'configuration'].filter((k) => doc[k] !== undefined);
      return `${device} [${roots.join(', ')}]`;
    }
    case 'heartrate':
    case 'activity':
      return doc.device ?? doc.app ?? '(no device)';
    default:
      return doc.type ?? '(all)';
  }
}

/** Everything learnt about one collection from scanning its documents. */
class CollectionAnalysis {
  constructor (colName) {
    this.colName = colName;
    this.scanned = 0;
    this.paths = new PathStats();
    this.groups = new Map();
    this.span = new Span();
    this.insane = new Counter(); // documents dated outside [2015, now + 1 day]
    this.createdAt = new Counter();
    this.idTypes = new Counter();
    this.v3 = new Counter(); // documents with / without an API v3 identifier
    this.mapping = SCHEMAS[colName] ? { rejected: new Map(), columns: new Counter(), extra: new Counter() } : null;
  }

  group (name) {
    let g = this.groups.get(name);
    if (!g) {
      g = { docs: 0, span: new Span(), fields: new Counter(), extra: new Counter() };
      this.groups.set(name, g);
    }
    return g;
  }

  add (doc) {
    this.scanned++;
    const t = docTime(doc);
    this.span.add(t);
    if (t == null) this.insane.add('no time');
    else if (t < SANE_FROM) this.insane.add('before 2015');
    else if (t > Date.now() + 86400000) this.insane.add('in the future');
    this.createdAt.add(createdAtFormat(doc.created_at));
    this.idTypes.add(bsonType(doc._id));
    this.v3.add(typeof doc.identifier === 'string' ? 'identifier' : 'no identifier (API v1)');

    const { _id, ...rest } = doc;
    this.paths.addDoc(rest, t);
    const g = this.group(groupOf(this.colName, doc));
    g.docs++;
    g.span.add(t);
    for (const k of Object.keys(rest)) g.fields.add(k);

    if (this.mapping) this.addMapping(toV3(doc), g);
  }

  /** How the document would be stored: columns filled, values rejected by their column, fields left in extra. */
  addMapping (v3, g) {
    const { values, extra, children } = splitDocument(this.colName, v3);
    for (const [p, col, type] of SCHEMAS[this.colName]) {
      if (values[col] !== undefined) {
        this.mapping.columns.add(col);
        continue;
      }
      const v = getPath(v3, p.split('.'));
      if (v === undefined || v === null) continue;
      let r = this.mapping.rejected.get(p);
      if (!r) this.mapping.rejected.set(p, r = { column: `${col} ${type}`, types: new Counter(), examples: new Set() });
      r.types.add(bsonType(v));
      const ex = example(v);
      if (ex !== null && r.examples.size < MAX_EXAMPLES) r.examples.add(ex);
    }
    const extras = new Set(extra ? leafPaths(extra) : []);
    const childExtras = (Array.isArray(children) ? children : children ? [children] : []).filter((c) => c.extra);
    for (const c of childExtras) for (const p of leafPaths(c.extra)) extras.add(`(child) ${p}`);
    for (const p of extras) {
      this.mapping.extra.add(p);
      g.extra.add(p);
    }
  }

  toJSON () {
    const span = (s) => ({ first: s.first && new Date(s.first).toISOString(), last: s.last && new Date(s.last).toISOString() });
    return {
      scanned: this.scanned,
      ...span(this.span),
      outsideSaneRange: Object.fromEntries(this.insane),
      createdAtFormats: Object.fromEntries(this.createdAt.sorted()),
      idTypes: Object.fromEntries(this.idTypes),
      identifiers: Object.fromEntries(this.v3),
      groups: Object.fromEntries([...this.groups.entries()].sort((a, b) => b[1].docs - a[1].docs).map(([k, g]) => [k, {
        docs: g.docs, ...span(g.span), fields: Object.fromEntries(g.fields.sorted()), extra: Object.fromEntries(g.extra.sorted()),
      }])),
      paths: this.paths.toJSON(),
      mapping: this.mapping && {
        columnsFilled: Object.fromEntries(this.mapping.columns.sorted()),
        rejected: Object.fromEntries([...this.mapping.rejected.entries()].map(([p, r]) => [p, {
          column: r.column, types: Object.fromEntries(r.types), examples: [...r.examples],
        }])),
        extra: Object.fromEntries(this.mapping.extra.sorted()),
      },
    };
  }
}

// --- server-side checks (cover every document, transfer little) -------------

async function serverChecks (col, colName) {
  const out = {};
  const opts = { allowDiskUse: true, maxTimeMS: 30 * 60 * 1000 };

  // Top-level fields and their types per year of insertion (_id timestamp).
  const rows = await col.aggregate([
    { $project: { y: { $year: { $toDate: '$_id' } }, kv: { $objectToArray: '$$ROOT' } } },
    { $unwind: '$kv' },
    { $match: { 'kv.k': { $ne: '_id' } } },
    { $group: { _id: { k: '$kv.k', t: { $type: '$kv.v' }, y: '$y' }, n: { $sum: 1 } } },
  ], opts).toArray().catch((err) => { log(`  top-level fields failed: ${err.message}`); return []; });
  const fields = {};
  for (const r of rows) {
    const f = fields[r._id.k] ??= { total: 0, types: {}, years: {} };
    f.total += r.n;
    f.types[r._id.t] = (f.types[r._id.t] || 0) + r.n;
    f.years[r._id.y] = (f.years[r._id.y] || 0) + r.n;
  }
  out.topLevelFields = Object.fromEntries(Object.entries(fields).sort((a, b) => b[1].total - a[1].total));

  // Documents per year of insertion, with and without an API v3 identifier.
  out.perYear = Object.fromEntries((await col.aggregate([
    { $group: { _id: { y: { $year: { $toDate: '$_id' } }, v3: { $eq: [{ $type: '$identifier' }, 'string'] } }, n: { $sum: 1 } } },
    { $sort: { '_id.y': 1 } },
  ], opts).toArray()).map((r) => [`${r._id.y} ${r._id.v3 ? 'v3' : 'v1'}`, r.n]));

  // Identifiers used by more than one document.
  const dupIds = await col.aggregate([
    { $match: { identifier: { $type: 'string' } } },
    { $group: { _id: '$identifier', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, identifiers: { $sum: 1 }, docs: { $sum: '$n' }, examples: { $push: '$_id' } } },
    { $project: { _id: 0, identifiers: 1, docs: 1, examples: { $slice: ['$examples', 5] } } },
  ], opts).toArray();
  out.duplicateIdentifiers = dupIds[0] || { identifiers: 0, docs: 0 };

  // Records stored more than once under different _ids (v1 and v3 copies, re-uploads).
  const key = NATURAL_KEYS[colName];
  if (key) {
    const group = Object.fromEntries(key.map((k) => [k, `$${k}`]));
    const dups = await col.aggregate([
      { $match: Object.fromEntries(key.map((k) => [k, { $exists: true }])) },
      { $group: { _id: group, n: { $sum: 1 }, v3: { $sum: { $cond: [{ $eq: [{ $type: '$identifier' }, 'string'] }, 1, 0] } } } },
      { $match: { n: { $gt: 1 } } },
      { $group: { _id: { v3: { $cond: [{ $gt: ['$v3', 0] }, { $cond: [{ $eq: ['$v3', '$n'] }, 'all v3', 'mixed v1/v3'] }, 'all v1'] } }, keys: { $sum: 1 }, docs: { $sum: '$n' }, examples: { $push: '$_id' } } },
      { $project: { _id: 0, kind: '$_id.v3', keys: 1, docs: 1, examples: { $slice: ['$examples', 3] } } },
    ], opts).toArray();
    out.duplicateRecords = { key, groups: dups };
  }
  return out;
}

// --- scanning -------------------------------------------------------------------

async function scan (col, colName, sizeMB) {
  const analysis = new CollectionAnalysis(colName);
  const total = await col.estimatedDocumentCount();
  const sampleSize = parseInt(args.sample, 10);
  const sampled = !args.full && sizeMB > parseFloat(args['full-limit']) && total > sampleSize;
  const cursor = sampled
    ? col.aggregate([{ $sample: { size: sampleSize } }], { allowDiskUse: true, batchSize: 2000 })
    : col.find({}, { batchSize: 5000 });
  const expected = sampled ? sampleSize : total;
  const started = Date.now();
  let lastLog = started;
  for await (const doc of cursor) {
    analysis.add(doc);
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      const rate = analysis.scanned / ((lastLog - started) / 1000);
      log(`  ${colName}: ${analysis.scanned}/${expected} (${Math.round(rate)}/s, ~${Math.round((expected - analysis.scanned) / rate)} s left)`);
    }
  }
  return { analysis, total, sampled };
}

// --- report ---------------------------------------------------------------------

const pct = (n, of) => (of ? `${(n / of * 100).toFixed(n / of < 0.01 ? 2 : 1)}%` : '–');
const types = (o) => Object.entries(o).map(([t, n]) => `${t} ${n}`).join(', ');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function markdown (report) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('# MongoDB analysis');
  p();
  p(`Source: \`${report.database}\`, ${report.generatedAt}.`);
  p();
  p('| collection | documents | size MB | scanned | in Postgres schema |');
  p('| --- | ---: | ---: | --- | --- |');
  for (const c of report.collections) {
    p(`| ${c.name} | ${c.count} | ${c.sizeMB} | ${c.scan ? (c.sampled ? `random sample of ${c.scan.scanned}` : 'all') : '–'} | ${SCHEMAS[c.name] ? 'yes' : 'no'} |`);
  }

  for (const c of report.collections) {
    if (!c.scan) continue;
    const s = c.scan;
    const n = s.scanned;
    p();
    p(`## ${c.name}`);
    p();
    p(`${c.count} documents${c.sampled ? `, ${n} sampled at random for the field analysis` : ''}; data from ${s.first?.slice(0, 10)} to ${s.last?.slice(0, 10)}.`);
    p();
    p(`- Documents per year of insertion: ${Object.entries(c.server.perYear).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    p(`- Identifiers (scanned): ${types(s.identifiers)}`);
    p(`- \`_id\` types: ${types(s.idTypes)}`);
    p(`- \`created_at\`: ${types(s.createdAtFormats)}`);
    if (Object.keys(s.outsideSaneRange).length) p(`- Dated outside 2015…tomorrow: ${types(s.outsideSaneRange)}`);
    const di = c.server.duplicateIdentifiers;
    p(`- Duplicate identifiers: ${di.identifiers} identifiers on ${di.docs} documents${di.examples?.length ? ` (e.g. ${di.examples.map((x) => `\`${x}\``).join(', ')})` : ''}`);
    if (c.server.duplicateRecords) {
      const d = c.server.duplicateRecords;
      p(`- Same ${d.key.map((k) => `\`${k}\``).join(' + ')} on several documents: ${d.groups.length ? d.groups.map((g) => `${g.kind}: ${g.keys} keys / ${g.docs} docs`).join('; ') : 'none'}`);
      for (const g of d.groups) p(`  - ${g.kind}, e.g. ${g.examples.map((x) => `\`${JSON.stringify(x)}\``).join(', ')}`);
    }

    p();
    p(`### Groups (${c.name === 'treatments' ? 'eventType' : c.name === 'entries' ? 'type' : 'device / content'})`);
    p();
    p('| group | docs | first | last | fields (share of the group\'s docs) |');
    p('| --- | ---: | --- | --- | --- |');
    for (const [name, g] of Object.entries(s.groups)) {
      const fields = Object.entries(g.fields).map(([f, k]) => (k === g.docs ? f : `${f} ${pct(k, g.docs)}`)).join(', ');
      p(`| ${cell(name)} | ${g.docs} | ${g.first?.slice(0, 7) ?? ''} | ${g.last?.slice(0, 7) ?? ''} | ${cell(fields)} |`);
    }

    p();
    p('### Top-level fields over time (all documents, server-side)');
    p();
    p('| field | docs | types | years |');
    p('| --- | ---: | --- | --- |');
    for (const [f, x] of Object.entries(c.server.topLevelFields)) {
      p(`| ${cell(f)} | ${x.total} | ${types(x.types)} | ${Object.entries(x.years).sort().map(([y, k]) => `${y}: ${k}`).join(', ')} |`);
    }

    p();
    p('### All fields (scanned documents)');
    p();
    p('| path | docs | types | first | last | examples |');
    p('| --- | ---: | --- | --- | --- | --- |');
    for (const [path, x] of Object.entries(s.paths)) {
      p(`| ${cell(path)} | ${pct(x.docs, n)} | ${types(x.types)} | ${x.first ?? ''} | ${x.last ?? ''} | ${cell(x.examples.join(' · '))} |`);
    }

    if (s.mapping) {
      p();
      p('### Mapping onto the Postgres schema');
      p();
      const rejected = Object.entries(s.mapping.rejected);
      if (rejected.length) {
        p('Values present but not stored in their column (wrong type; they would go to `extra`):');
        p();
        p('| path | column | types found | examples |');
        p('| --- | --- | --- | --- |');
        for (const [path, r] of rejected) p(`| ${cell(path)} | ${r.column} | ${types(r.types)} | ${cell(r.examples.join(' · '))} |`);
      } else {
        p('Every mapped value has the type of its column.');
      }
      p();
      const extra = Object.entries(s.mapping.extra);
      if (extra.length) {
        p('Fields without a column (would be kept in `extra`), by group:');
        p();
        p('| group | fields (docs) |');
        p('| --- | --- |');
        for (const [name, g] of Object.entries(s.groups)) {
          const e = Object.entries(g.extra);
          if (e.length) p(`| ${cell(name)} | ${cell(e.map(([f, k]) => `${f} (${k})`).join(', '))} |`);
        }
      } else {
        p('No document has fields without a column.');
      }
    }
  }
  return L.join('\n') + '\n';
}

// --- main -------------------------------------------------------------------------

async function main () {
  if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set (see the header of this script)');
  const client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const db = client.db();
    const only = args.collections ? args.collections.split(',') : null;
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.') && !n.startsWith('objectlabs-system'))
      .filter((n) => !only || only.includes(n))
      .sort();

    const report = { database: db.databaseName, generatedAt: new Date().toISOString(), collections: [] };
    for (const name of names) {
      const col = db.collection(name);
      const stats = await db.command({ collStats: name });
      const entry = { name, count: stats.count, sizeMB: Math.round(stats.size / 1e6) };
      report.collections.push(entry);
      if (!stats.count) continue;
      log(`${name}: ${stats.count} documents, ${entry.sizeMB} MB`);
      log('  server-side checks…');
      entry.server = await serverChecks(col, name);
      log('  scanning…');
      const { analysis, sampled } = await scan(col, name, entry.sizeMB);
      entry.sampled = sampled;
      entry.scan = analysis.toJSON();
    }

    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(args.out, 'report.md'), markdown(report));
    log(`Wrote ${path.join(args.out, 'report.md')} and report.json`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
