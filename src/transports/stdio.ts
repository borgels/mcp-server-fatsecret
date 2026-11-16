#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';
import { defaultStdioStorePath } from '../fatsecret/store-path.js';

async function main(): Promise<void> {
  // The container's /data volume does not exist on a workstation.
  if (!process.env.FATSECRET_STORE_PATH) {
    process.env.FATSECRET_STORE_PATH = defaultStdioStorePath();
  }
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
