import { createHmac } from 'node:crypto';
import OAuth from 'oauth-1.0a';

export interface OAuth1Token {
  key: string;
  secret: string;
}

export interface SignRequestInput {
  method: 'GET' | 'POST';
  url: string;
  params: Record<string, string>;
  token?: OAuth1Token;
}

/**
 * Thin wrapper around `oauth-1.0a`, which handles the fiddly RFC 5849 parts
 * (parameter collection, RFC 3986 percent-encoding, base-string construction,
 * nonce/timestamp generation) — we only supply the HMAC-SHA1 digest itself,
 * computed with node:crypto so the actual cryptographic primitive is one call
 * we own and can unit-test directly.
 */
export class OAuth1Signer {
  private readonly oauth: OAuth;

  constructor(consumerKey: string, consumerSecret: string) {
    this.oauth = new OAuth({
      consumer: { key: consumerKey, secret: consumerSecret },
      signature_method: 'HMAC-SHA1',
      hash_function: (baseString: string, key: string) => createHmac('sha1', key).update(baseString).digest('base64'),
    });
  }

  /** Returns the full set of OAuth1 params (including oauth_signature) merged with the request params. */
  authorizeParams(input: SignRequestInput): Record<string, string> {
    const authorized = this.oauth.authorize({ url: input.url, method: input.method, data: input.params }, input.token);
    return { ...input.params, ...toStringRecord(authorized) };
  }
}

function toStringRecord(value: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = String(v);
  }
  return out;
}
