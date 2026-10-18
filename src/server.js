import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool } from './db/index.js';
import { createApp, createContext, checkSchema } from './app.js';
import { attachSockets } from './sockets.js';
import { forwardConsoleLogs } from './monitoring/console-logs.js';

forwardConsoleLogs();

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  if (config.authDisabled && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl)) {
    throw new Error('AUTH_DISABLED is only allowed when BASE_URL is http://localhost.');
  }
  await checkSchema(pool);
  const ctx = await createContext(config, pool);
  const app = createApp(ctx);
  const server = http.createServer(app);
  attachSockets(server, ctx);
  if (config.follow && !config.follow.token) console.warn('FOLLOW_URL needs FOLLOW_TOKEN, an access token on that server: not following it.');
  ctx.following.start();
  server.listen(config.port, () => {
    console.log(`Loopk listening on ${config.baseUrl} (port ${config.port})`);
    if (config.authDisabled) console.warn('AUTH_DISABLED: the web UI is open to anyone who can reach this port, as admin.');
    else if (!config.google.clientId) console.warn('GOOGLE_CLIENT_ID not set: web sign-in is disabled.');
  });

  const shutdown = async () => {
    await ctx.following.stop();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  console.error(err.message || err);
  await pool.end();
  process.exit(1);
}
