import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/fatsecret/token-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fatsecret-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  return new TokenStore({ path: join(dir, 'store.json'), encryptionKey: 'test-encryption-key-1234567890' });
}

function tokens(authMode: 'three_legged' | 'profile_create' = 'three_legged') {
  return { oauthToken: 'plaintext-access-token-xyz', oauthTokenSecret: 'plaintext-secret-value-xyz', authMode, connectedAt: Date.now() };
}

describe('TokenStore', () => {
  it('encrypts at rest and round-trips per user, keyed case-insensitively', () => {
    const s = store();
    s.setTokens('Alice@Example.com', tokens());
    expect(s.getTokens('alice@example.com')?.oauthToken).toBe('plaintext-access-token-xyz');
    const raw = readFileSync(join(dir, 'store.json'), 'utf8');
    expect(raw).not.toContain('plaintext-access-token-xyz');
    expect(raw).not.toContain('plaintext-secret-value-xyz');
    expect(raw).toContain('iv');
  });

  it('isolates rows per user — one user cannot read another\'s tokens', () => {
    const s = store();
    s.setTokens('alice@x.dk', { ...tokens(), oauthToken: 'alice-tok' });
    s.setTokens('bob@x.dk', { ...tokens(), oauthToken: 'bob-tok' });
    expect(s.getTokens('alice@x.dk')?.oauthToken).toBe('alice-tok');
    expect(s.getTokens('bob@x.dk')?.oauthToken).toBe('bob-tok');
  });

  it('rejects a weak encryption key', () => {
    expect(() => new TokenStore({ path: join(dir, 's.json'), encryptionKey: 'short' })).toThrow('FATSECRET_ENCRYPTION_KEY');
  });

  it('fails closed when the store file is tampered with (bad auth tag)', () => {
    const s = store();
    s.setTokens('u@x.dk', tokens());
    const raw = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
    const key = Object.keys(raw.tokens)[0]!;
    // Flip a character in the ciphertext.
    raw.tokens[key].data = raw.tokens[key].data.slice(0, -2) + (raw.tokens[key].data.slice(-2) === 'AA' ? 'BB' : 'AA');
    writeFileSync(join(dir, 'store.json'), JSON.stringify(raw));
    const reloaded = store();
    expect(() => reloaded.getTokens('u@x.dk')).toThrow();
  });

  it('missing store file returns undefined rather than throwing', () => {
    const s = store();
    expect(s.getTokens('nobody@x.dk')).toBeUndefined();
  });

  it('persists across instances', () => {
    store().setTokens('u@x.dk', tokens());
    expect(store().getTokens('u@x.dk')?.oauthToken).toBe('plaintext-access-token-xyz');
  });

  it('deleteTokens reports whether a row existed', () => {
    const s = store();
    expect(s.deleteTokens('nobody@x.dk')).toBe(false);
    s.setTokens('u@x.dk', tokens());
    expect(s.deleteTokens('u@x.dk')).toBe(true);
    expect(s.getTokens('u@x.dk')).toBeUndefined();
  });

  it('auth request state is single-use and bound to a user', () => {
    const s = store();
    s.createAuthState('me@x.dk', 'req-token', 'req-secret');
    const consumed = s.consumeAuthState('me@x.dk');
    expect(consumed?.requestToken).toBe('req-token');
    expect(s.consumeAuthState('me@x.dk')).toBeUndefined(); // consumed
    expect(s.consumeAuthState('nobody@x.dk')).toBeUndefined();
  });
});
