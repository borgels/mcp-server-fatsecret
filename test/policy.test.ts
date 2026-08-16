import { afterEach, describe, expect, it } from 'vitest';
import { checkPolicy, requireUser } from '../src/fatsecret/policy.js';
import { prepareOperation, verifyPreparedOperation } from '../src/fatsecret/operations.js';

const originalWrites = process.env.FATSECRET_ENABLE_WRITES;
const originalProfileCreate = process.env.FATSECRET_ENABLE_PROFILE_CREATE;

describe('write policy', () => {
  afterEach(() => {
    if (originalWrites === undefined) delete process.env.FATSECRET_ENABLE_WRITES;
    else process.env.FATSECRET_ENABLE_WRITES = originalWrites;
    if (originalProfileCreate === undefined) delete process.env.FATSECRET_ENABLE_PROFILE_CREATE;
    else process.env.FATSECRET_ENABLE_PROFILE_CREATE = originalProfileCreate;
    delete process.env.FATSECRET_POLICY_PATH;
  });

  it('allows reads by default', () => {
    expect(checkPolicy({ capability: 'x', methodId: 'foods.search', isMutation: false })).toMatchObject({ allowed: true });
  });

  it('blocks writes by default', () => {
    delete process.env.FATSECRET_ENABLE_WRITES;
    expect(checkPolicy({ capability: 'fatsecret_prepare_food_entry_create', methodId: 'food_entry.create', isMutation: true })).toMatchObject({
      allowed: false,
      reason: 'writes disabled',
    });
  });

  it('blocks profile.create even with writes enabled, unless separately gated', () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    delete process.env.FATSECRET_ENABLE_PROFILE_CREATE;
    expect(checkPolicy({ capability: 'x', methodId: 'profile.create', isMutation: true })).toMatchObject({ allowed: false });
    process.env.FATSECRET_ENABLE_PROFILE_CREATE = 'true';
    expect(checkPolicy({ capability: 'x', methodId: 'profile.create', isMutation: true })).toMatchObject({ allowed: true });
  });

  it('prepares stable hashable dry-run operations, bound to a user', () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const operation = prepareOperation({
      capability: 'fatsecret_prepare_food_entry_create',
      methodId: 'food_entry.create',
      user: 'alice@example.com',
      params: { food_id: '1', serving_id: '2', number_of_units: 1, meal: 'lunch' },
      reason: 'lunch',
    });
    expect(operation.dryRun).toBe(true);
    expect(operation.operationHash).toHaveLength(64);
    expect(() => verifyPreparedOperation(operation)).not.toThrow();
  });

  it('detects a tampered prepared operation', () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const operation = prepareOperation({
      capability: 'fatsecret_prepare_food_entry_create',
      methodId: 'food_entry.create',
      user: 'alice@example.com',
      params: { food_id: '1', serving_id: '2', number_of_units: 1, meal: 'lunch' },
      reason: 'lunch',
    });
    expect(() => verifyPreparedOperation({ ...operation, params: { ...operation.params, number_of_units: 5 } })).toThrow('hash does not match');
  });

  it('detects a prepared operation replayed under a different identity', () => {
    process.env.FATSECRET_ENABLE_WRITES = 'true';
    const operation = prepareOperation({
      capability: 'fatsecret_prepare_food_entry_create',
      methodId: 'food_entry.create',
      user: 'alice@example.com',
      params: { food_id: '1', serving_id: '2', number_of_units: 1, meal: 'lunch' },
      reason: 'lunch',
    });
    expect(() => verifyPreparedOperation({ ...operation, user: 'bob@example.com' })).toThrow('hash does not match');
  });
});

describe('requireUser', () => {
  it('throws without a forwarded identity', () => {
    expect(() => requireUser(undefined)).toThrow('X-MCP-User');
  });

  it('returns the identity when present', () => {
    expect(requireUser('me@x.dk')).toBe('me@x.dk');
  });
});
