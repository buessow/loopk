// Copies a Nightscout MongoDB into Loopk's Postgres database, cleaning the
// documents up on the way (src/sync/normalize.js) and dropping records that
// were stored more than once. Reads MongoDB only.
//
//   node --env-file=.env scripts/mongo-migrate.js [--collections a,b] [--replace] [--dry-run]
//
// MONGO_URL is the source (see scripts/mongo-analyze.js), DATABASE_URL the
// target (or --target-url). The target collections must be empty unless
// --replace is given, which deletes their documents first. Documents are
// written with their identifiers (API v1 documents: their MongoDB _id, as
// Nightscout's API v3 serves them), so following the Nightscout server
// afterwards (FOLLOW_URL) updates the same rows; the migration records where
// following has to start.
//
// Duplicates: Nightscout identifies a record by created_at + eventType
// (treatments), date + type (entries) and created_at + device (device
// status); profiles are all kept. Where several documents share that, documents
// written through API v3 are kept and API v1 copies dropped; among API v1
// documents only, the latest upload is kept.

import { parseArgs } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';
import { createPool } from '../src/db/index.js';
import { CollectionStore } from '../src/db/collection.js';
import { prepare } from '../src/sync/normalize.js';

const { values: args } = parseArgs({
  options: {
    collections: { type: 'string' },
    replace: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'target-url': { type: 'string' },
    batch: { type: 'string', default: '500' },
  },
});

const TARGETS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate'];
const CHILD_TABLES = {
  treatments: ['treatment_profiles'],
  profile: ['profile_stores'],
  devicestatus: ['devicestatus_predictions'],
};

// What is read, in which order, and the natural key duplicates are found by.
// `key` takes the cleaned document; null means no duplicate check.
const SOURCES = [
  { from: 'entries', sort: { date: 1 }, key: (d) => `${d.date}|${d.type}` },
  { from: 'treatments', sort: { created_at: 1 }, query: { eventType: { $ne: 'HeartRate' } }, key: (d) => `${d.created_at}|${d.eventType}` },
  { from: 'devicestatus', sort: { created_at: 1 }, key: (d) => `${d.created_at}|${d.device}` },
  // Profiles saved with the same created_at are kept: they are earlier versions.
  { from: 'profile', sort: { created_at: 1 }, key: null },
  { from: 'food', sort: { _id: 1 }, key: null },
  { from: 'heartrate', sort: { _id: 1 }, key: null },
  { from: 'activity', sort: { _id: 1 }, key: null },
  { from: 'treatments', label: 'treatments (HeartRate)', sort: { _id: 1 }, query: { eventType: 'HeartRate' }, key: null },
];
// Documents of a sorted source are grouped by key within this time window.
const WINDOW = 10 * 60 * 1000;

const log = (...a) => console.error(...a);

/** A MongoDB document as plain JSON, as API v3 serves it (API v1 documents get their _id as identifier). */
function fromBson (doc) {
  const conv = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(conv);
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v instanceof ObjectId) return v.toHexString();
    if (v._bsontype) return ['Decimal128', 'Long', 'Double', 'Int32'].includes(v._bsontype) ? Number(v.toString()) : String(v);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
  };
  const out = conv(doc);
  delete out._id;
  const v3 = typeof out.identifier === 'string' && out.identifier !== '';
  if (!v3) out.identifier = doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id);
  return { doc: out, v3, order: doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id) };
}

