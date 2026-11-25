/**
 * Optional settings PIN and login sessions.
 *
 * Like Plex Media Server's own PIN, it's off on a fresh install: Settings are
 * open to anyone who can reach the UI until a PIN is set. Once set, it's stored
 * as a scrypt hash in auth.json next to the settings. Deleting auth.json, or
 * signing in with Plex as the server owner, removes it.
 *
 * Sessions are signed cookies holding the PIN version and an expiry, so they
 * survive restarts, and setting, changing or removing the PIN signs out every
 * session.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readJson, writeJson } from './store.ts';

const scrypt = promisify(scryptCb) as (pin: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const PIN_LENGTH = 6;
export const PIN_PATTERN = new RegExp(`^\\d{${PIN_LENGTH}}$`);
export const SESSION_COOKIE = 'pv_session';
export const SESSION_TTL_MS = 30 * 86400_000;

interface AuthData {
  pin: { salt: string; hash: string } | null; // base64
  version: number; // bumped on each PIN change; invalidates older sessions
  secret: string; // base64, signs session cookies
}

async function hashPin(pin: string, salt: Buffer): Promise<Buffer> {
  return scrypt(pin, salt, 64);
}

export class AuthStore {
  private data!: AuthData;
  private file?: string;

  constructor(file?: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    const raw = this.file ? ((await readJson(this.file)) as Partial<AuthData> | undefined) : undefined;
    this.data = {
      pin: raw?.pin?.salt && raw.pin.hash ? raw.pin : null,
      version: typeof raw?.version === 'number' ? raw.version : 0,
      secret: raw?.secret || randomBytes(32).toString('base64'),
    };
    if (!raw?.secret) {
      await this.save();
    }
  }

  get pinSet(): boolean {
    return this.data.pin !== null;
  }

  get version(): number {
    return this.data.version;
  }

  get secret(): string {
    return this.data.secret;
  }

  /** Whether `pin` matches. Always false when no PIN is set. */
  async verify(pin: string): Promise<boolean> {
    if (!this.data.pin || !PIN_PATTERN.test(pin)) {
      return false;
    }
    const expected = Buffer.from(this.data.pin.hash, 'base64');
    const actual = await hashPin(pin, Buffer.from(this.data.pin.salt, 'base64'));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Set a new PIN, or remove it with null. Either way, existing sessions end. */
  async setPin(pin: string | null): Promise<void> {
    if (pin !== null && !PIN_PATTERN.test(pin)) {
      throw new Error(`The PIN must be ${PIN_LENGTH} digits`);
    }
    let stored: AuthData['pin'] = null;
    if (pin !== null) {
      const salt = randomBytes(16);
      stored = { salt: salt.toString('base64'), hash: (await hashPin(pin, salt)).toString('base64') };
    }
    this.data = { ...this.data, pin: stored, version: this.data.version + 1 };
    await this.save();
  }

  private async save(): Promise<void> {
    if (this.file) {
      await writeJson(this.file, this.data);
    }
  }
}

/** Cookie value: "<PIN version>.<expiry ms>". The cookie itself is signed. */
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
 * Slows down PIN guessing: after `threshold` failures for one key, each further
 * failure locks that key out for twice as long, starting at 30 seconds, up to
 * 15 minutes.
 */
export class LoginLimiter {
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  private threshold: number;

  constructor(threshold = 5) {
    this.threshold = threshold;
  }

  lockedFor(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    return entry ? Math.max(0, entry.lockedUntil - now) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.threshold) {
      entry.lockedUntil = now + Math.min(15 * 60_000, 1000 * 2 ** (entry.count - this.threshold) * 30);
    }
    this.failures.set(key, entry);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
