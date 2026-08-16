export interface FatSecretErrorPayload {
  error?: { code?: number; message?: string };
}

const SECRET_PATTERNS = [
  /authorization:\s*bearer\s+[^,\s}]+/gi,
  /oauth_signature=[^,&\s}]+/gi,
  /oauth_token_secret["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /(consumer_secret|oauth_token|FATSECRET_CONSUMER_SECRET|FATSECRET_ENCRYPTION_KEY)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class FatSecretHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: FatSecretErrorPayload | unknown;

  constructor(input: { status: number; url: string; payload?: FatSecretErrorPayload | unknown; fallbackMessage?: string }) {
    super(formatFatSecretHttpError(input));
    this.name = 'FatSecretHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
  );
}

function formatFatSecretHttpError(input: {
  status: number;
  url: string;
  payload?: FatSecretErrorPayload | unknown;
  fallbackMessage?: string;
}): string {
  const payload = isFatSecretErrorPayload(input.payload) ? input.payload : undefined;
  const parts = [
    `FatSecret API request failed with HTTP ${input.status}`,
    payload?.error?.code === undefined ? undefined : `code=${payload.error.code}`,
    payload?.error?.message,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isFatSecretErrorPayload(value: unknown): value is FatSecretErrorPayload {
  return typeof value === 'object' && value !== null;
}
