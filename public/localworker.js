// The worker that is loopk in this browser (local.js starts it): an
// in-memory Postgres (PGlite) with loopk's schema, the server's Nightscout
// data source over it, and loopk's API answered over that source
// (localapi.js). With a token it reads that Nightscout server directly,
// and nothing it reads goes to loopk's server, which only sends the code;
// without one it reads loopk's own API v3 as the page is signed in, with
// loopk's stored settings (loopkSettings).
//
// Messages: { id, type: 'open', url, token? }, then { id, method, path, body },
// and { id, type: 'changed' } when the server saved loopk's settings; each
// is answered with { id, status, body }.

import { PGlite } from './vendor/pglite/index.js';
import { migrate, pglitePool } from '../src/data/postgres/pglite.js';
import { loopkSettings, nightscoutSource } from '../src/data/nightscout/index.js';
import { localApi } from './localapi.js';

let opening = null;
let source = null;

async function open ({ url, token }) {
  const t0 = performance.now();
  const migrations = await (await fetch('/migrations.json')).json();
  const pool = async () => {
    const db = await PGlite.create();
    await migrate(db, migrations);
    return pglitePool(db);
  };
  const data = source = await nightscoutSource({ url, token, pool, ...(token ? {} : { settings: loopkSettings }) });
  const client = data.loader.client;
  console.info(`loopk in this browser: ${client.url} opened in ${Math.round(performance.now() - t0)} ms`);
  return localApi(data, { url: client.url, upstream: (path) => client.get(path) });
}

self.onmessage = async ({ data: message }) => {
  const { id, type, ...request } = message;
  const reply = (answer) => self.postMessage({ id, ...answer });
  try {
    if (type === 'open') {
      opening = open(request);
      await opening;
      return reply({ status: 200, body: {} });
    }
    const handle = await opening;
    if (type === 'changed') {
      source.settingsChanged?.();
      return reply({ status: 200, body: {} });
    }
    const t0 = performance.now();
    const answer = await handle(request);
    console.info(`loopk in this browser: ${request.method} ${request.path.split('?')[0]} ${answer.status} in ${Math.round(performance.now() - t0)} ms`);
    reply(answer);
  } catch (err) {
    const status = /did not accept the access token|HTTP 401/.test(err.message) ? 401 : 500;
    reply({ status, body: { status, message: err.message } });
  }
};
