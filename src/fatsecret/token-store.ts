import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-user encrypted OAuth1 token store + one-time auth-request state.
 *
 * Every user's FatSecret token pair is encrypted at rest with AES-256-GCM
 * using a key derived from FATSECRET_ENCRYPTION_KEY, and keyed by the
 * gateway-verified user identity (X-MCP-User) — a user can only ever reach
 * their own row. Persisted to a JSON file on a Docker volume so it survives
 * container restarts. Structurally identical to mcp-server-withings'
 * TokenStore, since both solve the same "N people, one shared service, each
 * with their own linked account" problem.
 */

export interface UserTokens {
  oauthToken: string;
  oauthTokenSecret: string;
  fatsecretUserId?: string;
  authMode: 'three_legged' | 'profile_create';
  connectedAt: number;
}

interface AuthRequestState {
  requestToken: string;
  requestTokenSecret: string;
  createdAt: number;
}

interface Encrypted {
  iv: string;
  tag: string;
  data: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export class TokenStore {
  private readonly path: string;
  private readonly key: Buffer;
  private tokens: Record<string, Encrypted> = {};
  private states: Record<string, Encrypted> = {};

  constructor(options: { path?: string; encryptionKey?: string } = {}) {
    this.path = options.path ?? process.env.FATSECRET_STORE_PATH ?? '/data/store.json';
    const secret = options.encryptionKey ?? process.env.FATSECRET_ENCRYPTION_KEY;
    if (!secret || secret.length < 16) {
      throw new Error('Missing/weak FATSECRET_ENCRYPTION_KEY (min 16 chars) — required to encrypt tokens at rest.');
    }
    this.key = createHash('sha256').update(secret).digest();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        tokens?: Record<string, Encrypted>;
        states?: Record<string, Encrypted>;
      };
      this.tokens = raw.tokens ?? {};
      this.states = raw.states ?? {};
    } catch {
      this.tokens = {};
      this.states = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.store.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ tokens: this.tokens, states: this.states }), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace
  }

  private encrypt(value: unknown): Encrypted {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt<T>(enc: Encrypted): T {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8')) as T;
  }

  /** userKey normalizes the verified identity (lowercased email/oid). */
  static userKey(identity: string): string {
    return identity.trim().toLowerCase();
  }

  getTokens(user: string): UserTokens | undefined {
    const enc = this.tokens[TokenStore.userKey(user)];
    return enc ? this.decrypt<UserTokens>(enc) : undefined;
  }

  setTokens(user: string, tokens: UserTokens): void {
    this.tokens[TokenStore.userKey(user)] = this.encrypt(tokens);
    this.persist();
  }

  deleteTokens(user: string): boolean {
    const key = TokenStore.userKey(user);
    if (!this.tokens[key]) {
      return false;
    }
    delete this.tokens[key];
    this.persist();
    return true;
  }

  // --- one-time auth-request state (binds the pending OOB request token to a
  // user, so fatsecret_complete_auth(verifier) — which only ever sees the PIN
  // the user pastes back, not the request token itself — knows which request
  // token to exchange). Keyed by user: only one auth attempt may be in flight
  // per person at a time; starting a new one supersedes an old one. ---

  createAuthState(user: string, requestToken: string, requestTokenSecret: string): void {
    this.gcStates();
    this.states[TokenStore.userKey(user)] = this.encrypt({
      requestToken,
      requestTokenSecret,
      createdAt: Date.now(),
    } satisfies AuthRequestState);
    this.persist();
  }

  consumeAuthState(user: string): AuthRequestState | undefined {
    this.gcStates();
    const key = TokenStore.userKey(user);
    const enc = this.states[key];
    if (!enc) {
      return undefined;
    }
    delete this.states[key];
    this.persist();
    const entry = this.decrypt<AuthRequestState>(enc);
    return Date.now() - entry.createdAt <= STATE_TTL_MS ? entry : undefined;
  }

  private gcStates(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, enc] of Object.entries(this.states)) {
      const entry = this.decrypt<AuthRequestState>(enc);
      if (now - entry.createdAt > STATE_TTL_MS) {
        delete this.states[key];
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}