class Stats {
  constructor () { this.rows = new Map(); }
  add (source, what, n = 1) {
    const r = this.rows.get(source) || {};
    r[what] = (r[what] || 0) + n;
    this.rows.set(source, r);
  }
  print () {
    for (const [source, r] of this.rows) log(`  ${source.padEnd(24)} ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}

/** Collects documents per target collection and writes them in batches. */
class Writer {
  constructor (pool, dryRun, batch) {
    this.dryRun = dryRun;
    this.batch = batch;
    this.stores = Object.fromEntries(TARGETS.map((t) => [t, new CollectionStore(pool, t)]));
    this.pending = Object.fromEntries(TARGETS.map((t) => [t, []]));
  }
  async add (collection, doc) {
    const p = this.pending[collection];
    p.push(doc);
    if (p.length >= this.batch) await this.flush(collection);
  }
  async flush (collection) {
    const docs = this.pending[collection].splice(0);
    if (docs.length && !this.dryRun) await this.stores[collection].bulkUpsert(docs);
  }
  async flushAll () {
    for (const t of TARGETS) await this.flush(t);
  }
}

/** Keeps API v3 documents; of API v1-only groups, the latest upload. */
function dedupe (group) {
  if (group.length === 1) return { keep: group, dropped: 0, kind: null };
  const v3 = group.filter((g) => g.v3);
  if (v3.length) return { keep: v3, dropped: group.length - v3.length, kind: 'v1 copies of v3 documents' };
  const latest = group.reduce((a, b) => (b.order > a.order ? b : a));
  return { keep: [latest], dropped: group.length - 1, kind: 'older v1 uploads' };
}

async function migrateSource (db, src, only, writer, stats) {
  const label = src.label || src.from;
  if (!(await db.listCollections({ name: src.from }).hasNext())) return;
  const cursor = db.collection(src.from).find(src.query || {}).sort(src.sort).batchSize(2000);
  const groups = new Map(); // key -> { t, items }
  const emit = async (item) => {
    if (only && !only.includes(item.collection)) return;
    await writer.add(item.collection, item.doc);
    stats.add(label, `→ ${item.collection}`);
  };
  const flushGroups = async (before) => {
    for (const [k, g] of groups) {
      if (g.t >= before) continue;
      groups.delete(k);
      const { keep, dropped, kind } = dedupe(g.items);
      if (dropped) stats.add(label, `dropped as ${kind}`, dropped);
      for (const item of keep) await emit(item);
    }
  };

  let read = 0;
  let lastLog = Date.now();
  for await (const raw of cursor) {
    read++;
    const { doc, v3, order } = fromBson(raw);
    const prepared = prepare(src.from, doc);
    if (!prepared) {
      stats.add(label, 'skipped (no plausible time, or test data)');
      continue;
    }
    const item = { ...prepared, v3, order };
    if (!src.key || prepared.collection !== src.from) {
      await emit(item);
    } else {
      const k = src.key(prepared.doc);
      const g = groups.get(k);
      if (g) g.items.push(item);
      else groups.set(k, { t: prepared.doc.date, items: [item] });
      if (groups.size > 1000) await flushGroups(prepared.doc.date - WINDOW);
    }
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      log(`  ${label}: ${read} read`);
    }
  }
  await flushGroups(Infinity);
  stats.add(label, 'read', read);
}

async function main () {
  if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set');
  const targetUrl = args['target-url'] || process.env.DATABASE_URL;
  if (!targetUrl) throw new Error('DATABASE_URL is not set');
  const only = args.collections ? args.collections.split(',') : null;
  const targets = only || TARGETS;
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`Unknown collection ${t}`);
  const dryRun = args['dry-run'];

  const mongo = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 20000 });
  const pool = createPool(targetUrl);
  try {
    await mongo.connect();
    const db = mongo.db();

    for (const t of targets) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (!rows[0].n) continue;
      if (!args.replace) throw new Error(`${t} already has ${rows[0].n} documents; use --replace to delete them first`);
      if (!dryRun) {
        log(`Deleting ${rows[0].n} ${t} documents`);
        for (const child of CHILD_TABLES[t] || []) await pool.query(`DELETE FROM ${child}`);
        await pool.query(`DELETE FROM ${t}`);
      }
    }

    // Where following starts: the newest change in each collection before
    // reading it (changes made while copying are copied again, harmlessly).
    const cursors = {};
    for (const t of targets) {
      const newest = await db.collection(t).find({ srvModified: { $type: 'number' } }).sort({ srvModified: -1 }).limit(1).next().catch(() => null);
      cursors[t] = newest ? newest.srvModified : 0;
    }

    const stats = new Stats();
    const writer = new Writer(pool, dryRun, parseInt(args.batch, 10));
    const started = Date.now();
    for (const src of SOURCES) {
      const feeds = src.from === 'activity' || src.label ? ['heartrate'] : src.from === 'food' ? ['food', 'heartrate'] : [src.from];
      if (!feeds.some((f) => targets.includes(f))) continue;
      log(`${src.label || src.from}…`);
      await migrateSource(db, src, targets, writer, stats);
      await writer.flushAll();
    }

    if (!dryRun) {
      for (const t of targets) {
        await pool.query(
          `INSERT INTO follow_state (collection, last_modified) VALUES ($1, $2)
           ON CONFLICT (collection) DO UPDATE SET last_modified = EXCLUDED.last_modified, updated_at = now()`, [t, cursors[t]]);
      }
    }

    log(`\n${dryRun ? 'Dry run' : 'Migrated'} in ${Math.round((Date.now() - started) / 1000)} s:`);
    stats.print();
    if (!dryRun) {
      log('\nDocuments in Postgres:');
      for (const t of targets) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        log(`  ${t.padEnd(24)} ${rows[0].n}`);
      }
      log(`\nFollowing starts after: ${Object.entries(cursors).map(([t, c]) => `${t} ${c ? new Date(c).toISOString() : '–'}`).join(', ')}`);
    }
  } finally {
    await mongo.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
