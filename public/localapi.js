// loopk's API as the browser answers it itself (localworker.js), over a
// data source on a Nightscout server: the session, the simulator (the
// server's own src/oref/api.js), the reports, the loop's misses, sport mode,
// loopk's settings and the Nightscout API v3, which goes to that server as
// it is. loopk's settings are the person's own here (in this browser's
// localStorage), so whoever reads may change them; what goes to Nightscout
// (sport mode, a profile copied) needs a token that may write there. A
// request is { method, path, body }, its answer { status, body }. Without
// the DOM, so it runs in a worker and in tests.

import { findMisses } from '../src/analysis/misses.js';
import { hasPermission } from '../src/auth/permissions.js';
import { settingsDocument } from '../src/data/nightscout/settings.js';
import { simulateApi } from '../src/oref/api.js';
import { validSetting } from '../src/oref/settings.js';
import { SimulationError } from '../src/oref/simulate.js';
import { TEST_PROFILE, copyTestProfile, deleteTestProfile, saveTestProfile, validProfile } from '../src/oref/testprofile.js';
import { hourlyTotals, validTimeZone } from '../src/reports/index.js';
import { profileUsage } from '../src/reports/profiles.js';
import { SportMode } from '../src/sport/mode.js';

const DAY = 24 * 3600000;
// The search for misses looks at most this far at once (as src/analysis/routes.js).
const MAX_MISSES_WINDOW = 366 * DAY;
const fail = (status, message) => Object.assign(new Error(message), { status });
// How Nightscout answers for a collection it does not have (heart rate).
const NO_COLLECTION = /HTTP 404 \(Bad operation or collection\)/;

/** { from, to, timeZone } of a report's query (as src/reports/routes.js). */
function reportRange (query) {
  const to = query.to ? Number(query.to) : Date.now();
  const from = query.from ? Number(query.from) : to - 30 * DAY;
  const timeZone = query.tz ? String(query.tz) : 'UTC';
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw fail(400, 'from and to must be times in ms, from before to');
  if (!validTimeZone(timeZone)) throw fail(400, `Unknown time zone ${timeZone}`);
  return { from, to, timeZone };
}

/** The settings document `body` checked as the simulator would read it, or a 400. */
function importedSettings (body) {
  const doc = settingsDocument(body);
  for (const r of doc.loopSettings) {
    if (!validSetting(r.setting, r.value)) throw fail(400, `These are not loopk settings: ${r.setting} = ${JSON.stringify(r.value)} is not a loop setting`);
  }
  for (const [name, t] of Object.entries(doc.testProfiles)) {
    try {
      validProfile(t.profile);
    } catch (err) {
      throw fail(400, `These are not loopk settings: the profile ${name}: ${err.message}`);
    }
  }
  return doc;
}

/**
 * The router for `data` read from `url` with a token whose subject and
 * permissions on that server are data.access. `upstream(path)` reads the
 * server's API v3 (GET only).
 */
