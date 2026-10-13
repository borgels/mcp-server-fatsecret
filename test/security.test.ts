import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FatSecretClient } from '../src/fatsecret/client.js';
import { OAuth2ClientCredentials } from '../src/fatsecret/oauth2.js';
import { prepareOperation, verifyPreparedOperation, OPERATION_TTL_MS } from '../src/fatsecret/operations.js';
import { TokenStore } from '../src/fatsecret/token-store.js';
import { createServer } from '../src/server.js';
import { assertAuthorized, assertSafeHttpStartup, tokensMatch } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fatsecret-sec-'));
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
}

function makeStore(): TokenStore {
  const s = new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
  for (const user of ['me@x.dk', 'other@x.dk']) {
    s.setTokens(user, { oauthToken: `tok-${user}`, oauthTokenSecret: 'sec', authMode: 'three_legged', connectedAt: Date.now() });
  }
  return s;
}

async function connect(onBehalfOf: string | undefined, fetchImpl: typeof fetch, s = makeStore()) {
  const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl });
  const server = createServer({ client, store: s, onBehalfOf });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return { mcp, store: s };
}

const foodEntry = { foodId: '1', foodEntryName: 'Apple', servingId: '2', numberOfUnits: 1, meal: 'lunch', reason: 'test' };

describe('prepared operation signing', () => {
  it('uses a keyed HMAC, not a plain hash anyone can recompute', () => {
    process.env.FATSECRET_PREPARE_SECRET = 'secret-a';
    const op = prepareOperation({ capability: 'c', methodId: 'food_entry.delete', user: 'u', params: { food_entry_id: '1' }, reason: 'r' });
    process.env.FATSECRET_PREPARE_SECRET = 'secret-b';
    expect(() => verifyPreparedOperation(op, { confirmOperationHash: op.operationHash, user: 'u' })).toThrow('signature does not match');
  });

  it('rejects an expired operation', () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const op = prepareOperation({ capability: 'c', methodId: 'food_entry.delete', user: 'u', params: { food_entry_id: '1' }, reason: 'r' });
    const later = new Date(Date.now() + OPERATION_TTL_MS + 1000);
    expect(() => verifyPreparedOperation(op, { confirmOperationHash: op.operationHash, user: 'u', now: later })).toThrow('expired');
  });

  it('signature covers expiresAt (cannot be extended)', () => {
    const op = prepareOperation({ capability: 'c', methodId: 'food_entry.delete', user: 'u', params: { food_entry_id: '1' }, reason: 'r' });
    const extended = { ...op, expiresAt: new Date(Date.now() + 10 * OPERATION_TTL_MS).toISOString() };
    expect(() => verifyPreparedOperation(extended, { confirmOperationHash: op.operationHash, user: 'u' })).toThrow('signature does not match');
  });
});

describe('commit re-evaluates policy server-side (F1)', () => {
  it('ignores a caller-supplied policyDecision when writes are disabled', async () => {
    delete process.env.FATSECRET_ENABLE_WRITES;
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const prep = await mcp.callTool({ name: 'fatsecret_prepare_food_entry_create', arguments: foodEntry });
    const operation = JSON.parse(textOf(prep));
    operation.policyDecision = { allowed: true, reason: 'forged', policy: {} };
    const commit = await mcp.callTool({
      name: 'fatsecret_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-12345678' },
    });
    expect(commit.isError).toBe(true);
    expect(textOf(commit)).toContain('writes disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an operation that was prepared while writes were enabled but committed after they were disabled', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const operation = JSON.parse(textOf(await mcp.callTool({ name: 'fatsecret_prepare_food_entry_create', arguments: foodEntry })));
    delete process.env.FATSECRET_ENABLE_WRITES;
    const commit = await mcp.callTool({
      name: 'fatsecret_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-12345678' },
    });
    expect(commit.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged operation whose hash was recomputed without the server secret', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const operation = JSON.parse(textOf(await mcp.callTool({ name: 'fatsecret_prepare_food_entry_create', arguments: foodEntry })));
    operation.methodId = 'food_entry.delete';
    operation.params = { food_entry_id: '999' };
    const commit = await mcp.callTool({
      name: 'fatsecret_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-12345678' },
    });
    expect(commit.isError).toBe(true);
    expect(textOf(commit)).toContain('signature does not match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commits a valid signed operation', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ food_entry_id: { value: '7' } }));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const operation = JSON.parse(textOf(await mcp.callTool({ name: 'fatsecret_prepare_food_entry_create', arguments: foodEntry })));
    const commit = await mcp.callTool({
      name: 'fatsecret_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'valid-commit-1' },
    });
    expect(commit.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('commit_profile_create (F1)', () => {
  function profileOp(user: string) {
    return prepareOperation({ capability: 'fatsecret_commit_profile_create', methodId: 'profile.create', user, params: {}, reason: 'dev' });
  }

  it('is refused unless FATSECRET_ENABLE_PROFILE_CREATE is on', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    delete process.env.FATSECRET_ENABLE_PROFILE_CREATE;
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ oauth_token: 'a', oauth_token_secret: 'b' }));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const operation = profileOp('me@x.dk');
    const r = await mcp.callTool({
      name: 'fatsecret_commit_profile_create',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-12345678' },
    });
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an operation prepared for a different user', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    process.env.FATSECRET_ENABLE_PROFILE_CREATE = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ oauth_token: 'a', oauth_token_secret: 'b' }));
    const { mcp, store } = await connect('me@x.dk', fetchMock);
    const operation = profileOp('other@x.dk');
    const r = await mcp.callTool({
      name: 'fatsecret_commit_profile_create',
      arguments: { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'idem-12345678' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('different identity');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getTokens('me@x.dk')?.oauthToken).toBe('tok-me@x.dk');
  });
});

