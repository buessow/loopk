// Which Nightscout server this one follows, set by an admin on the Access
// page (or FOLLOW_URL / FOLLOW_TOKEN while nothing is set there), and the
// Follower copying from it. `ctx.follower` is the running follower, if any:
// while it is set, the API accepts no data changes.

import { Follower, FOLLOWED } from './follower.js';

export class Following {
  /** @param env { url, token } from FOLLOW_URL / FOLLOW_TOKEN, or null */
  constructor (ctx, env, { interval, fetch } = {}) {
    this.ctx = ctx;
    this.env = env?.url && env.token ? env : null;
    this.options = { interval, fetch };
    this.setting = null; // { url, token, enabled, source: 'settings' | 'environment', updatedAt, updatedBy }
    this.started = false;
  }

  /** Reads the setting and prepares the follower; the server starts it. */
  async load () {
    await this.read();
    this.ctx.follower = this.setting?.enabled ? this.follower(this.setting) : null;
  }

  async read () {
    const r = await this.ctx.data.follow.get();
    this.setting = r
      ? { url: r.url, token: r.token, enabled: r.enabled, source: 'settings', updatedAt: r.updated_at, updatedBy: r.updated_by }
      : this.env && { url: normalizeUrl(this.env.url), token: this.env.token, enabled: true, source: 'environment' };
  }

  follower ({ url, token }) {
    return new Follower(this.ctx, { url, token, ...clean(this.options) });
  }

  start () {
    this.started = true;
    if (this.ctx.follower) {
      this.ctx.follower.start();
      console.log(`Following ${this.ctx.follower.url}: this server accepts no data changes.`);
    }
  }

  async stop () {
    this.started = false;
    await this.ctx.follower?.stop();
  }

  /**
   * Saves a server to follow (token: keep the saved one when omitted) and
   * follows it from now on, or, with enabled false, stops following.
   * Checks the server first; throws a readable error if it does not work.
   */
  async configure ({ url, token, enabled = true }, by) {
    url = normalizeUrl(url);
    const same = this.setting && url === this.setting.url;
    token = token || (same ? this.setting.token : '');
    if (!token) throw new Error('An access token on that server is needed');
    const next = this.follower({ url, token });
    if (enabled) await next.check();
    await this.ctx.data.follow.save({ url, token, enabled, by });
    await this.read();
    await this.replace(enabled ? next : null);
  }

  /** Forgets the saved server and stops following (FOLLOW_URL applies again, if set). */
  async remove () {
    await this.ctx.data.follow.remove();
    await this.read();
    await this.replace(this.setting?.enabled ? this.follower(this.setting) : null);
  }

  async replace (next) {
    await this.ctx.follower?.stop();
    this.ctx.follower = next;
    if (next && this.started) next.start();
  }

  /** The setting and progress, for admins: never the token. */
  async view () {
    const rows = await this.ctx.data.follow.cursors();
    const s = this.setting;
    const f = this.ctx.follower;
    return {
      url: s?.url ?? null,
      tokenSet: !!s?.token,
      enabled: !!s?.enabled,
      following: !!f,
      source: s?.source ?? null,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
      status: f ? { lastSync: f.status.lastSync, lastError: f.status.lastError, copied: f.status.copied, syncing: f.running.size > 0 } : null,
      // Up to when each collection has been copied (the newest change on the followed server).
      collections: FOLLOWED.map((c) => {
        const r = rows.find((x) => x.collection === c && (x.source_url == null || x.source_url === s?.url));
        return { collection: c, copiedUntil: r ? Number(r.last_modified) : null };
      }),
    };
  }
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** https://host/path without a trailing slash; throws for anything but an http(s) URL. */
export function normalizeUrl (url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new Error('Enter the full address of the Nightscout server, e.g. https://example.herokuapp.com');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The address must start with https:// (or http://)');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}
