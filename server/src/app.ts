import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppriseClient } from "./notify.ts";
import { fetchStatus } from "./plex.ts";
import type { PlexAuth } from "./plexAuth.ts";
import type { MonitorService } from "./service.ts";
import { type SettingsStore, settingsSchema, toPublic } from "./settings.ts";
import type { NotifyTarget, PublicSettings, Settings } from "./types.ts";

export interface AppDeps {
  settings: SettingsStore;
  service: MonitorService;
  apprise: AppriseClient;
  plexAuth: PlexAuth;
  password?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Hide secrets in Apprise URLs: the password in user:pass@, and any long path
 * or host token (webhook IDs, API keys, ntfy topics). Destinations are
 * write-only from the browser, so the full URL never needs to go back to it.
 */
export function maskUrl(url: string): string {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/)([^?#]*)/i);
  if (!m) return "••••";
  const [, scheme, rest] = m;
  const mask = (part: string) => (part.length > 8 ? `${part.slice(0, 3)}•••` : part);
  const [authority, ...pathParts] = rest!.split("/");
  let shownAuthority = authority!;
  const at = shownAuthority.lastIndexOf("@");
  if (at >= 0) {
    const [user, pass] = shownAuthority.slice(0, at).split(":");
    shownAuthority = `${user}${pass !== undefined ? ":•••" : ""}@${shownAuthority.slice(at + 1)}`;
  } else {
    shownAuthority = mask(shownAuthority);
  }
  return `${scheme}${[shownAuthority, ...pathParts.map(mask)].join("/")}`;
}

export function publicSettings(s: Settings): PublicSettings {
  const p = toPublic(s);
  // Build new objects: `p` shares nested objects with the live settings.
  return {
    ...p,
    notifications: { ...p.notifications, targets: p.notifications.targets.map((t) => ({ ...t, url: maskUrl(t.url) })) },
  };
}

const settingsUpdate = z
  .object({
    plex: settingsSchema.shape.plex.partial(),
    monitor: settingsSchema.shape.monitor.partial(),
    notifications: z.object({ notifyOnRecovery: z.boolean() }).partial(),
    heartbeatUrl: settingsSchema.shape.heartbeatUrl,
  })
  .partial()
  .strict();

const newTarget = z.object({
  label: z.string().trim().max(80).default(""),
  url: settingsSchema.shape.notifications.shape.targets.element.shape.url,
});

const targetPatch = z.object({ label: z.string().trim().max(80), enabled: z.boolean() }).partial().strict();

const testMessage = {
  title: "Plex Visibility test",
  body: "If you can read this, Plex remote access alerts will reach you here.",
} as const;

export function createApp(deps: AppDeps): Hono {
  const { settings, service, apprise, plexAuth } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ") }, 400);
    }
    console.error(err);
    return c.json({ error: err.message || "Internal error" }, 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  if (deps.password) {
    const expected = Buffer.from(deps.password);
    app.use(
      "*",
      basicAuth({
        verifyUser: (_user, pass) => {
          const given = Buffer.from(pass);
          return given.length === expected.length && timingSafeEqual(given, expected);
        },
        realm: "Plex Visibility",
      }),
    );
  }

  // Changes must be JSON, which a cross-site form can't send without a CORS preflight.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && !c.req.header("content-type")?.includes("application/json")) {
      return c.json({ error: "Expected a JSON request" }, 415);
    }
    await next();
  });

  const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) =>
    schema.parse(await c.req.json().catch(() => ({}))) as z.infer<T>;

  const targetById = (id: string): NotifyTarget => {
    const target = settings.get().notifications.targets.find((t) => t.id === id);
    if (!target) throw new HTTPException(404, { message: "No such destination" });
    return target;
  };

  const saveTargets = async (targets: NotifyTarget[]) => {
    const s = await settings.update({ notifications: { targets } });
    return publicSettings(s);
  };

  // --- status ---
  app.get("/api/status", (c) => c.json(service.snapshot()));
  app.post("/api/check", async (c) => {
    await service.checkNow();
    return c.json(service.snapshot());
  });

  // --- settings ---
  app.get("/api/settings", (c) => c.json(publicSettings(settings.get())));
  app.put("/api/settings", async (c) => {
    const update = await body(c, settingsUpdate);
    return c.json(publicSettings(await settings.update(update)));
  });

  // --- notification destinations ---
  app.get("/api/services", async (c) => c.json(await apprise.listServices()));

  app.post("/api/targets", async (c) => {
    const { label, url } = await body(c, newTarget);
    const target: NotifyTarget = { id: randomUUID(), label: label || url.split("://")[0]!, url, enabled: true };
    return c.json(await saveTargets([...settings.get().notifications.targets, target]));
  });

  app.patch("/api/targets/:id", async (c) => {
    const patch = await body(c, targetPatch);
    const target = targetById(c.req.param("id"));
    const targets = settings.get().notifications.targets.map((t) => (t.id === target.id ? { ...t, ...patch } : t));
    return c.json(await saveTargets(targets));
  });

  app.delete("/api/targets/:id", async (c) => {
    const target = targetById(c.req.param("id"));
    return c.json(await saveTargets(settings.get().notifications.targets.filter((t) => t.id !== target.id)));
  });

  app.post("/api/targets/:id/test", async (c) => {
    const target = targetById(c.req.param("id"));
    const [result] = await apprise.notifyAll([target], testMessage.title, testMessage.body, "info");
    return c.json(result);
  });

  // Test a URL before saving it.
  app.post("/api/targets/test", async (c) => {
    const { url } = await body(c, newTarget.pick({ url: true }));
    return c.json(await apprise.notifyOne(url, testMessage.title, testMessage.body, "info"));
  });

  // --- Plex connection ---
  app.post("/api/plex/test", async (c) => {
    const given = await body(c, z.object({ url: z.string().optional(), token: z.string().optional() }));
    const s = settings.get();
    const status = await fetchStatus({
      url: given.url?.trim() || s.plex.url,
      token: given.token?.trim() || s.plex.token,
      clientId: s.clientId,
      fetchImpl: deps.fetchImpl,
    });
    return c.json(status);
  });

  app.post("/api/plex/pin", async (c) => c.json(await plexAuth.createPin()));

  app.get("/api/plex/pin/:id", async (c) => c.json(await plexAuth.checkPin(Number(c.req.param("id")))));

  app.post("/api/plex/pin/:id/select", async (c) => {
    const pinId = Number(c.req.param("id"));
    const { serverId, uri, name } = await body(
      c,
      z.object({ serverId: z.string(), uri: z.string().url(), name: z.string().default("") }),
    );
    const token = plexAuth.serverToken(pinId, serverId);
    if (!token) throw new HTTPException(410, { message: "Sign-in expired. Please sign in with Plex again." });
    const s = await settings.update({ plex: { url: uri, token, serverName: name } });
    plexAuth.finish(pinId);
    return c.json(publicSettings(s));
  });

  return app;
}
