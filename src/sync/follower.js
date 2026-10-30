// Follows another Nightscout server: copies every document created, changed
// or soft-deleted there, using API v3 history (the srvModified cursor AAPS
// syncs with), and is nudged by that server's /storage socket so copies
// arrive within seconds. While following, Loopk's own API accepts no data
// changes, so the two cannot diverge.

import { io } from 'socket.io-client';
import { prepare } from './normalize.js';

export const FOLLOWED = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate'];

export class Follower {
  /**
   * @param ctx app context (data, bus)
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
    // Nightscout supports both precise cursor-in-path history requests and
    // the older Last-Modified-header variant.  Learn which form this server
    // accepts on the first sync.
    this.historyMode = null;
    this.stores = Object.fromEntries(FOLLOWED.map((c) => [c, ctx.data.collection(c)]));
    this.running = new Map(); // collection -> promise of the poll in progress
    this.again = new Set(); // collections to poll again when the current poll ends
    this.status = { url: this.url, lastSync: null, lastError: null, copied: 0 };
  }

  /** Starts copying; the first copy of a large server can take a while and runs in the background. */
  start () {
    this.stopped = false;
    this.syncAll().catch((err) => this.fail(err));
    this.timer = setInterval(() => this.syncAll().catch((err) => this.fail(err)), this.interval);
    this.connectSocket();
  }

  async stop () {
    this.stopped = true;
    clearInterval(this.timer);
    this.socket?.close();
    await Promise.allSettled([...this.running.values()]);
  }

  /** Checks the URL and token: exchanges the token and reads one entry. Throws a readable error. */
  async check () {
    let res;
    try {
      res = await this.fetch(`${this.url}/api/v2/authorization/request/${encodeURIComponent(this.token)}`);
    } catch (err) {
      throw new Error(`Could not reach ${this.url} (${err.cause?.code || err.message})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('The server did not accept the access token');
    if (!res.ok) throw new Error(`${this.url} does not look like a Nightscout server (HTTP ${res.status} for the token exchange)`);
    const body = await res.json().catch(() => null);
    if (!body?.token) throw new Error(`${this.url} does not look like a Nightscout server (no token in the reply)`);
    this.jwt = body.token;
    try {
      await this.get('/api/v3/entries?limit=1&fields=identifier');
    } catch (err) {
      throw new Error(`The access token cannot read entries: ${err.message}`);
    }
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
  async get (path, { headers = {} } = {}) {
    if (!this.jwt) await this.authorize();
    const request = () => this.fetch(this.url + path, { headers: { ...headers, Authorization: `Bearer ${this.jwt}` } });
    let res = await request();
    if (res.status === 401) {
      await this.authorize();
      res = await request();
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(`${path}: HTTP ${res.status}${detail?.message ? ` (${detail.message})` : ''}`);
    }
    const body = await res.json();
    return body.result ?? body;
  }

  /**
   * Gets incremental changes.  Older Nightscout releases expose only the
   * Last-Modified-header form (and return 400 for /history/:timestamp),
   * whereas modern Nightscout and Loopk accept the precise path cursor.
   */
  async history (collection, cursor) {
    const query = `?limit=${this.pageSize}`;
    if (this.historyMode !== 'header') {
      try {
        const result = await this.get(`/api/v3/${collection}/history/${cursor}${query}`);
        this.historyMode = 'path';
        return result;
      } catch (err) {
        if (!/HTTP 400\b/.test(err.message)) throw err;
        this.historyMode = 'header';
      }
    }
    return this.get(`/api/v3/${collection}/history${query}`, {
      headers: { 'Last-Modified': new Date(cursor).toUTCString() },
    });
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

  /** Where copying got to; a cursor of another server does not count (no URL: the migrated one). */
  async cursor (collection) {
    const r = await this.ctx.data.follow.cursor(collection);
    return r && (r.source_url == null || r.source_url === this.url) ? Number(r.last_modified) : 0;
  }

  async saveCursor (collection, lastModified) {
    await this.ctx.data.follow.saveCursor(collection, lastModified, this.url);
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
          if (this.stopped) return;
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
    while (!this.stopped) {
      const docs = await this.history(collection, cursor);
      if (!docs.length) return;
      const byTarget = new Map();
      for (const doc of docs) {
        const p = prepare(collection, doc);
        if (!p) continue;
        if (!byTarget.has(p.collection)) byTarget.set(p.collection, []);
        byTarget.get(p.collection).push(p.doc);
      }
      for (const [target, list] of byTarget) {
        const removed = new Set(await this.stores[target].bulkUpsert(list));
        for (const doc of list) {
          if (!removed.has(doc.identifier)) this.ctx.bus.emit('storage-socket-update', { colName: target, doc });
        }
        for (const identifier of removed) {
          if (!list.some((d) => d.identifier === identifier)) this.ctx.bus.emit('storage-socket-delete', { colName: target, identifier });
        }
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
