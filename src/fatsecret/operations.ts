import { createHash } from 'node:crypto';
import { findMethod } from './catalog.js';
import { checkPolicy, type PolicyDecision } from './policy.js';

export interface PreparedOperation {
  capability: string;
  methodId: string;
  user: string;
  params: Record<string, string | number | boolean>;
  dryRun: true;
  reason: string;
  operationHash: string;
  policyDecision: PolicyDecision;
}

export interface PrepareOperationInput {
  capability: string;
  methodId: string;
  /** The resolved (gateway-verified) identity this operation will run as — baked into the hash so a
   * prepared operation can never be committed under a different person's identity. */
  user: string;
  params: Record<string, string | number | boolean>;
  reason: string;
}

export function prepareOperation(input: PrepareOperationInput): PreparedOperation {
  const method = findMethod(input.methodId);
  const policyDecision = checkPolicy({
    capability: input.capability,
    methodId: input.methodId,
    isMutation: method.httpMethod === 'POST',
  });
  const operationBase = {
    capability: input.capability,
    methodId: input.methodId,
    user: input.user,
    params: input.params,
    reason: input.reason,
  };

  return {
    ...operationBase,
    dryRun: true,
    operationHash: stableHash(operationBase),
    policyDecision,
  };
}

/**
 * Verifies the operation hash, throwing on any tamper/drift between prepare
 * and commit (including a switched `user`, which would otherwise let a
 * prepared operation be replayed against a different person's diary).
 */
export function verifyPreparedOperation(operation: PreparedOperation): PreparedOperation {
  const expected = stableHash({
    capability: operation.capability,
    methodId: operation.methodId,
    user: operation.user,
    params: operation.params,
    reason: operation.reason,
  });

  if (expected !== operation.operationHash) {
    throw new Error('Prepared operation hash does not match the operation payload.');
  }

  return operation;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
