import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJson } from './store.ts';
import type { ConfigExport, PublicSettings, Settings, SettingsUpdate } from './types.ts';

const httpUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Must be an http:// or https:// URL')
  .transform((v) => v.replace(/\/+$/, ''));

const targetSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().max(80),
  url: z
    .string()
    .trim()
    .min(3)
    .regex(/^[a-z][a-z0-9+.-]*:\/\//i, 'Must be an Apprise URL like mailtos://…'),
  enabled: z.boolean(),
});

export const settingsSchema = z.object({
  clientId: z.string().min(1),
  plex: z.object({ url: httpUrl, token: z.string().trim(), serverName: z.string().trim() }),
  monitor: z.object({
    checkInterval: z.number().int().min(15).max(3600),
    failThreshold: z.number().int().min(1).max(60),
    remindInterval: z
      .number()
      .int()
      .min(0)
      .max(7 * 86400),
  }),
  notifications: z.object({ targets: z.array(targetSchema).max(50), notifyOnRecovery: z.boolean() }),
  heartbeatUrl: httpUrl,
});

export function defaultSettings(): Settings {
  return {
    clientId: randomUUID(),
    plex: { url: '', token: '', serverName: '' },
    monitor: { checkInterval: 60, failThreshold: 3, remindInterval: 6 * 3600 },
    notifications: { targets: [], notifyOnRecovery: true },
    heartbeatUrl: '',
  };
}

/** Optional env vars pre-fill the very first config, for headless setups. */
export function seedFromEnv(env: NodeJS.ProcessEnv, base: Settings): Settings {
  const s = structuredClone(base);
  if (env.PLEX_URL) {
    s.plex.url = env.PLEX_URL.trim().replace(/\/+$/, '');
  }
  if (env.PLEX_TOKEN) {
    s.plex.token = env.PLEX_TOKEN.trim();
  }
  if (env.HEARTBEAT_URL) {
    s.heartbeatUrl = env.HEARTBEAT_URL.trim();
  }
  if (env.NOTIFY_URLS) {
    s.notifications.targets = env.NOTIFY_URLS.split(/\s+/)
      .filter(Boolean)
      .map((url) => ({ id: randomUUID(), label: url.split('://')[0]!, url, enabled: true }));
  }
  return s;
}

export function toPublic(s: Settings): PublicSettings {
  const { clientId: _, plex, ...rest } = s;
  return { ...rest, plex: { url: plex.url, serverName: plex.serverName, hasToken: plex.token !== '' } };
}

/**
 * Version of the settings format, in settings.json and in exported backups.
 * Bump it only when a change can't be handled by defaults alone (a field is
 * renamed, removed, or changes meaning), and add a migration below.
 * Adding a new field with a default doesn't need a bump.
 */
export const SCHEMA_VERSION = 1;

type RawSettings = Record<string, unknown>;

/** MIGRATIONS[n] turns version-n settings into version n+1. */
export type Migrations = Record<number, (s: RawSettings) => RawSettings>;
const MIGRATIONS: Migrations = {};

export class SettingsVersionError extends Error {}

/** Bring raw settings from `from` up to `to`, refusing anything newer than this server understands. */
export function migrate(raw: RawSettings, from: number, migrations: Migrations = MIGRATIONS, to = SCHEMA_VERSION) {
  if (!Number.isInteger(from) || from < 1) {
    throw new SettingsVersionError(`Unknown settings format version: ${String(from)}`);
  }
  if (from > to) {
    throw new SettingsVersionError(
      `These settings are from a newer version of Plex Visibility (format ${from}; this server understands up to ${to}). Update Plex Visibility first.`,
    );
  }
  let result = raw;
  for (let v = from; v < to; v++) {
    const step = migrations[v];
    if (!step) {
      throw new SettingsVersionError(`No migration from settings format ${v} to ${v + 1}`);
    }
    result = step(result);
  }
  return result;
}

/**
 * Complete, validated settings from current-format raw data. Missing fields get
 * defaults, destinations without an id get one, and unknown fields are dropped.
 */
function fromRaw(r: Partial<Settings>, clientId?: string): Settings {
  const d = defaultSettings();
  // Possibly untrusted contents: fill in what's missing; settingsSchema validates the rest.
  const rawTargets: unknown = r.notifications?.targets;
  const targets = Array.isArray(rawTargets)
    ? rawTargets.map((t: Record<string, unknown>) => ({ enabled: true, label: '', ...t, id: t?.id || randomUUID() }))
    : d.notifications.targets;
  return settingsSchema.parse({
    ...d,
    ...r,
    clientId: clientId ?? r.clientId ?? d.clientId,
    plex: { ...d.plex, ...r.plex },
    monitor: { ...d.monitor, ...r.monitor },
    notifications: { ...d.notifications, ...r.notifications, targets },
  });
}

export function exportConfig(s: Settings, version: string, now = new Date()): ConfigExport {
  const { clientId: _, ...settings } = structuredClone(s);
  return { app: 'plex-visibility', schemaVersion: SCHEMA_VERSION, version, exportedAt: now.toISOString(), settings };
}

const importSchema = z.object({
  app: z.literal('plex-visibility', { error: 'Not a Plex Visibility configuration file' }),
  // Exports made before schemaVersion existed are format 1.
  schemaVersion: z.unknown().optional(),
  settings: z.record(z.string(), z.unknown()),
});

/**
 * Turn an uploaded export into complete settings: migrate it from its format
 * version, fill in defaults, and keep this install's own plex.tv client ID.
 */
export function parseImport(raw: unknown, current: Settings, migrations: Migrations = MIGRATIONS): Settings {
  const file = importSchema.parse(raw);
  const from = file.schemaVersion === undefined ? 1 : Number(file.schemaVersion);
  return fromRaw(migrate(file.settings, from, migrations) as Partial<Settings>, current.clientId);
}

export function applyUpdate(current: Settings, update: SettingsUpdate): Settings {
  const next: Settings = {
    ...current,
    plex: { ...current.plex, ...update.plex },
    monitor: { ...current.monitor, ...update.monitor },
    notifications: { ...current.notifications, ...update.notifications },
    heartbeatUrl: update.heartbeatUrl ?? current.heartbeatUrl,
  };
  return settingsSchema.parse(next);
}

export class SettingsStore {
  private current!: Settings;
  private listeners: ((s: Settings) => void)[] = [];

  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
    const raw = (await readJson(this.file)) as RawSettings | undefined;
    if (raw === undefined) {
      this.current = settingsSchema.parse(seedFromEnv(env, defaultSettings()));
      await this.save();
      return this.current;
    }
    // Files written before schemaVersion existed are format 1. A newer format
    // (after a downgrade) throws rather than being overwritten and losing data.
    const { schemaVersion = 1, ...stored } = raw;
    const from = Number(schemaVersion);
    this.current = fromRaw(migrate(stored, from) as Partial<Settings>);
    // Rewrite if it was migrated or predates schemaVersion.
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      await this.save();
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(update: SettingsUpdate): Promise<Settings> {
    this.current = applyUpdate(this.current, update);
    await this.save();
    for (const fn of this.listeners) {
      fn(this.current);
    }
    return this.current;
  }

  /** Replace everything, e.g. from an imported backup. */
  async replace(next: Settings): Promise<Settings> {
    this.current = settingsSchema.parse(next);
    await this.save();
    for (const fn of this.listeners) {
      fn(this.current);
    }
    return this.current;
  }

  private save(): Promise<void> {
    return writeJson(this.file, { schemaVersion: SCHEMA_VERSION, ...this.current });
  }

  onChange(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }
}
