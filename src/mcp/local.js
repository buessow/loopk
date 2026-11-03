#!/usr/bin/env node
// loopk's MCP server run by the agent itself, over stdio (the package
// pack.js makes, started by latest.js from `npx -y <loopk>/mcp/local.tgz`): it reads the
// data with a token into an in-memory Postgres, as the browser does, and
// answers every tool and simulation here. The server only sends the data
// the token may read.
//
// LOOPK_URL, LOOPK_TOKEN: a loopk server and an access token on it (read is
//   enough); the AI Test profile is saved there.
// NIGHTSCOUT_URL, NIGHTSCOUT_TOKEN: a Nightscout server instead, read
//   directly, with loopk's settings in its settings collection.
// TZ_NAME: the person's time zone (default: the profile's).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loopkSettings, nightscoutSource } from '../data/nightscout/index.js';
import { upstreamSettings } from '../data/nightscout/settings.js';
import { createMcpServer } from './tools.js';

const env = process.env;
const loopk = Boolean(env.LOOPK_URL);
const url = loopk ? env.LOOPK_URL : env.NIGHTSCOUT_URL;
const token = loopk ? env.LOOPK_TOKEN : env.NIGHTSCOUT_TOKEN;

function fail (message) {
  console.error(`loopk-mcp: ${message}`);
  process.exit(1);
}

if (!url || !token) fail('set LOOPK_URL and LOOPK_TOKEN (or NIGHTSCOUT_URL and NIGHTSCOUT_TOKEN)');

let data;
try {
  data = await nightscoutSource({ url, token, settings: loopk ? loopkSettings : upstreamSettings });
} catch (err) {
  fail(err.message);
}

const ctx = { data, config: { publicUrl: loopk ? url.replace(/\/$/, '') : '', timeZone: env.TZ_NAME || '' } };
const server = createMcpServer(ctx, { by: data.access.sub });
await server.connect(new StdioServerTransport());
console.error(`loopk-mcp: reading ${data.upstream}`);

let closing = false;
async function close () {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  await data.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.stdin.on('end', close);
