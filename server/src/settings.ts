import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, writeJson } from "./store.ts";
import type { PublicSettings, Settings, SettingsUpdate } from "./types.ts";

const httpUrl = z
  .string()
  .trim()
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "Must be an http:// or https:// URL")
  .transform((v) => v.replace(/\/+$/, ""));

const targetSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().max(80),
  url: z.string().trim().min(3).regex(/^[a-z][a-z0-9+.-]*:\/\//i, "Must be an Apprise URL like mailtos://…"),
  enabled: z.boolean(),
});

export const settingsSchema = z.object({
  clientId: z.string().min(1),
  plex: z.object({ url: httpUrl, token: z.string().trim(), serverName: z.string().trim() }),
  monitor: z.object({
    checkInterval: z.number().int().min(15).max(3600),
    failThreshold: z.number().int().min(1).max(60),
    remindInterval: z.number().int().min(0).max(7 * 86400),
  }),
  notifications: z.object({ targets: z.array(targetSchema).max(50), notifyOnRecovery: z.boolean() }),
  heartbeatUrl: httpUrl,
});

export function defaultSettings(): Settings {
  return {
    clientId: randomUUID(),
    plex: { url: "", token: "", serverName: "" },
    monitor: { checkInterval: 60, failThreshold: 3, remindInterval: 6 * 3600 },
    notifications: { targets: [], notifyOnRecovery: true },
    heartbeatUrl: "",
  };
}

/** Optional env vars pre-fill the very first config, for headless setups. */
export function seedFromEnv(env: NodeJS.ProcessEnv, base: Settings): Settings {
  const s = structuredClone(base);
  if (env.PLEX_URL) s.plex.url = env.PLEX_URL.trim().replace(/\/+$/, "");
  if (env.PLEX_TOKEN) s.plex.token = env.PLEX_TOKEN.trim();
  if (env.HEARTBEAT_URL) s.heartbeatUrl = env.HEARTBEAT_URL.trim();
  if (env.NOTIFY_URLS) {
    s.notifications.targets = env.NOTIFY_URLS.split(/\s+/)
      .filter(Boolean)
      .map((url) => ({ id: randomUUID(), label: url.split("://")[0]!, url, enabled: true }));
  }
  return s;
}

export function toPublic(s: Settings): PublicSettings {
  const { clientId: _, plex, ...rest } = s;
  return { ...rest, plex: { url: plex.url, serverName: plex.serverName, hasToken: plex.token !== "" } };
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
    const raw = await readJson(this.file);
    if (raw === undefined) {
      this.current = settingsSchema.parse(seedFromEnv(env, defaultSettings()));
      await writeJson(this.file, this.current);
    } else {
      // Fill in fields added in newer versions.
      const d = defaultSettings();
      const r = raw as Partial<Settings>;
      this.current = settingsSchema.parse({
        ...d,
        ...r,
        plex: { ...d.plex, ...r.plex },
        monitor: { ...d.monitor, ...r.monitor },
        notifications: { ...d.notifications, ...r.notifications },
      });
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(update: SettingsUpdate): Promise<Settings> {
    this.current = applyUpdate(this.current, update);
    await writeJson(this.file, this.current);
    for (const fn of this.listeners) fn(this.current);
    return this.current;
  }

  onChange(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }
}
