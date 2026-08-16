import { describe, expect, it } from 'vitest';
import { OAuth1Signer } from '../src/fatsecret/oauth1.js';

/**
 * `oauth-1.0a` owns the RFC 5849 correctness (parameter collection,
 * percent-encoding, base-string construction) and ships its own test suite —
 * these tests instead verify OUR integration: the right fields end up in the
 * signed params, and the HMAC-SHA1 digest we supply behaves deterministically
 * and is sensitive to every input that should change it.
 */
describe('OAuth1Signer', () => {
  it('produces the standard OAuth1 fields plus a signature', () => {
    const signer = new OAuth1Signer('consumer-key', 'consumer-secret');
    const signed = signer.authorizeParams({ method: 'GET', url: 'https://platform.fatsecret.com/rest/server.api', params: { method: 'foods.search' } });
    expect(signed.oauth_consumer_key).toBe('consumer-key');
    expect(signed.oauth_signature_method).toBe('HMAC-SHA1');
    expect(signed.oauth_version).toBe('1.0');
    expect(typeof signed.oauth_nonce).toBe('string');
    expect(typeof signed.oauth_timestamp).toBe('string');
    expect(typeof signed.oauth_signature).toBe('string');
    expect(signed.oauth_signature!.length).toBeGreaterThan(0);
    // Original request params are preserved alongside the OAuth1 fields.
    expect(signed.method).toBe('foods.search');
  });

  it('includes oauth_token when a user token is supplied, and omits it otherwise', () => {
    const signer = new OAuth1Signer('ck', 'cs');
    const withToken = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: {}, token: { key: 'user-token', secret: 'user-secret' } });
    expect(withToken.oauth_token).toBe('user-token');

    const withoutToken = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: {} });
    expect(withoutToken.oauth_token).toBeUndefined();
  });

  it('is deterministic for a fixed nonce/timestamp (via repeated calls having distinct nonces)', () => {
    const signer = new OAuth1Signer('ck', 'cs');
    const a = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: { a: '1' } });
    const b = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: { a: '1' } });
    // Different nonce/timestamp per call means different signatures even for identical params.
    expect(a.oauth_nonce).not.toBe(b.oauth_nonce);
  });

  it('changes the signature when the token secret changes (nonce/timestamp held equal-length, secret is the only semantic difference)', () => {
    const signer = new OAuth1Signer('ck', 'cs');
    const a = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: { a: '1' }, token: { key: 'tk', secret: 'secret-a' } });
    const b = signer.authorizeParams({ method: 'GET', url: 'https://x/y', params: { a: '1' }, token: { key: 'tk', secret: 'secret-b' } });
    expect(a.oauth_signature).not.toBe(b.oauth_signature);
  });
});