describe('reserved request parameters (F2)', () => {
  it('client rejects params that try to override method/format/oauth_*', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    const store = makeStore();
    for (const key of ['method', 'format', 'oauth_token', 'OAUTH_signature']) {
      await expect(client.userRequest('me@x.dk', store, 'food_entries.get', { [key]: 'x' })).rejects.toThrow('reserved');
    }
    const oauth2 = new OAuth2ClientCredentials({ clientId: 'ck', clientSecret: 'cs', fetchImpl: fetchMock });
    const pub = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock, oauth2 });
    await expect(pub.publicRequest('foods.search', { method: 'food_entry.delete' })).rejects.toThrow('reserved');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the signed method is always the allowlisted one', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    await client.userRequest('me@x.dk', makeStore(), 'food_entries.get', { date: 1 });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('method')).toEqual(['food_entries.get']);
  });

  it('call_endpoint rejects reserved keys in params at the schema', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const r = await mcp.callTool({ name: 'fatsecret_call_endpoint', arguments: { methodId: 'food_entries.get', params: { method: 'food_entry.delete' } } });
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('log_one_off_exercise policy (F3)', () => {
  it('is refused when writes are disabled', async () => {
    delete process.env.FATSECRET_ENABLE_WRITES;
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const r = await mcp.callTool({ name: 'fatsecret_log_one_off_exercise', arguments: { exerciseId: 1, minutes: 30, date: '2026-10-01', idempotencyKey: 'idem-12345678' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('writes disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs when writes are enabled', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ success: { value: 1 } }));
    const { mcp } = await connect('me@x.dk', fetchMock);
    const r = await mcp.callTool({ name: 'fatsecret_log_one_off_exercise', arguments: { exerciseId: 1, minutes: 30, date: '2026-10-01', idempotencyKey: 'one-off-key-1' } });
    expect(r.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('idempotency scoping (F4)', () => {
  it('checks identity before the idempotency cache and scopes keys per user', async () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ private: 'me-only' }));
    const s = makeStore();
    const me = await connect('me@x.dk', fetchMock, s);
    const operation = JSON.parse(textOf(await me.mcp.callTool({ name: 'fatsecret_prepare_food_entry_create', arguments: foodEntry })));
    const args = { operation, confirmOperationHash: operation.operationHash, idempotencyKey: 'shared-key-123' };
    expect((await me.mcp.callTool({ name: 'fatsecret_commit_prepared_operation', arguments: args })).isError).toBeFalsy();

    const other = await connect('other@x.dk', fetchMock, s);
    const r = await other.mcp.callTool({ name: 'fatsecret_commit_prepared_operation', arguments: args });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('me-only');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP hardening', () => {
  it('compares the bearer token in constant time and rejects wrong tokens', () => {
    expect(tokensMatch('Bearer abc', 'Bearer abc')).toBe(true);
    expect(tokensMatch('Bearer abd', 'Bearer abc')).toBe(false);
    expect(tokensMatch('', 'Bearer abc')).toBe(false);
    const req = (authorization?: string) => ({ headers: { authorization } }) as unknown as IncomingMessage;
    const config = { host: '127.0.0.1', port: 0, maxBodyBytes: 1, httpToken: 'abc' };
    expect(() => assertAuthorized(req('Bearer abc'), config)).not.toThrow();
    expect(() => assertAuthorized(req('Bearer nope'), config)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req(undefined), config)).toThrow('Unauthorized');
  });

  it('refuses to start when trusting forwarded users without MCP_HTTP_TOKEN', () => {
    const base = { host: '127.0.0.1', port: 0, maxBodyBytes: 1 };
    expect(() => assertSafeHttpStartup(base, { FATSECRET_TRUST_FORWARDED_USER: 'true' })).toThrow('MCP_HTTP_TOKEN');
    expect(() => assertSafeHttpStartup({ ...base, httpToken: 't' }, { FATSECRET_TRUST_FORWARDED_USER: 'true' })).not.toThrow();
    expect(() => assertSafeHttpStartup(base, {})).not.toThrow();
  });
});
