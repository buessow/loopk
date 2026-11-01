// loopk in this browser: request() answers loopk's simulator in a worker
// (localworker.js) instead of asking loopk's server, which only saves. The
// worker reads loopk's own API v3 as this page is signed in; while this tab
// holds a Nightscout address and token (useLocal), it reads that server
// directly and answers the rest of loopk's API too, so nothing goes through
// loopk's server. Other requests are fetch().
//
// Pages call request(path, init) where they would call fetch(path, init)
// for /api/… and /auth/logout. The token is kept in this tab only
// (sessionStorage) and goes to the Nightscout server only.

const KEY = 'loopk.local';
// What the worker answers when it reads loopk's own server.
const SIMULATION = ['POST /api/simulate/run', 'POST /api/simulate/period', 'GET /api/simulate/settings'];

/** The { url, token } this tab reads, or null. */
export function localCredentials () {
  try {
    return JSON.parse(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Reads the Nightscout server at url with token in this tab from now on. */
export function useLocal ({ url, token }) {
  sessionStorage.setItem(KEY, JSON.stringify({ url, token }));
}

let worker = null;
let opened = null;
let nextId = 0;
const waiting = new Map();

function ask (message) {
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker.postMessage({ id, ...message });
  });
}

function start ({ url, token }) {
  worker = new Worker('/localworker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    waiting.get(data.id)?.(data);
    waiting.delete(data.id);
  };
  worker.onerror = (e) => {
    for (const resolve of waiting.values()) resolve({ status: 500, body: { message: `loopk could not start in this browser: ${e.message || 'worker error'}` } });
    waiting.clear();
  };
  opened = ask({ type: 'open', url, token });
  return opened;
}

function stop () {
  worker?.terminate();
  worker = null;
  opened = null;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The answer of the worker, or fetch(path, init) for what it does not answer. */
export async function request (path, init = {}) {
  const credentials = localCredentials();
  const method = init.method || 'GET';
  if (path === '/auth/logout') {
    stop();
    if (credentials) {
      sessionStorage.removeItem(KEY);
      return json(200, {});
    }
    return fetch(path, init);
  }
  const route = `${method} ${path.split('?')[0]}`;
  if (!path.startsWith('/api/') || (!credentials && !SIMULATION.includes(route))) {
    const res = await fetch(path, init);
    // Settings saved on the server: the worker reads them again.
    if (res.ok && method !== 'GET' && path.startsWith('/api/simulate/') && opened) await ask({ type: 'changed' });
    return res;
  }
  const open = await (opened || start(credentials || { url: location.origin }));
  if (open.status !== 200) {
    stop();
    // A token the server no longer takes: this tab stops reading it.
    if (open.status === 401 && credentials) sessionStorage.removeItem(KEY);
    return json(open.status, open.body);
  }
  const answer = await ask({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  return json(answer.status, answer.body);
}
