// Follows another Nightscout server: copies every document created, changed
// or soft-deleted there, using API v3 history (the srvModified cursor AAPS
// syncs with), and is nudged by that server's /storage socket so copies
// arrive within seconds. While following, Loopk's own API accepts no data
// changes, so the two cannot diverge.

import { io } from 'socket.io-client';
import { CollectionStore } from '../db/collection.js';
import { prepare } from './normalize.js';

export const FOLLOWED = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate'];

export class Follower {
  /**
   * @param ctx app context (pool, bus)
   * @param options { url, token (access token on the followed server), interval (ms between polls), pageSize }
   */
  constructor (ctx, { url, token, interval = 60000, pageSize = 1000, fetch = globalThis.fetch }) {
    this.ctx = ctx;
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.interval = interval;
    this.fetch = fetch;
    this.pageSize = pageSize;
    this.jwt = null;
    this.stores = Object.fromEntries(FOLLOWED.map((c) => [c, new CollectionStore(ctx.pool, c)]));
    this.running = new Map(); // collection -> promise of the poll in progress
    this.again = new Set(); // collections to poll again when the current poll ends
    this.status = { url: this.url, lastSync: null, lastError: null, copied: 0 };
  }

  async start () {
    await this.syncAll().catch((err) => this.fail(err));
    this.timer = setInterval(() => this.syncAll().catch((err) => this.fail(err)), this.interval);
    this.connectSocket();
  }

  async stop () {
    clearInterval(this.timer);
    this.socket?.close();
    await Promise.allSettled([...this.running.values()]);
  }

  fail (err) {
    this.status.lastError = { at: new Date().toISOString(), message: err.message };
    console.error(`Following ${this.url}: ${err.message}`);
  }

  // --- the followed server --------------------------------------------------

  async authorize () {
    const res = await this.fetch(`${this.url}/api/v2/authorization/request/${encodeURIComponent(this.token)}`);
    if (!res.ok) throw new Error(`token exchange: HTTP ${res.status}`);
    this.jwt = (await res.json()).token;
  }

  /** GET with a JWT, exchanging the access token again when it has expired. */
  async get (path) {
    if (!this.jwt) await this.authorize();
    let res = await this.fetch(this.url + path, { headers: { Authorization: `Bearer ${this.jwt}` } });
    if (res.status === 401) {
      await this.authorize();
      res = await this.fetch(this.url + path, { headers: { Authorization: `Bearer ${this.jwt}` } });
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const body = await res.json();
    return body.result ?? body;
  }

  connectSocket () {
    this.socket = io(`${this.url}/storage`, { transports: ['websocket'] });
    this.socket.on('connect', () => this.socket.emit('subscribe', { accessToken: this.token, collections: FOLLOWED }, () => {}));
    for (const event of ['create', 'update', 'delete']) {
      this.socket.on(event, (payload) => {
        if (FOLLOWED.includes(payload?.colName)) this.sync(payload.colName).catch((err) => this.fail(err));
      });
    }
  }

  // --- copying --------------------------------------------------------------

  async cursor (collection) {
    const { rows } = await this.ctx.pool.query('SELECT last_modified FROM follow_state WHERE collection = $1', [collection]);
    return rows[0] ? Number(rows[0].last_modified) : 0;
  }

  async saveCursor (collection, lastModified) {
    await this.ctx.pool.query(
      `INSERT INTO follow_state (collection, last_modified) VALUES ($1, $2)
       ON CONFLICT (collection) DO UPDATE SET last_modified = EXCLUDED.last_modified, updated_at = now()`,
      [collection, lastModified]);
  }

  async syncAll () {
    await Promise.all(FOLLOWED.map((c) => this.sync(c)));
    this.status.lastSync = new Date().toISOString();
    this.status.lastError = null;
  }

  /** Copies what changed in a collection; one poll per collection at a time. */
  sync (collection) {
    if (this.running.has(collection)) {
      this.again.add(collection);
      return this.running.get(collection);
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(collection);
          await this.copyChanges(collection);
        } while (this.again.has(collection));
      } finally {
        this.running.delete(collection);
      }
    })();
    this.running.set(collection, run);
    return run;
  }

  async copyChanges (collection) {
    let cursor = await this.cursor(collection);
    for (;;) {
      const docs = await this.get(`/api/v3/${collection}/history/${cursor}?limit=${this.pageSize}`);
      if (!docs.length) return;
      const byTarget = new Map();
      for (const doc of docs) {
        const p = prepare(collection, doc);
        if (!p) continue;
        if (!byTarget.has(p.collection)) byTarget.set(p.collection, []);
        byTarget.get(p.collection).push(p.doc);
      }
      for (const [target, list] of byTarget) {
        await this.stores[target].bulkUpsert(list);
        for (const doc of list) this.ctx.bus.emit('storage-socket-update', { colName: target, doc });
        this.ctx.bus.emit('data-received', { colName: target });
        this.status.copied += list.length;
      }
      const newest = Math.max(...docs.map((d) => (typeof d.srvModified === 'number' ? d.srvModified : 0)));
      // History returns changes after the cursor. A full page may end amid
      // documents sharing its newest srvModified: continue just before it
      // (copying a few again) unless the whole page shares it.
      const full = docs.length >= this.pageSize;
      const next = !full || newest - 1 <= cursor ? newest : newest - 1;
      if (next > cursor) {
        cursor = next;
        await this.saveCursor(collection, cursor);
      }
      if (!full) return;
    }
  }
}
