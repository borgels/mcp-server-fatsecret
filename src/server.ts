import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FatSecretClient, type FatSecretClientOptions } from './fatsecret/client.js';
import { TokenStore } from './fatsecret/token-store.js';
import { registerFatSecretTools } from './tools/fatsecret.js';

export interface CreateServerOptions {
  client?: FatSecretClient;
  clientOptions?: FatSecretClientOptions;
  store?: TokenStore;
  /** Gateway-verified end-user identity; every tool is bound to this user's own data. */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'fatsecret', version: '0.1.0' });
  const client = options.client ?? new FatSecretClient(options.clientOptions);
  const store = options.store ?? new TokenStore();
  registerFatSecretTools(server, client, store, { onBehalfOf: options.onBehalfOf });
  return server;
}
