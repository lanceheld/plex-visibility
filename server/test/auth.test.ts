import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthStore, LoginLimiter, SESSION_TTL_MS, sessionValid, sessionValue } from '../src/auth.ts';

describe('AuthStore', () => {
  it('starts without a PIN, stores only a hash, and persists a set PIN', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'pv-auth-')), 'auth.json');
    const auth = new AuthStore(file);
    await auth.load();
    expect(auth.pinSet).toBe(false);
    expect(await auth.verify('')).toBe(false);
    expect(await auth.verify('123456')).toBe(false);

    await expect(auth.setPin('12345')).rejects.toThrow('6 digits');
    await expect(auth.setPin('12345a')).rejects.toThrow('6 digits');
    await auth.setPin('482913');
    const stored = await readFile(file, 'utf8');
    expect(stored).not.toContain('482913');

    const reloaded = new AuthStore(file);
    await reloaded.load();
    expect(reloaded.pinSet).toBe(true);
    expect(await reloaded.verify('482913')).toBe(true);
    expect(await reloaded.verify('482914')).toBe(false);
    expect(reloaded.version).toBe(auth.version);
    expect(reloaded.secret).toBe(auth.secret);

    // Removing the PIN ends sessions too.
    const before = reloaded.version;
    await reloaded.setPin(null);
    expect(reloaded.pinSet).toBe(false);
    expect(reloaded.version).toBe(before + 1);

    // Deleting the file removes the PIN.
    await auth.setPin('482913');
    await rm(file);
    const reset = new AuthStore(file);
    await reset.load();
    expect(reset.pinSet).toBe(false);
  });
});

describe('sessions', () => {
  it('are valid for the current PIN version until they expire', () => {
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

  it('takes a custom threshold', () => {
    const limiter = new LoginLimiter(20);
    for (let i = 0; i < 19; i++) {
      limiter.fail('*', 0);
    }
    expect(limiter.lockedFor('*', 0)).toBe(0);
    limiter.fail('*', 0);
    expect(limiter.lockedFor('*', 0)).toBe(30_000);
  });
});
