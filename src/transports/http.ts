import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import { FatSecretClient } from '../fatsecret/client.js';
import { TokenStore } from '../fatsecret/token-store.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

const config = getHttpConfig();

function trustForwardedUser(): boolean {
  return process.env.FATSECRET_TRUST_FORWARDED_USER === 'true';
}

// Shared, long-lived across requests: the encrypted token store and the API
// client. Per-request MCP servers bind to the calling user but reuse these.
const store = new TokenStore();
const client = new FatSecretClient();

const httpServer = createNodeServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);
    const body = await readJsonBody(req, config.maxBodyBytes);

    const forwardedUser = trustForwardedUser() ? firstHeader(req.headers['x-mcp-user']) : undefined;

    const mcpServer = createMcpServer({ client, store, onBehalfOf: forwardedUser });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req);
    }
  }
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`FatSecret MCP HTTP server listening on http://${config.host}:${config.port} (/mcp)`);
});
