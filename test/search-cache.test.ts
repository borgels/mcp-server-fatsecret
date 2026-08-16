import { describe, expect, it, vi } from 'vitest';
import { SearchCache } from '../src/fatsecret/search-cache.js';

describe('SearchCache', () => {
  it('misses initially, then hits after set', () => {
    const cache = new SearchCache();
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', { data: 1 });
    expect(cache.get('k')).toEqual({ data: 1 });
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    const cache = new SearchCache(1000);
    cache.set('k', 'v');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts the oldest entry once over the size cap', () => {
    const cache = new SearchCache(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('normalizes the cache key regardless of param key order', () => {
    expect(SearchCache.keyFor('foods.search', { a: 1, b: 2 })).toBe(SearchCache.keyFor('foods.search', { b: 2, a: 1 }));
  });
});