export function localApi (data, { url, upstream }) {
  const { sub, permissions } = data.access;
  const can = (permission) => hasPermission(permissions, permission);
  const simulate = simulateApi(data);
  const ctx = { data };
  const sport = new SportMode(ctx);
  // Settings that do not load leave sport mode not set up.
  const loaded = sport.load().catch(() => {});
  const host = new URL(url).host;
  const user = { email: `${sub || 'token'}@${host}`, name: sub || host };
  const by = user.email;
  const utcOffset = (body) => (Number.isInteger(body.utcOffset) && Math.abs(body.utcOffset) <= 16 * 60 ? body.utcOffset : 0);
  const switchSport = (fn) => async (body) => {
    if (!can('api:treatments:create')) throw fail(403, `Switching sport mode needs a token that may write treatments on ${host}`);
    await loaded;
    return fn(body, { utcOffset: utcOffset(body), by });
  };

  const routes = {
    'GET /api/session': async () => {
      await loaded;
      return {
        user,
        // loopk's settings here are this browser's
        isAdmin: true,
        follow: null,
        sport: sport.configured,
        permissions,
        // Answered by this browser: the data goes between it and the server only.
        inBrowser: true,
        nightscout: url,
        predictions: false,
      };
    },

    'POST /api/simulate/run': (body) => simulate.run(body),
    'POST /api/simulate/period': (body) => simulate.period(body),
    'GET /api/simulate/settings': (body, query) => simulate.settings(query),
    'PUT /api/simulate/settings': (body) => simulate.saveSettings(body, by),
    'GET /api/simulate/test-profile': () => simulate.testProfile(),
    'PUT /api/simulate/test-profile': ({ profile, basedOn = null, note = null }) => saveTestProfile(data, { profile, basedOn, note }, by),
    'DELETE /api/simulate/test-profile': async () => {
      await deleteTestProfile(data);
      return { name: TEST_PROFILE, profile: null };
    },
    'POST /api/simulate/test-profile/copy': async (body) => {
      if (typeof body.to !== 'string' || !body.to) throw new SimulationError('to must name a profile of the profile store');
      if (!can('api:profile:create')) throw fail(403, `Copying into a profile needs a token that may write profiles on ${host}`);
      const doc = await copyTestProfile(ctx, { to: body.to, by, utcOffset: utcOffset(body) });
      return { copied: body.to, date: doc.date, identifier: doc.identifier };
    },
    // loopk's settings as one file, to move them to another browser or an agent (LOOPK_SETTINGS)
    'GET /api/simulate/stored': () => data.settingsDocument.get(),
    'PUT /api/simulate/stored': async (body) => {
      await data.settingsDocument.put(importedSettings(body));
      await sport.load();
      return data.settingsDocument.get();
    },

    'GET /api/analysis/misses': async (body, query) => {
      const to = query.to ? Number(query.to) : Date.now();
      const from = query.from ? Number(query.from) : to - 30 * DAY;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw fail(400, 'from and to must be times in ms, from before to');
      if (to - from > MAX_MISSES_WINDOW) throw fail(400, `Search at most ${MAX_MISSES_WINDOW / DAY} days at once`);
      return { from, to, misses: await findMisses(data, { from, to }) };
    },
    'GET /api/reports/hours': (body, query) => hourlyTotals(data, reportRange(query)),
    'GET /api/reports/profiles': (body, query) => profileUsage(data, reportRange(query)),

    'GET /api/sport': async () => {
      await loaded;
      const canSwitch = can('api:treatments:create');
      return { ...await sport.state(), canSwitch, following: null, ...(canSwitch ? {} : { why: `Switching sport mode needs a token that may write treatments on ${host}.` }) };
    },
    'POST /api/sport/start': switchSport(({ duration }, o) => sport.start({ ...o, duration })),
    'POST /api/sport/stop': switchSport((body, o) => sport.stop(o)),
    'GET /api/admin/sport': async () => {
      await loaded;
      return sport.view();
    },
    'PUT /api/admin/sport': async ({ percentage, duration = 0, target = null, profile = null }) => {
      await loaded;
      try {
        await sport.configure({ percentage, duration, target, profile }, by);
      } catch (err) {
        throw fail(400, err.message);
      }
      return sport.view();
    },
    'DELETE /api/admin/sport': async () => {
      await sport.remove();
      return sport.view();
    },
  };

  return async function handle ({ method = 'GET', path, body }) {
    const target = new URL(path, url);
    try {
      if (method === 'GET' && target.pathname.startsWith('/api/v3/')) {
        let result;
        try {
          result = await upstream(target.pathname + target.search);
        } catch (err) {
          // a collection the server does not have has no documents
          if (!NO_COLLECTION.test(err.message) || target.pathname === '/api/v3/lastModified') throw err;
          result = [];
        }
        return { status: 200, body: { status: 200, result } };
      }
      const route = routes[`${method} ${target.pathname}`];
      if (!route) return { status: 404, body: { status: 404, message: `${method} ${target.pathname} is not answered in this browser` } };
      return { status: 200, body: await route(body ?? {}, Object.fromEntries(target.searchParams)) };
    } catch (err) {
      const status = err.status || Number(/HTTP (\d{3})/.exec(err.message)?.[1]) || 500;
      return { status, body: { status, message: err.message } };
    }
  };
}
