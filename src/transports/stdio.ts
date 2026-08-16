#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';

async function main(): Promise<void> {
  // FATSECRET_DEV_USER lets you exercise the per-user tools locally over
  // stdio (no gateway forwarding a real X-MCP-User header). Never set this
  // in a hosted/gateway-fronted deployment.
  const server = createServer({ onBehalfOf: process.env.FATSECRET_DEV_USER });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
