import { describe, expect, it } from 'vitest';
import { FATSECRET_METHODS, findMethod, searchCapabilities } from '../src/fatsecret/catalog.js';

describe('FatSecret catalog', () => {
  it('throws for an unknown/non-allowlisted method id', () => {
    expect(() => findMethod('food_entry.nuke_everything')).toThrow(/Unknown or non-allowlisted/);
  });

  it('finds every allowlisted method by id', () => {
    for (const method of FATSECRET_METHODS) {
      expect(findMethod(method.id)).toBe(method);
    }
  });

  it('classifies the risky exercise/weight/custom-food writes as commit, and profile.create as dangerous', () => {
    expect(findMethod('weight.update').risk).toBe('commit');
    expect(findMethod('exercise_entries.commit_day').risk).toBe('commit');
    expect(findMethod('food.create').risk).toBe('commit');
    expect(findMethod('profile.create').risk).toBe('dangerous');
  });

  it('searches by keyword across id/summary/keywords', () => {
    const results = searchCapabilities('weight');
    expect(results.some(r => r.id === 'weight.update')).toBe(true);
  });

  it('returns everything (bounded by limit) for an empty query', () => {
    const results = searchCapabilities('', 5);
    expect(results).toHaveLength(5);
  });
});
