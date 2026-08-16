/**
 * FatSecret's write endpoints have no Idempotency-Key header (unlike
 * e-conomic) — this makes idempotencyKey a LOCAL-ONLY dedup device: a retried
 * commit with the same key + the same operation hash returns the cached
 * result without re-calling FatSecret; the same key with a different hash is
 * rejected (tamper-style). This does NOT protect against a double-post if the
 * MCP process restarts between the first attempt and a retry — it is an
 * in-memory, single-process safety net only.
 */

interface CacheEntry {
  operationHash: string;
  result: unknown;
  committedAt: number;
}

const TTL_MS = 15 * 60 * 1000;

export class IdempotencyCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Returns a cached result if idempotencyKey was already committed with the same hash. Throws on hash mismatch. */
  check(idempotencyKey: string, operationHash: string): { hit: true; result: unknown } | { hit: false } {
    this.gc();
    const entry = this.entries.get(idempotencyKey);
    if (!entry) {
      return { hit: false };
    }
    if (entry.operationHash !== operationHash) {
      throw new Error('idempotencyKey was already used for a different operation.');
    }
    return { hit: true, result: entry.result };
  }

  record(idempotencyKey: string, operationHash: string, result: unknown): void {
    this.entries.set(idempotencyKey, { operationHash, result, committedAt: Date.now() });
  }

  private gc(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.committedAt > TTL_MS) {
        this.entries.delete(key);
      }
    }
  }
}
