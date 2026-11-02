// An MCP server (Model Context Protocol) at /mcp, for agents that look into
// the person's diabetes data, with the tools of tools.js. Stateless
// Streamable HTTP: each request gets its own server. It takes the same access
// as the API (an access token as ?token=, a Bearer JWT or a session) and
// needs read access to entries, treatments and device status.

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './tools.js';

export { createMcpServer, linkGuide } from './tools.js';

const READ = 'The MCP server needs read access to entries, treatments and device status: create a token with read access on the admin page and add it to the URL as ?token=.';
// Over a server that keeps nothing, tokens are made on the Nightscout server it reads.
const readUpstream = (url) => `The MCP server needs read access to entries, treatments and device status: use an access token on ${url} that may read them, added to the URL as ?token=.`;

/** POST /mcp: the MCP endpoint (Streamable HTTP, stateless, JSON responses). */
export function createMcpRoutes (ctx) {
  const router = express.Router();
  const needs = ctx.data.upstream ? readUpstream(ctx.data.upstream) : READ;
  const read = ['api:entries:read', 'api:treatments:read', 'api:devicestatus:read'].map((p) => ctx.auth.require(p, needs));
  router.post('/', read, express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const a = await ctx.auth.fromRequest(req);
      const server = createMcpServer(ctx, { by: a.user?.email ?? a.subject?.name ?? null });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });
  // No server-initiated streams or sessions in stateless mode.
  router.all('/', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  return router;
}
