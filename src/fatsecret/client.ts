import { FatSecretHttpError } from '../errors.js';
import { findMethod, premierEnabled, type FatSecretMethod } from './catalog.js';
import { OAuth1Signer, type OAuth1Token } from './oauth1.js';
import { OAuth2ClientCredentials } from './oauth2.js';
import type { TokenStore } from './token-store.js';

export type FatSecretParams = Record<string, string | number | boolean | undefined>;

export interface FatSecretClientOptions {
  consumerKey?: string;
  consumerSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  oauth2?: OAuth2ClientCredentials;
}

/** Legacy RPC-style single endpoint (`method=` query param), still the only
 * surface for most write methods. Both auth surfaces (OAuth2 bearer / OAuth1
 * signed) are layered over this one endpoint shape. */
const DEFAULT_BASE_URL = 'https://platform.fatsecret.com/rest/server.api';

/**
 * Fail fast with an explanation rather than letting FatSecret return an opaque
 * error for a method the configured tier can't call.
 */
function assertMethodAvailable(method: FatSecretMethod): void {
  if (method.premierOnly && !premierEnabled()) {
    throw new Error(
      `${method.id} is Premier Exclusive and this app is on the free Basic tier. ` +
        'Set FATSECRET_PREMIER=true only if the FatSecret app has actually been upgraded to Premier.',
    );
  }
}

function assertHttpsOrLoopback(url: string): void {
  const parsed = new URL(url);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(`Refusing non-https FatSecret base URL: ${url}`);
  }
}

export class FatSecretClient {
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signer: OAuth1Signer;
  private readonly oauth2: OAuth2ClientCredentials;

  constructor(options: FatSecretClientOptions = {}) {
    this.consumerKey = options.consumerKey ?? process.env.FATSECRET_CONSUMER_KEY ?? '';
    this.consumerSecret = options.consumerSecret ?? process.env.FATSECRET_CONSUMER_SECRET ?? '';
    this.baseUrl = options.baseUrl ?? process.env.FATSECRET_BASE_URL ?? DEFAULT_BASE_URL;
    assertHttpsOrLoopback(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.FATSECRET_TIMEOUT_MS ?? 30_000);
    this.signer = new OAuth1Signer(this.consumerKey, this.consumerSecret);
    this.oauth2 = options.oauth2 ?? new OAuth2ClientCredentials({ fetchImpl: this.fetchImpl });
  }

  private requireConfigured(): void {
    if (!this.consumerKey || !this.consumerSecret) {
      throw new Error('FatSecret app is not configured (FATSECRET_CONSUMER_KEY / _CONSUMER_SECRET).');
    }
  }

  /** Public food/recipe database call, authenticated via OAuth2 client-credentials. */
  async publicRequest<T = unknown>(methodId: string, params: FatSecretParams = {}): Promise<T> {
    const method = findMethod(methodId);
    if (method.authSurface !== 'oauth2-public') {
      throw new Error(`${methodId} is not a public method; call userRequest() instead.`);
    }
    assertMethodAvailable(method);
    const token = await this.oauth2.getToken();
    const url = buildUrl(this.baseUrl, { method: methodId, format: 'json', ...cleanParams(params) });
    return this.send(url, method.httpMethod, { Authorization: `Bearer ${token}` });
  }

  /** Private per-user call (diary/weight/exercise/profile/etc.), OAuth1-signed with that user's stored token. */
  async userRequest<T = unknown>(user: string, store: TokenStore, methodId: string, params: FatSecretParams = {}): Promise<T> {
    this.requireConfigured();
    const method = findMethod(methodId);
    if (method.authSurface !== 'oauth1-private') {
      throw new Error(`${methodId} is not a private method; call publicRequest() instead.`);
    }
    assertMethodAvailable(method);
    const stored = store.getTokens(user);
    if (!stored) {
      throw new Error('NOT_CONNECTED');
    }
    return this.userRequestWithToken(methodId, method.httpMethod, params, { key: stored.oauthToken, secret: stored.oauthTokenSecret });
  }

  /** Same as userRequest but with an explicit token pair — used by the auth flow itself, before a store row exists. */
  async userRequestWithToken<T = unknown>(
    methodId: string,
    httpMethod: 'GET' | 'POST',
    params: FatSecretParams,
    token?: OAuth1Token,
  ): Promise<T> {
    this.requireConfigured();
    const allParams = { method: methodId, format: 'json', ...cleanParams(params) };
    const signed = this.signer.authorizeParams({ method: httpMethod, url: this.baseUrl, params: allParams, token });
    const url = httpMethod === 'GET' ? buildUrl(this.baseUrl, signed) : this.baseUrl;
    return this.send(url, httpMethod, undefined, httpMethod === 'POST' ? signed : undefined);
  }

  /** OAuth1 request-token / access-token exchange calls (three-legged flow). Consumer-signed only, no user token yet. */
  async oauth1Call<T = unknown>(path: string, params: FatSecretParams, token?: OAuth1Token): Promise<T> {
    this.requireConfigured();
    const url = `https://authentication.fatsecret.com${path}`;
    const signed = this.signer.authorizeParams({ method: 'POST', url, params: cleanParams(params), token });
    return this.send(url, 'POST', undefined, signed, 'form');
  }

  private async send<T>(
    url: string,
    httpMethod: 'GET' | 'POST',
    headers?: Record<string, string>,
    formBody?: Record<string, string>,
    responseFormat: 'json' | 'form' = 'json',
  ): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: httpMethod,
      headers: {
        ...headers,
        ...(formBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: formBody ? new URLSearchParams(formBody).toString() : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (responseFormat === 'form') {
      const text = await res.text();
      if (!res.ok) {
        throw new FatSecretHttpError({ status: res.status, url, payload: text, fallbackMessage: 'FatSecret OAuth1 request failed.' });
      }
      return Object.fromEntries(new URLSearchParams(text)) as T;
    }

    const json = (await res.json().catch(() => null)) as (T & { error?: { code?: number; message?: string } }) | null;
    if (!res.ok || (json && typeof json === 'object' && 'error' in json && json.error)) {
      throw new FatSecretHttpError({ status: res.status, url, payload: json, fallbackMessage: 'FatSecret API request failed.' });
    }
    return json as T;
  }
}

function cleanParams(params: FatSecretParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) {
      out[k] = String(v);
    }
  }
  return out;
}

function buildUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}
