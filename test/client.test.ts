import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatSecretClient } from '../src/fatsecret/client.js';
import { OAuth2ClientCredentials } from '../src/fatsecret/oauth2.js';
import { TokenStore } from '../src/fatsecret/token-store.js';
import { redactSecrets } from '../src/errors.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('FatSecretClient', () => {
  it('refuses non-https base URLs (except loopback)', () => {
    expect(() => new FatSecretClient({ baseUrl: 'http://platform.fatsecret.com/rest/server.api', fetchImpl: vi.fn() as unknown as typeof fetch })).toThrow(/https/);
    expect(() => new FatSecretClient({ baseUrl: 'http://127.0.0.1:8080/rest/server.api', fetchImpl: vi.fn() as unknown as typeof fetch })).not.toThrow();
  });

  it('public requests send an OAuth2 bearer token and hit the public method', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT', expires_in: 86400 })); // token endpoint
    fetchMock.mockResolvedValueOnce(jsonResponse({ foods: { food: [] } })); // actual call

    const oauth2 = new OAuth2ClientCredentials({ clientId: 'ck', clientSecret: 'cs', fetchImpl: fetchMock });
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock, oauth2 });

    await client.publicRequest('foods.search', { search_expression: 'apple' });

    const [, init] = fetchMock.mock.calls[1]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' });
    const url = String(fetchMock.mock.calls[1]![0]);
    expect(url).toContain('method=foods.search');
    expect(url).toContain('search_expression=apple');
  });

  it('user requests are OAuth1-signed with the stored per-user token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ food_entries: { food_entry: [] } }));
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    const dir = mkdtempSync(join(tmpdir(), 'fatsecret-client-'));
    const store = new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
    store.setTokens('u@x.dk', { oauthToken: 'user-token', oauthTokenSecret: 'user-secret', authMode: 'three_legged', connectedAt: Date.now() });

    await client.userRequest('u@x.dk', store, 'food_entries.get', { date: 20000 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('oauth_signature=');
    expect(String(url)).toContain('oauth_token=user-token');
    expect(String(url)).toContain('method=food_entries.get');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws NOT_CONNECTED when the user has no stored token', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    const dir = mkdtempSync(join(tmpdir(), 'fatsecret-client-'));
    const store = new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
    await expect(client.userRequest('nobody@x.dk', store, 'food_entries.get', {})).rejects.toThrow('NOT_CONNECTED');
    expect(fetchMock).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects calling a private method via publicRequest and vice versa', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    await expect(client.publicRequest('food_entry.create', {})).rejects.toThrow(/not a public method/);
  });

  it('refuses Premier-only methods on the Basic tier with an explanatory error, without calling out', async () => {
    const originalPremier = process.env.FATSECRET_PREMIER;
    delete process.env.FATSECRET_PREMIER;
    const fetchMock = vi.fn<typeof fetch>();
    const client = new FatSecretClient({ consumerKey: 'ck', consumerSecret: 'cs', fetchImpl: fetchMock });
    const dir = mkdtempSync(join(tmpdir(), 'fatsecret-premier-'));
    const store = new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
    store.setTokens('u@x.dk', { oauthToken: 't', oauthTokenSecret: 's', authMode: 'three_legged', connectedAt: Date.now() });

    await expect(client.userRequest('u@x.dk', store, 'food.create', {})).rejects.toThrow(/Premier Exclusive/);
    expect(fetchMock).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
    if (originalPremier === undefined) delete process.env.FATSECRET_PREMIER;
    else process.env.FATSECRET_PREMIER = originalPremier;
  });
});

describe('OAuth2ClientCredentials', () => {
  it('prefers the dedicated OAuth2 credentials over the OAuth1 consumer pair', async () => {
    const original = { ...process.env };
    process.env.FATSECRET_CONSUMER_KEY = 'oauth1-key';
    process.env.FATSECRET_CONSUMER_SECRET = 'oauth1-secret';
    process.env.FATSECRET_OAUTH2_CLIENT_ID = 'oauth2-id';
    process.env.FATSECRET_OAUTH2_CLIENT_SECRET = 'oauth2-secret';

    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ access_token: 'AT', expires_in: 86400 }));
    await new OAuth2ClientCredentials({ fetchImpl: fetchMock }).getToken();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization ?? '';
    const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
    // Using the OAuth1 secret here is what caused "Invalid signature" in production.
    expect(decoded).toBe('oauth2-id:oauth2-secret');

    process.env = original;
  });

  it('falls back to the consumer pair when no OAuth2 credentials are set', async () => {
    const original = { ...process.env };
    delete process.env.FATSECRET_OAUTH2_CLIENT_ID;
    delete process.env.FATSECRET_OAUTH2_CLIENT_SECRET;
    process.env.FATSECRET_CONSUMER_KEY = 'only-key';
    process.env.FATSECRET_CONSUMER_SECRET = 'only-secret';

    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ access_token: 'AT', expires_in: 86400 }));
    await new OAuth2ClientCredentials({ fetchImpl: fetchMock }).getToken();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const decoded = Buffer.from(((init.headers as Record<string, string>).Authorization ?? '').replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('only-key:only-secret');

    process.env = original;
  });

  it('caches the token and only refetches after the expiry buffer', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT1', expires_in: 86400 }));
    const oauth2 = new OAuth2ClientCredentials({ clientId: 'ck', clientSecret: 'cs', fetchImpl: fetchMock });

    const t1 = await oauth2.getToken();
    const t2 = await oauth2.getToken();
    expect(t1).toBe('AT1');
    expect(t2).toBe('AT1');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached, no second token fetch
  });

  it('throws if the token endpoint returns an error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'invalid_client' }, 401));
    const oauth2 = new OAuth2ClientCredentials({ clientId: 'ck', clientSecret: 'cs', fetchImpl: fetchMock });
    await expect(oauth2.getToken()).rejects.toThrow();
  });
});

describe('secret redaction', () => {
  it('redacts consumer/token secrets and oauth_signature from formatted errors', () => {
    expect(redactSecrets('oauth_signature=abc123%2F&oauth_token=tok')).toContain('[REDACTED]');
    expect(redactSecrets('consumer_secret: mysecretvalue')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer sometoken123')).toContain('[REDACTED]');
  });
});
