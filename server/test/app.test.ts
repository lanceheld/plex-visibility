import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, maskUrl } from "../src/app.ts";
import { History } from "../src/history.ts";
import { AppriseClient } from "../src/notify.ts";
import { PlexAuth } from "../src/plexAuth.ts";
import { MonitorService } from "../src/service.ts";
import { SettingsStore } from "../src/settings.ts";
import type { PublicSettings } from "../src/types.ts";

describe("maskUrl", () => {
  it("hides passwords and long tokens", () => {
    expect(maskUrl("mailtos://me:hunter2@gmail.com?to=x@y.z")).toBe("mailtos://me:•••@gmail.com");
    expect(maskUrl("discord://123456789012/abcdefghijklmnop")).toBe("discord://123•••/abc•••");
    expect(maskUrl("ntfy://ntfy.sh/my-secret-topic")).toBe("ntfy://ntfy.sh/my-•••");
  });
});

async function setup(env: NodeJS.ProcessEnv = {}, password?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "pv-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  await settings.load(env);
  const sent: unknown[] = [];
  const appriseFetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const apprise = new AppriseClient("http://apprise", appriseFetch);
  const service = new MonitorService({ settings, history: new History(), apprise, log: () => {} });
  const app = createApp({ settings, service, apprise, plexAuth: new PlexAuth(() => "cid"), password });
  const json = (method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, json, settings, sent };
}

describe("API", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup({ PLEX_TOKEN: "secret-token", PLEX_URL: "http://plex:32400", NOTIFY_URLS: "mailtos://me:pw@x.com" });
  });

  it("seeds from env and never returns the Plex token or full destination URLs", async () => {
    const res = await ctx.app.request("/api/settings");
    const text = await res.text();
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain(":pw@");
    const s = JSON.parse(text) as PublicSettings;
    expect(s.plex).toEqual({ url: "http://plex:32400", serverName: "", hasToken: true });
    expect(s.notifications.targets).toHaveLength(1);
    // Masking for the browser must not touch the stored URL.
    expect(ctx.settings.get().notifications.targets[0]!.url).toBe("mailtos://me:pw@x.com");
  });

  it("adds, toggles, tests and removes destinations", async () => {
    let s = (await (await ctx.json("POST", "/api/targets", { label: "Phone", url: "ntfy://ntfy.sh/topic" })).json()) as PublicSettings;
    const phone = s.notifications.targets.find((t) => t.label === "Phone")!;
    s = (await (await ctx.json("PATCH", `/api/targets/${phone.id}`, { enabled: false })).json()) as PublicSettings;
    expect(s.notifications.targets.find((t) => t.id === phone.id)?.enabled).toBe(false);

    const test = await (await ctx.json("POST", `/api/targets/${phone.id}/test`, {})).json();
    expect(test).toMatchObject({ ok: true, label: "Phone" });
    expect(ctx.sent.at(-1)).toMatchObject({ urls: "ntfy://ntfy.sh/topic", type: "info" });

    s = (await (await ctx.json("DELETE", `/api/targets/${phone.id}`)).json()) as PublicSettings;
    expect(s.notifications.targets.some((t) => t.id === phone.id)).toBe(false);
  });

  it("validates settings", async () => {
    const bad = await ctx.json("PUT", "/api/settings", { monitor: { checkInterval: 1 } });
    expect(bad.status).toBe(400);
    const ok = await ctx.json("PUT", "/api/settings", { monitor: { checkInterval: 120 } });
    expect(((await ok.json()) as PublicSettings).monitor.checkInterval).toBe(120);
    expect(ctx.settings.get().plex.token).toBe("secret-token");
  });

  it("rejects non-JSON changes", async () => {
    const res = await ctx.app.request("/api/settings", { method: "PUT", body: "x", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
  });
});

describe("password", () => {
  it("requires it when set, except for the health check", async () => {
    const { app } = await setup({}, "letmein");
    expect((await app.request("/api/status")).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
    const auth = { authorization: `Basic ${Buffer.from("admin:letmein").toString("base64")}` };
    expect((await app.request("/api/status", { headers: auth })).status).toBe(200);
  });
});
