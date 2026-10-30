// A client of a Nightscout server's API v3 (or another loopk's): exchanges
// an access token for a JWT (again when it expires), reads with it, and
// reads changes since a time through history. Used to follow a server
// (follower.js) and as a data source (src/data/nightscout).

export class NightscoutClient {
  /** @param options { url, token (access token on that server), pageSize, fetch } */
  constructor ({ url, token, pageSize = 1000, fetch = globalThis.fetch }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetch;
    this.pageSize = pageSize;
    this.jwt = null;
    // Nightscout supports both precise cursor-in-path history requests and
    // the older Last-Modified-header variant.  Learn which form this server
    // accepts on the first sync.
    this.historyMode = null;
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

  /** POST a document with the JWT; returns the reply's result. */
  async post (path, body) {
    if (!this.jwt) await this.authorize();
    const request = () => this.fetch(this.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.jwt}` },
      body: JSON.stringify(body),
    });
    let res = await request();
    if (res.status === 401) {
      await this.authorize();
      res = await request();
    }
    const reply = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}${reply?.message ? ` (${reply.message})` : ''}`);
    return reply?.result ?? reply;
  }

  /**
   * Every document of `collection` matching `query` (API v3 search
   * parameters, e.g. { 'date$gte': 0 }), page by page in date order.
   */
  async search (collection, query = {}) {
    const out = [];
    for (let skip = 0; ; skip += this.pageSize) {
      const params = new URLSearchParams({ ...query, sort: 'date', limit: String(this.pageSize), skip: String(skip) });
      const page = await this.get(`/api/v3/${collection}?${params}`);
      out.push(...page);
      if (page.length < this.pageSize) return out;
    }
  }
}
