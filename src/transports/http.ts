import { ConfigError } from '../config-env.js';
import { FatSecretClient } from '../fatsecret/client.js';
import { TokenStore } from '../fatsecret/token-store.js';
import { createServer as createMcpServer } from '../server.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

function fail(message: string): never {
  console.error(`FatSecret MCP HTTP server not started: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(error.message);
    }
    throw error;
  }

  // Shared, long-lived across requests: the encrypted token store and the API
  // client. Per-request MCP servers bind to the calling user but reuse these.
  let shared: { client: FatSecretClient; store: TokenStore };
  try {
    shared = { client: new FatSecretClient(), store: new TokenStore() };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config, {
    createMcpServer: onBehalfOf => createMcpServer({ ...shared, onBehalfOf }),
  });
  console.error(`FatSecret MCP HTTP server listening on http://${config.host}:${running.port} (/mcp)`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
