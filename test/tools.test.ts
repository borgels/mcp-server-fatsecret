import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FatSecretClient } from '../src/fatsecret/client.js';
import { TokenStore } from '../src/fatsecret/token-store.js';
import { createServer } from '../src/server.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fatsecret-tools-'));
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  return new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content)[0]?.text ?? '';
}

async function connect(onBehalfOf: string | undefined, fetchImpl: typeof fetch) {
  const s = store();
  const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl });
  const server = createServer({ client, store: s, onBehalfOf });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return { mcp, store: s };
}

describe('per-user isolation via MCP', () => {
  it('data tools fail closed without a verified identity', async () => {
    const { mcp } = await connect(undefined, vi.fn() as unknown as typeof fetch);
    const r = await mcp.callTool({ name: 'fatsecret_get_food_entries', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('X-MCP-User');
  });

  it('a not-connected user is told to connect, never gets data', async () => {
    const { mcp } = await connect('nobody@x.dk', vi.fn() as unknown as typeof fetch);
    const r = await mcp.callTool({ name: 'fatsecret_get_food_entries', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('NOT_CONNECTED');
  });

  it('a prepared operation shows writes are disabled, and commit enforces the gate (prepare itself is a pure dry-run preview)', async () => {
    delete process.env.FATSECRET_ENABLE_WRITES;
    const { mcp } = await connect('me@x.dk', vi.fn() as unknown as typeof fetch);
    const prep = await mcp.callTool({
      name: 'fatsecret_prepare_food_entry_create',
      arguments: { foodId: '1', foodEntryName: 'Apple', servingId: '2', numberOfUnits: 1, meal: 'lunch', reason: 'test' },
    });
    expect(prep.isError).toBeFalsy();
    const operation = JSON.parse(textOf(prep));
    expect(operation.policyDecision).toMatchObject({ allowed: false, reason: 'writes disabled' });

    const commit = await mcp.callTool({
      name: 'fatsecret_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-1234567' },
    });
    expect(commit.isError).toBe(true);
    expect(textOf(commit)).toContain('writes disabled');
  });

  it('a prepared operation carries a stable hash and can only be committed by the same identity', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const { mcp } = await connect('me@x.dk', vi.fn() as unknown as typeof fetch);
    const prep = await mcp.callTool({
      name: 'fatsecret_prepare_food_entry_create',
      arguments: { foodId: '1', foodEntryName: 'Apple', servingId: '2', numberOfUnits: 1, meal: 'lunch', reason: 'test' },
    });
    expect(prep.isError).toBeFalsy();
    const operation = JSON.parse(textOf(prep));
    expect(operation.dryRun).toBe(true);
    expect(operation.operationHash).toHaveLength(64);
  });

  it('start_auth returns an authorize URL bound to the resolved user', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new URLSearchParams({ oauth_token: 'req-tok', oauth_token_secret: 'req-sec', oauth_callback_confirmed: 'true' }).toString(), {
        status: 200,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    ) as unknown as typeof fetch;
    const { mcp, store: s } = await connect('me@x.dk', fetchImpl);
    const r = await mcp.callTool({ name: 'fatsecret_start_auth', arguments: {} });
    const out = JSON.parse(textOf(r));
    expect(out.authorizationUrl).toContain('oauth_token=req-tok');
    expect(s.consumeAuthState('me@x.dk')?.requestToken).toBe('req-tok');
  });
});
