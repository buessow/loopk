import http from 'node:http';
import { loadConfig } from './config.js';
import { createDataSource } from './data/index.js';
import { createApp, createContext } from './app.js';
import { attachSockets } from './sockets.js';

const config = loadConfig();
const data = await createDataSource(config);

try {
  if (config.authDisabled && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl)) {
    throw new Error('AUTH_DISABLED is only allowed when BASE_URL is http://localhost.');
  }
  await data.checkSchema();
  const ctx = await createContext(config, data);
  const app = createApp(ctx, { requestLog: true });
  const server = http.createServer(app);
  attachSockets(server, ctx);
  if (config.follow && !config.follow.token) console.warn('FOLLOW_URL needs FOLLOW_TOKEN, an access token on that server: not following it.');
  // A source over another server (DATA_SOURCE nightscout) neither follows nor records predictions.
  if (!data.upstream) {
    ctx.following.start();
    ctx.predictions.start();
  }
  server.listen(config.port, () => {
    console.log(`Loopk listening on ${config.baseUrl} (port ${config.port})`);
    if (config.authDisabled) console.warn('AUTH_DISABLED: the web UI is open to anyone who can reach this port, as admin.');
    else if (!config.google.clientId) console.warn('GOOGLE_CLIENT_ID not set: web sign-in is disabled.');
  });

  const shutdown = async () => {
    await ctx.following.stop();
    await ctx.predictions.stop();
    server.close(() => data.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  console.error(err.message || err);
  await data.close();
  process.exit(1);
}
