import { describe, expect, it } from 'vitest';
import { IdempotencyCache } from '../src/fatsecret/idempotency.js';

describe('IdempotencyCache', () => {
  it('is a miss the first time', () => {
    const cache = new IdempotencyCache();
    expect(cache.check('key-1', 'hash-a')).toEqual({ hit: false });
  });

  it('returns the cached result for the same key + same hash', () => {
    const cache = new IdempotencyCache();
    cache.record('key-1', 'hash-a', { ok: true });
    expect(cache.check('key-1', 'hash-a')).toEqual({ hit: true, result: { ok: true } });
  });

  it('throws if the same key is reused with a different hash', () => {
    const cache = new IdempotencyCache();
    cache.record('key-1', 'hash-a', { ok: true });
    expect(() => cache.check('key-1', 'hash-b')).toThrow('already used for a different operation');
  });
});
