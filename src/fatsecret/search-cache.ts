/**
 * Small Map-based TTL/size-capped cache for the public food/recipe search and
 * get_food/get_recipe calls. This data is not user-specific, so one cache is
 * safely shared across every person using this server. Closes a gap noted in
 * existing open-source FatSecret MCP servers, which re-hit the live API for
 * every repeated lookup of the same common food.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class SearchCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly maxEntries = 200,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for a simple LRU-ish eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  static keyFor(methodId: string, params: Record<string, unknown>): string {
    return `${methodId}:${JSON.stringify(params, Object.keys(params).sort())}`;
  }
}
