// loopk's API as the browser answers it itself (localworker.js), over a
// data source on a Nightscout server: the session, the simulator (the
// server's own src/oref/api.js) and the Nightscout API v3, which goes to
// that server as it is. A request is { method, path, body }, its answer
// { status, body }. Without the DOM, so it runs in a worker and in tests.

import { simulateApi } from '../src/oref/api.js';
import { SimulationError } from '../src/oref/simulate.js';

const ADMIN = 'Only an admin token on the Nightscout server may do this.';

/**
 * The router for `data` read from `url` with a token whose subject and
 * permissions on that server are data.access. `upstream(path)` reads the
 * server's API v3 (GET only).
 */
export function localApi (data, { url, upstream }) {
  const { sub, permissions } = data.access;
  const isAdmin = permissions.includes('*');
  const simulate = simulateApi(data);
  const host = new URL(url).host;
  const user = { email: `${sub || 'token'}@${host}`, name: sub || host };

  const routes = {
    'GET /api/session': () => ({
      user,
      isAdmin,
      follow: null,
      sport: false,
      permissions,
      keepsNothing: true,
      // Answered by this browser: the data goes between it and the server only.
      inBrowser: true,
      nightscout: url,
    }),
    'POST /api/simulate/run': (body) => simulate.run(body),
    'POST /api/simulate/period': (body) => simulate.period(body),
    'GET /api/simulate/settings': (body, query) => simulate.settings(query),
    'GET /api/simulate/test-profile': () => simulate.testProfile(),
    'PUT /api/simulate/settings': (body) => {
      if (!isAdmin) throw new SimulationError(ADMIN, 403);
      return simulate.saveSettings(body, user.email);
    },
  };

  return async function handle ({ method = 'GET', path, body }) {
    const target = new URL(path, url);
    try {
      if (method === 'GET' && target.pathname.startsWith('/api/v3/')) {
        return { status: 200, body: { status: 200, result: await upstream(target.pathname + target.search) } };
      }
      const route = routes[`${method} ${target.pathname}`];
      if (!route) return { status: 404, body: { status: 404, message: `${method} ${target.pathname} is not answered in this browser` } };
      return { status: 200, body: await route(body ?? {}, Object.fromEntries(target.searchParams)) };
    } catch (err) {
      if (err instanceof SimulationError) return { status: err.status, body: { status: err.status, message: err.message } };
      const status = Number(/HTTP (\d{3})/.exec(err.message)?.[1]) || 500;
      return { status, body: { status, message: err.message } };
    }
  };
}
