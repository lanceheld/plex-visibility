import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, maskUrl } from '../src/app.ts';
import { History } from '../src/history.ts';
import { AppriseClient } from '../src/notify.ts';
import { PlexAuth } from '../src/plexAuth.ts';
import { MonitorService } from '../src/service.ts';
import { SettingsStore } from '../src/settings.ts';
import type { PublicSettings, StatusResponse } from '../src/types.ts';

describe('maskUrl', () => {
  it('hides passwords and long tokens', () => {
    expect(maskUrl('mailtos://me:hunter2@gmail.com?to=x@y.z')).toBe('mailtos://me:•••@gmail.com');
    expect(maskUrl('discord://123456789012/abcdefghijklmnop')).toBe('discord://123•••/abc•••');
    expect(maskUrl('ntfy://ntfy.sh/my-secret-topic')).toBe('ntfy://ntfy.sh/my-•••');
  });
});

async function setup(env: NodeJS.ProcessEnv = {}, password?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pv-'));
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  await settings.load(env);
  const sent: unknown[] = [];
  // One fake network for apprise-api, plex.tv and the Plex server.
  const netFetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://apprise/details/') {
      return Response.json({ schemas: [{ service_name: 'ntfy', protocols: ['ntfy'] }] });
    }
    if (url.startsWith('http://apprise/')) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }
    if (url.startsWith('https://plex.tv/api/v2/pins?')) {
      return Response.json({ id: 9, code: 'c' });
    }
    if (url === 'https://plex.tv/api/v2/pins/9') {
      return Response.json({ authToken: 'acct' });
    }
    if (url.startsWith('https://clients.plex.tv/')) {
      return Response.json([
        {
          name: 'Home',
          clientIdentifier: 's1',
          provides: 'server',
          owned: true,
          accessToken: 'srv-tok',
          connections: [],
        },
      ]);
    }
    if (url.endsWith('/myplex/account')) {
      const token = (init?.headers as Record<string, string>)['X-Plex-Token'];
      return token === 'good'
        ? Response.json({ MyPlex: { signInState: 'ok', mappingState: 'mapped' } })
        : new Response('', { status: 401 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const apprise = new AppriseClient('http://apprise', netFetch);
  const service = new MonitorService({ settings, history: new History(), apprise, fetchImpl: netFetch, log: () => {} });
  const plexAuth = new PlexAuth(() => 'cid', netFetch);
  const app = createApp({ settings, service, apprise, plexAuth, password, fetchImpl: netFetch });
  const json = (method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, json, settings, sent };
}

describe('API', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup({
      PLEX_TOKEN: 'secret-token',
      PLEX_URL: 'http://plex:32400',
      NOTIFY_URLS: 'mailtos://me:pw@x.com',
    });
  });

  it('seeds from env and never returns the Plex token or full destination URLs', async () => {
    const res = await ctx.app.request('/api/settings');
    const text = await res.text();
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain(':pw@');
    const s = JSON.parse(text) as PublicSettings;
    expect(s.plex).toEqual({ url: 'http://plex:32400', serverName: '', hasToken: true });
    expect(s.notifications.targets).toHaveLength(1);
    // Masking for the browser must not touch the stored URL.
    expect(ctx.settings.get().notifications.targets[0]!.url).toBe('mailtos://me:pw@x.com');
  });

  it('adds, toggles, tests and removes destinations', async () => {
    let s = (await (
      await ctx.json('POST', '/api/targets', { label: 'Phone', url: 'ntfy://ntfy.sh/topic' })
    ).json()) as PublicSettings;
    const phone = s.notifications.targets.find((t) => t.label === 'Phone')!;
    s = (await (await ctx.json('PATCH', `/api/targets/${phone.id}`, { enabled: false })).json()) as PublicSettings;
    expect(s.notifications.targets.find((t) => t.id === phone.id)?.enabled).toBe(false);

    const test = await (await ctx.json('POST', `/api/targets/${phone.id}/test`, {})).json();
    expect(test).toMatchObject({ ok: true, label: 'Phone' });
    expect(ctx.sent.at(-1)).toMatchObject({ urls: 'ntfy://ntfy.sh/topic', type: 'info' });

    s = (await (await ctx.json('DELETE', `/api/targets/${phone.id}`)).json()) as PublicSettings;
    expect(s.notifications.targets.some((t) => t.id === phone.id)).toBe(false);
  });

  it('validates settings', async () => {
    const bad = await ctx.json('PUT', '/api/settings', { monitor: { checkInterval: 1 } });
    expect(bad.status).toBe(400);
    const ok = await ctx.json('PUT', '/api/settings', { monitor: { checkInterval: 120 } });
    expect(((await ok.json()) as PublicSettings).monitor.checkInterval).toBe(120);
    expect(ctx.settings.get().plex.token).toBe('secret-token');
  });

  it('rejects non-JSON changes', async () => {
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(415);
  });
});

describe('Plex routes', () => {
  it('tests a connection with given or saved credentials', async () => {
    const ctx = await setup({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'good' });
    expect(await (await ctx.json('POST', '/api/plex/test', {})).json()).toMatchObject({ state: 'ok' });
    expect(await (await ctx.json('POST', '/api/plex/test', { token: 'bad' })).json()).toMatchObject({
      state: 'auth_error',
    });
  });

  it('signs in with a PIN and saves the chosen server', async () => {
    const ctx = await setup();
    const pin = (await (await ctx.json('POST', '/api/plex/pin', {})).json()) as { id: number };
    expect(pin.id).toBe(9);
    const status = await (await ctx.app.request('/api/plex/pin/9')).json();
    expect(status).toMatchObject({ status: 'authorized', servers: [{ id: 's1', name: 'Home' }] });

    const uri = 'http://192.168.1.5:32400';
    const res = await ctx.json('POST', '/api/plex/pin/9/select', { serverId: 's1', uri, name: 'Home' });
    expect(((await res.json()) as PublicSettings).plex).toEqual({ url: uri, serverName: 'Home', hasToken: true });
    expect(ctx.settings.get().plex.token).toBe('srv-tok');

    // The PIN is used up.
    const again = await ctx.json('POST', '/api/plex/pin/9/select', { serverId: 's1', uri });
    expect(again.status).toBe(410);
  });

  it('runs a check and lists services', async () => {
    const ctx = await setup({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'good' });
    const status = (await (await ctx.json('POST', '/api/check', {})).json()) as StatusResponse;
    expect(status.current?.state).toBe('ok');
    expect(await (await ctx.app.request('/api/status')).json()).toMatchObject({ current: { state: 'ok' } });
    expect(await (await ctx.app.request('/api/services')).json()).toEqual([
      { name: 'ntfy', setupUrl: '', schemas: ['ntfy'], templates: [] },
    ]);
  });

  it('tests an unsaved URL and 404s unknown destinations', async () => {
    const ctx = await setup();
    expect(await (await ctx.json('POST', '/api/targets/test', { url: 'ntfy://x/y' })).json()).toEqual({ ok: true });
    expect((await ctx.json('POST', '/api/targets/test', { url: 'not a url' })).status).toBe(400);
    expect((await ctx.json('DELETE', '/api/targets/nope')).status).toBe(404);
  });
});

describe('password', () => {
  it('requires it when set, except for the health check', async () => {
    const { app } = await setup({}, 'letmein');
    expect((await app.request('/api/status')).status).toBe(401);
    expect((await app.request('/healthz')).status).toBe(200);
    const auth = { authorization: `Basic ${Buffer.from('admin:letmein').toString('base64')}` };
    expect((await app.request('/api/status', { headers: auth })).status).toBe(200);
  });
});
