import { describe, expect, it } from 'vitest';
import { fromFatSecretDate, toFatSecretDate } from '../src/fatsecret/date.js';

describe('FatSecret date conversion', () => {
  it('epoch day 0 is 1970-01-01', () => {
    expect(toFatSecretDate('1970-01-01')).toBe(0);
    expect(fromFatSecretDate(0)).toBe('1970-01-01');
  });

  it('round-trips arbitrary dates', () => {
    for (const ymd of ['2024-01-01', '2024-02-29', '2026-08-16', '1999-12-31']) {
      expect(fromFatSecretDate(toFatSecretDate(ymd))).toBe(ymd);
    }
  });

  it('is UTC-day based, not local-time (DST-agnostic)', () => {
    // Adjacent calendar days must be exactly 1 apart regardless of any DST
    // transition that might occur around them in a local timezone.
    expect(toFatSecretDate('2026-03-30') + 1).toBe(toFatSecretDate('2026-03-31'));
    expect(toFatSecretDate('2026-10-26') + 1).toBe(toFatSecretDate('2026-10-27'));
  });

  it('rejects malformed date strings', () => {
    expect(() => toFatSecretDate('2026/08/16')).toThrow();
    expect(() => toFatSecretDate('16-08-2026')).toThrow();
  });
});
