import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthStore, LoginLimiter, SESSION_TTL_MS, sessionValid, sessionValue } from '../src/auth.ts';

describe('AuthStore', () => {
  it('starts as "admin", stores only a hash, and persists a changed password', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'pv-auth-')), 'auth.json');
    const auth = new AuthStore(file);
    await auth.load();
    expect(auth.mustChange).toBe(true);
    expect(await auth.verify('admin')).toBe(true);
    expect(await auth.verify('Admin')).toBe(false);

    await auth.setPassword('a much better one');
    const stored = await readFile(file, 'utf8');
    expect(stored).not.toContain('a much better one');

    const reloaded = new AuthStore(file);
    await reloaded.load();
    expect(reloaded.mustChange).toBe(false);
    expect(await reloaded.verify('a much better one')).toBe(true);
    expect(reloaded.version).toBe(auth.version);
    expect(reloaded.secret).toBe(auth.secret);

    // Deleting the file resets to the default.
    await rm(file);
    const reset = new AuthStore(file);
    await reset.load();
    expect(await reset.verify('admin')).toBe(true);
    expect(reset.mustChange).toBe(true);
  });
});

describe('sessions', () => {
  it('are valid for the current password version until they expire', () => {
    const now = 1_000_000;
    const value = sessionValue(3, now);
    expect(sessionValid(value, 3, now + 1000)).toBe(true);
    expect(sessionValid(value, 4, now + 1000)).toBe(false);
    expect(sessionValid(value, 3, now + SESSION_TTL_MS + 1)).toBe(false);
    expect(sessionValid(false, 3, now)).toBe(false);
    expect(sessionValid('garbage', 3, now)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('locks out after 5 failures, backing off, and clears on success', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 4; i++) {
      limiter.fail('ip', 0);
    }
    expect(limiter.lockedFor('ip', 0)).toBe(0);
    limiter.fail('ip', 0);
    expect(limiter.lockedFor('ip', 0)).toBe(30_000);
    limiter.fail('ip', 0);
    expect(limiter.lockedFor('ip', 0)).toBe(60_000);
    expect(limiter.lockedFor('other', 0)).toBe(0);
    limiter.succeed('ip');
    expect(limiter.lockedFor('ip', 0)).toBe(0);
  });
});
