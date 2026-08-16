import { afterEach, describe, expect, it } from 'vitest';
import { FATSECRET_METHODS, availableMethods, findMethod, premierEnabled, searchCapabilities } from '../src/fatsecret/catalog.js';

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

describe('Premier tier gating', () => {
  const original = process.env.FATSECRET_PREMIER;
  afterEach(() => {
    if (original === undefined) delete process.env.FATSECRET_PREMIER;
    else process.env.FATSECRET_PREMIER = original;
  });

  it('defaults to Basic (Premier disabled)', () => {
    delete process.env.FATSECRET_PREMIER;
    expect(premierEnabled()).toBe(false);
  });

  it('hides Premier-only methods on Basic, exposes them on Premier', () => {
    delete process.env.FATSECRET_PREMIER;
    const basic = availableMethods().map(m => m.id);
    expect(basic).not.toContain('food.create');
    expect(basic).not.toContain('foods.get_favorites');
    // Diary writes are Basic-tier and must stay available.
    expect(basic).toContain('food_entry.create');
    expect(basic).toContain('weight.update');
    expect(basic).toContain('food.add_favorite');

    process.env.FATSECRET_PREMIER = 'true';
    const premier = availableMethods().map(m => m.id);
    expect(premier).toContain('food.create');
    expect(premier).toContain('foods.get_favorites');
    expect(premier).toHaveLength(FATSECRET_METHODS.length);
  });

  it('keeps Premier-only methods out of capability search on Basic', () => {
    delete process.env.FATSECRET_PREMIER;
    expect(searchCapabilities('custom food').some(r => r.id === 'food.create')).toBe(false);
    process.env.FATSECRET_PREMIER = 'true';
    expect(searchCapabilities('custom food').some(r => r.id === 'food.create')).toBe(true);
  });
});
