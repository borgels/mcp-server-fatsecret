import { FatSecretHttpError } from '../errors.js';

/**
 * FatSecret's OAuth2 client-credentials grant is app-level only (no per-user
 * delegation) — used for the public food/recipe search surface. Token
 * requests are IP-allowlisted on FatSecret's side.
 *
 * IMPORTANT: FatSecret issues TWO credential pairs for the same app, and they
 * are not interchangeable. The OAuth2 pair (Client ID / Client Secret) is
 * separate from the OAuth1 pair (Consumer Key / Shared Secret) used for
 * per-user diary access. In practice the *id* is the same value while the
 * *secrets* differ — signing OAuth1 with the OAuth2 secret fails with a bare
 * "Invalid signature", which is a genuinely confusing way to find this out.
 * Hence the dedicated FATSECRET_OAUTH2_* variables, falling back to the
 * consumer pair for setups where only one pair exists.
 */
export interface OAuth2ClientOptions {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

const REFRESH_SKEW_MS = 60_000;

export class OAuth2ClientCredentials {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(options: OAuth2ClientOptions = {}) {
    this.clientId = options.clientId ?? process.env.FATSECRET_OAUTH2_CLIENT_ID ?? process.env.FATSECRET_CONSUMER_KEY ?? '';
    this.clientSecret =
      options.clientSecret ?? process.env.FATSECRET_OAUTH2_CLIENT_SECRET ?? process.env.FATSECRET_CONSUMER_SECRET ?? '';
    this.scope = options.scope ?? process.env.FATSECRET_OAUTH2_SCOPE ?? 'basic';
    this.tokenUrl = options.tokenUrl ?? process.env.FATSECRET_OAUTH2_TOKEN_URL ?? 'https://oauth.fatsecret.com/connect/token';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.FATSECRET_TIMEOUT_MS ?? 30_000);
  }

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_SKEW_MS) {
      return this.cached.token;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('FatSecret app is not configured (FATSECRET_CONSUMER_KEY / _CONSUMER_SECRET).');
    }
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: this.scope });
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as TokenResponse | null;
    if (!res.ok || !json?.access_token) {
      throw new FatSecretHttpError({
        status: res.status,
        url: this.tokenUrl,
        payload: json,
        fallbackMessage: 'FatSecret OAuth2 client-credentials token request failed.',
      });
    }
    this.cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000 };
    return json.access_token;
  }
}
