/**
 * Admin password and login sessions.
 *
 * The password is stored as a scrypt hash in auth.json next to the settings.
 * A fresh install starts with the password "admin" and must change it on first
 * login. Deleting auth.json resets it to "admin".
 *
 * Sessions are signed cookies holding the password version and an expiry, so
 * they survive restarts, and changing the password signs out every session.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readJson, writeJson } from './store.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const DEFAULT_PASSWORD = 'admin';
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_COOKIE = 'pv_session';
export const SESSION_TTL_MS = 30 * 86400_000;

interface AuthData {
  salt: string; // base64
  hash: string; // base64
  mustChange: boolean;
  version: number; // bumped on each password change; invalidates older sessions
  secret: string; // base64, signs session cookies
}

async function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password, salt, 64);
}

export class AuthStore {
  private data!: AuthData;
  private file?: string;

  constructor(file?: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    const raw = this.file ? ((await readJson(this.file)) as AuthData | undefined) : undefined;
    if (raw?.hash && raw.salt && raw.secret) {
      this.data = raw;
      return;
    }
    this.data = { salt: '', hash: '', mustChange: true, version: 0, secret: randomBytes(32).toString('base64') };
    await this.storePassword(DEFAULT_PASSWORD, true);
  }

  get mustChange(): boolean {
    return this.data.mustChange;
  }

  get version(): number {
    return this.data.version;
  }

  get secret(): string {
    return this.data.secret;
  }

  async verify(password: string): Promise<boolean> {
    const expected = Buffer.from(this.data.hash, 'base64');
    const actual = await hashPassword(password, Buffer.from(this.data.salt, 'base64'));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Returns an error message if the new password isn't acceptable. */
  async checkNewPassword(next: string): Promise<string | null> {
    if (next.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (next === DEFAULT_PASSWORD || (await this.verify(next))) {
      return 'Choose a password different from the current one';
    }
    return null;
  }

  async setPassword(next: string): Promise<void> {
    await this.storePassword(next, false);
  }

  private async storePassword(password: string, mustChange: boolean): Promise<void> {
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt);
    this.data = {
      ...this.data,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      mustChange,
      version: this.data.version + 1,
    };
    if (this.file) {
      await writeJson(this.file, this.data);
    }
  }
}

/** Cookie value: "<password version>.<expiry ms>". The cookie itself is signed. */
export function sessionValue(version: number, now = Date.now()): string {
  return `${version}.${now + SESSION_TTL_MS}`;
}

export function sessionValid(value: string | false | undefined, version: number, now = Date.now()): boolean {
  if (!value) {
    return false;
  }
  const [v, expires] = value.split('.').map(Number);
  return v === version && expires !== undefined && expires > now;
}

/**
 * Slows down password guessing: after 5 failures from one address, each further
 * failure locks that address out for twice as long, up to 15 minutes.
 */
export class LoginLimiter {
  private failures = new Map<string, { count: number; lockedUntil: number }>();

  lockedFor(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    return entry ? Math.max(0, entry.lockedUntil - now) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 5) {
      entry.lockedUntil = now + Math.min(15 * 60_000, 1000 * 2 ** (entry.count - 5) * 30);
    }
    this.failures.set(key, entry);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
