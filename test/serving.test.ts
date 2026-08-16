import { describe, expect, it } from 'vitest';
import { normalizeServings, pickServing } from '../src/fatsecret/serving.js';

describe('serving helpers', () => {
  it('normalizes a single-object servings field into a one-element array', () => {
    expect(normalizeServings({ serving: { serving_id: '1' } })).toEqual([{ serving_id: '1' }]);
  });

  it('normalizes an array servings field as-is', () => {
    const servings = [{ serving_id: '1' }, { serving_id: '2' }];
    expect(normalizeServings({ serving: servings })).toEqual(servings);
  });

  it('returns an empty array for a missing/malformed servings field', () => {
    expect(normalizeServings(undefined)).toEqual([]);
    expect(normalizeServings({})).toEqual([]);
  });

  it('picks the best fuzzy match by description', () => {
    const servings = [
      { serving_id: '1', serving_description: '1 cup' },
      { serving_id: '2', serving_description: '1 slice' },
      { serving_id: '3', serving_description: '100 g' },
    ];
    expect(pickServing(servings, '1 slice')?.serving_id).toBe('2');
    expect(pickServing(servings, '100g')?.serving_id).toBe('3');
  });

  it('falls back to the first serving when no query is given or nothing matches', () => {
    const servings = [{ serving_id: '1', serving_description: '1 cup' }];
    expect(pickServing(servings, '')?.serving_id).toBe('1');
    expect(pickServing(servings, 'completely unrelated text')?.serving_id).toBe('1');
  });

  it('returns undefined for an empty servings list', () => {
    expect(pickServing([], 'anything')).toBeUndefined();
  });
});
