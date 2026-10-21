import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/index.js';
import { createApp, createContext, checkSchema } from '../src/app.js';
import { attachSockets } from '../src/sockets.js';

const DATA_TABLES = [
  'entries', 'treatments', 'removed_treatments', 'treatment_profiles', 'treatment_profile_schedules',
  'devicestatus', 'devicestatus_predictions', 'profile', 'profile_stores', 'profile_store_schedules',
  'food', 'settings', 'heartrate', 'subjects', 'users', 'follow_state', 'follow_config', 'prediction_models', 'glucose_predictions', 'report_dashboards',
];

/**
 * Starts the app against TEST_DATABASE_URL (set up by ./setup-databases.sh)
 * with empty data tables. Returns { ctx, app, server, url, close }.
 */
export async function startServer (env = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is not set: run ./setup-db-users.sh --local && ./setup-databases.sh --target=local');
  const config = loadConfig({ DATABASE_URL: databaseUrl, ADMIN_EMAILS: 'admin@example.com', ...env });
  const pool = createPool(databaseUrl);
  await checkSchema(pool);
  await pool.query(`TRUNCATE ${DATA_TABLES.join(', ')}`);
  const ctx = await createContext(config, pool);
  const app = createApp(ctx);
  const server = http.createServer(app);
  const io = attachSockets(server, ctx);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  return {
    ctx,
    app,
    server,
    url,
    async close () {
      io.close();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

/** Creates an access token and exchanges it for a JWT, like AAPS does. */
export async function tokenFor (ctx, name, { canWrite = true, canUploadModel = false } = {}) {
  const subject = await ctx.auth.createSubject({ name, canWrite, canUploadModel });
  const { token } = ctx.auth.authorize(subject.access_token);
  return { accessToken: subject.access_token, jwt: token };
}
