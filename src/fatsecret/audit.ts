import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface FatSecretAuditEvent {
  requestId?: string;
  actingAs?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
}

/**
 * No-op unless FATSECRET_AUDIT_LOG is set. Records only a hash of the target
 * payload (never raw food/weight/exercise contents) — food, weight, and
 * exercise diary data is personal health-adjacent information, so the audit
 * trail deliberately stays metadata-only, same as who/what/when/outcome
 * rather than the data itself.
 */
export async function writeAuditEvent(event: FatSecretAuditEvent): Promise<void> {
  const auditPath = process.env.FATSECRET_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    actingAs: event.actingAs,
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
