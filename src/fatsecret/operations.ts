import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { findMethod } from './catalog.js';
import { checkPolicy, type PolicyDecision } from './policy.js';

/**
 * Two-step writes: prepare returns a dry-run preview signed with an HMAC
 * (keyed by FATSECRET_PREPARE_SECRET, or a random per-process secret when
 * unset), and commit accepts only an operation this server signed, that has
 * not expired, and that was prepared for the same user. The signature covers
 * everything that drives the actual API call (capability, method, user,
 * params, reason, timestamps). The policy decision shown in the preview is
 * informational only — commit always re-evaluates policy server-side.
 */

export interface PreparedOperation {
  capability: string;
  methodId: string;
  user: string;
  params: Record<string, string | number | boolean>;
  dryRun: true;
  reason: string;
  preparedAt: string;
  expiresAt: string;
  operationHash: string;
  /** Informational preview only; never trusted at commit. */
  policyDecision: PolicyDecision;
}

export interface PrepareOperationInput {
  capability: string;
  methodId: string;
  /** The resolved (gateway-verified) identity this operation will run as — bound into the signature so a
   * prepared operation can never be committed under a different person's identity. */
  user: string;
  params: Record<string, string | number | boolean>;
  reason: string;
}

export const OPERATION_TTL_MS = 15 * 60 * 1000;
const processSecret = randomBytes(32);

function secret(): Buffer {
  const configured = process.env.FATSECRET_PREPARE_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

export function isMutationMethod(methodId: string): boolean {
  return findMethod(methodId).httpMethod === 'POST';
}

export function prepareOperation(input: PrepareOperationInput, now = new Date()): PreparedOperation {
  findMethod(input.methodId);
  const policyDecision = checkPolicy({
    capability: input.capability,
    methodId: input.methodId,
    isMutation: isMutationMethod(input.methodId),
  });
  const unsigned = {
    capability: input.capability,
    methodId: input.methodId,
    user: input.user,
    params: input.params,
    reason: input.reason,
    preparedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OPERATION_TTL_MS).toISOString(),
  };

  return {
    ...unsigned,
    dryRun: true,
    operationHash: sign(unsigned),
    policyDecision,
  };
}

export interface VerifyContext {
  confirmOperationHash: string;
  user: string;
  now?: Date;
}

/**
 * Verifies the HMAC signature, the echoed hash, expiry and the acting user,
 * then re-runs policy for the method server-side. Returns the operation
 * rebuilt from signed fields only (the caller-supplied policyDecision is
 * discarded).
 */
export function verifyPreparedOperation(raw: unknown, context: VerifyContext): PreparedOperation {
  if (!raw || typeof raw !== 'object') {
    throw new Error('operation must be the object returned by a fatsecret_prepare_* tool.');
  }
  const op = raw as Record<string, unknown>;
  const unsigned = {
    capability: op.capability,
    methodId: op.methodId,
    user: op.user,
    params: op.params,
    reason: op.reason,
    preparedAt: op.preparedAt,
    expiresAt: op.expiresAt,
  };
  const operationHash = typeof op.operationHash === 'string' ? op.operationHash : '';
  const expected = Buffer.from(sign(unsigned), 'hex');
  const given = Buffer.from(operationHash, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error('Prepared operation signature does not match; it was altered or prepared by another server. Prepare it again.');
  }
  if (context.confirmOperationHash !== operationHash) {
    throw new Error('confirmOperationHash does not match the operation.');
  }
  const expiresAt = Date.parse(String(op.expiresAt));
  if (!Number.isFinite(expiresAt) || (context.now ?? new Date()).getTime() > expiresAt) {
    throw new Error('Prepared operation has expired (15 minutes); prepare it again.');
  }
  if (op.user !== context.user) {
    throw new Error('This prepared operation was created for a different identity.');
  }

  const methodId = String(op.methodId);
  const capability = String(op.capability);
  const policyDecision = checkPolicy({ capability, methodId, isMutation: isMutationMethod(methodId) });
  if (!policyDecision.allowed) {
    throw new Error(`Operation not allowed by policy: ${policyDecision.reason}`);
  }

  return {
    capability,
    methodId,
    user: String(op.user),
    params: op.params as PreparedOperation['params'],
    dryRun: true,
    reason: String(op.reason),
    preparedAt: String(op.preparedAt),
    expiresAt: String(op.expiresAt),
    operationHash,
    policyDecision,
  };
}

function sign(value: unknown): string {
  return createHmac('sha256', secret()).update(stableStringify(value)).digest('hex');
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
