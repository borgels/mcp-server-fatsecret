import { readFileSync } from 'node:fs';

export interface FatSecretPolicy {
  writesEnabled: boolean;
  /**
   * Gates the `profile.create` fallback auth path (an account-less, no-consent
   * FatSecret profile useful for local dev/smoke-testing). The primary,
   * recommended auth path (real 3-legged OAuth1) is not gated by this flag.
   */
  profileCreateEnabled: boolean;
  allowedCapabilities: string[];
  deniedMethodPatterns: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policy: FatSecretPolicy;
}

export interface PolicyCheckInput {
  capability: string;
  methodId: string;
  isMutation: boolean;
}

export function loadPolicy(): FatSecretPolicy {
  const base: FatSecretPolicy = {
    writesEnabled: process.env.FATSECRET_ENABLE_WRITES === 'true',
    profileCreateEnabled: process.env.FATSECRET_ENABLE_PROFILE_CREATE === 'true',
    allowedCapabilities: [],
    deniedMethodPatterns: [],
  };

  const policyPath = process.env.FATSECRET_POLICY_PATH;
  if (!policyPath) {
    return base;
  }

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as Partial<FatSecretPolicy>;
  return {
    ...base,
    ...parsed,
    writesEnabled: parsed.writesEnabled ?? base.writesEnabled,
    profileCreateEnabled: parsed.profileCreateEnabled ?? base.profileCreateEnabled,
    allowedCapabilities: parsed.allowedCapabilities ?? base.allowedCapabilities,
    deniedMethodPatterns: parsed.deniedMethodPatterns ?? base.deniedMethodPatterns,
  };
}

export function checkPolicy(input: PolicyCheckInput, policy = loadPolicy()): PolicyDecision {
  if (!input.isMutation) {
    return { allowed: true, reason: 'read operation', policy };
  }

  if (!policy.writesEnabled) {
    return { allowed: false, reason: 'writes disabled', policy };
  }

  if (input.methodId === 'profile.create' && !policy.profileCreateEnabled) {
    return { allowed: false, reason: 'profile.create disabled (FATSECRET_ENABLE_PROFILE_CREATE)', policy };
  }

  if (policy.allowedCapabilities.length > 0 && !policy.allowedCapabilities.includes(input.capability)) {
    return { allowed: false, reason: `capability not allowed: ${input.capability}`, policy };
  }

  if (policy.deniedMethodPatterns.some(pattern => new RegExp(pattern, 'i').test(input.methodId))) {
    return { allowed: false, reason: `method denied by policy: ${input.methodId}`, policy };
  }

  return { allowed: true, reason: 'matched write policy', policy };
}

/**
 * Per-user isolation: every data/auth tool needs the gateway-verified
 * identity. Without it the server refuses — nobody gets anonymous or shared
 * access to anyone's food, weight, or exercise diary.
 */
export function requireUser(onBehalfOf: string | undefined): string {
  if (!onBehalfOf) {
    throw new Error(
      'No verified user identity. This connector only works behind a gateway that forwards the signed-in user (X-MCP-User); each user sees only their own FatSecret data.',
    );
  }
  return onBehalfOf;
}
