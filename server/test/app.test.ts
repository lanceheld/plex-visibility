import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, maskUrl } from '../src/app.ts';
import { AuthStore } from '../src/auth.ts';
import { History } from '../src/history.ts';
import { AppriseClient } from '../src/notify.ts';
import { PlexAuth } from '../src/plexAuth.ts';
import { MonitorService } from '../src/service.ts';
import { SettingsStore } from '../src/settings.ts';
import type { ConfigExport, PublicSettings, StatusResponse } from '../src/types.ts';

describe('maskUrl', () => {
  it('hides passwords and long tokens', () => {
    expect(maskUrl('mailtos://me:hunter2@gmail.com?to=x@y.z')).toBe('mailtos://me:•••@gmail.com');
    expect(maskUrl('discord://123456789012/abcdefghijklmnop')).toBe('discord://123•••/abc•••');
    expect(maskUrl('ntfy://ntfy.sh/my-secret-topic')).toBe('ntfy://ntfy.sh/my-•••');
  });
});

/**
 * With `pin` (the default), a PIN is set and this "browser" is logged in.
 * With `pin: false`, no PIN is set, so Settings are open.
 */
async function setup(env: NodeJS.ProcessEnv = {}, { pin = true, loggedIn = true } = {}) {
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
    // The signed-in account (above) owns s1, which is the server at http://plex:32400.
    if (url.endsWith('/identity')) {
      const machineIdentifier = url.startsWith('http://plex:32400/') ? 's1' : 'someone-elses';
      return Response.json({ MediaContainer: { machineIdentifier } });
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
  const auth = new AuthStore();
  await auth.load();
  const app = createApp({ settings, service, apprise, plexAuth, auth, fetchImpl: netFetch });

  let cookie = '';
  const request = (method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** Send a JSON request with the current session cookie, keeping any new cookie the server sets. */
  const json = async (method: string, url: string, body?: unknown) => {
    const res = await request(method, url, body);
    const set = res.headers.get('set-cookie');
    if (set) {
      cookie = set.split(';')[0]!;
    }
    return res;
  };
  const get = (url: string) => json('GET', url);

  if (pin) {
    await json('PUT', '/api/auth/pin', { next: PIN });
    if (!loggedIn) {
      await json('POST', '/api/auth/logout', {});
    }
  }
  return { app, json, get, settings, sent, auth, setCookie: (c: string) => (cookie = c) };
}

const PIN = '482913';

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
    const res = await ctx.get('/api/settings');
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
    const status = await (await ctx.get('/api/plex/pin/9')).json();
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
    expect(status.version).toBe('dev');
    expect(await (await ctx.app.request('/api/status')).json()).toMatchObject({ current: { state: 'ok' } });
    expect(await (await ctx.get('/api/services')).json()).toEqual([
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

describe('settings PIN', () => {
  it('leaves Settings open until a PIN is set', async () => {
    const ctx = await setup({}, { pin: false });
    expect(await (await ctx.get('/api/auth')).json()).toEqual({ pinSet: false, authenticated: true });
    expect((await ctx.get('/api/settings')).status).toBe(200);
    // Logging in or out without a PIN changes nothing.
    expect(await (await ctx.json('POST', '/api/auth/login', { pin: '000000' })).json()).toEqual({
      pinSet: false,
      authenticated: true,
    });
    await ctx.json('POST', '/api/auth/logout', {});
    expect((await ctx.get('/api/settings')).status).toBe(200);

    expect((await ctx.json('PUT', '/api/auth/pin', { next: '12345' })).status).toBe(400);
    expect((await ctx.json('PUT', '/api/auth/pin', { next: 'abcdef' })).status).toBe(400);
    const set = await ctx.json('PUT', '/api/auth/pin', { next: PIN });
    expect(await set.json()).toEqual({ pinSet: true, authenticated: true });
    // This browser stays logged in; others now need the PIN.
    expect((await ctx.get('/api/settings')).status).toBe(200);
    ctx.setCookie('');
    expect(await (await ctx.get('/api/auth')).json()).toEqual({ pinSet: true, authenticated: false });
    expect((await ctx.get('/api/settings')).status).toBe(401);
  });

  it('keeps the status page and health check public', async () => {
    const ctx = await setup({}, { loggedIn: false });
    expect((await ctx.get('/api/status')).status).toBe(200);
    expect((await ctx.json('POST', '/api/check', {})).status).toBe(200);
    expect((await ctx.app.request('/healthz')).status).toBe(200);
    for (const [method, url] of [
      ['POST', '/api/config/export'],
      ['POST', '/api/targets/test'],
      ['POST', '/api/plex/pin'],
      ['GET', '/api/services'],
      ['PUT', '/api/auth/pin'],
    ] as const) {
      expect((await ctx.json(method, url, method === 'GET' ? undefined : { next: null })).status, url).toBe(401);
    }
  });

  it('rejects wrong PINs, tampered cookies and sessions from before a PIN change', async () => {
    const ctx = await setup({}, { loggedIn: false });
    expect((await ctx.json('POST', '/api/auth/login', { pin: '000000' })).status).toBe(401);

    ctx.setCookie(`pv_session=${encodeURIComponent('999.99999999999999.forged')}`);
    expect((await ctx.get('/api/settings')).status).toBe(401);

    const login = await ctx.json('POST', '/api/auth/login', { pin: PIN });
    expect(await login.json()).toEqual({ pinSet: true, authenticated: true });
    const oldCookie = login.headers.get('set-cookie')!;
    expect((await ctx.get('/api/settings')).status).toBe(200);
    expect((await ctx.get('/api/auth')).headers.get('set-cookie')).toBeNull(); // no new cookie on GET

    // Change the PIN from "another browser": the first session ends.
    await ctx.auth.setPin('111111');
    ctx.setCookie(oldCookie.split(';')[0]!);
    expect((await ctx.get('/api/settings')).status).toBe(401);
  });

  it('needs the current PIN to change or remove it', async () => {
    const ctx = await setup();
    expect((await ctx.json('PUT', '/api/auth/pin', { next: '111111' })).status).toBe(401);
    expect((await ctx.json('PUT', '/api/auth/pin', { current: '000000', next: null })).status).toBe(401);

    const changed = await ctx.json('PUT', '/api/auth/pin', { current: PIN, next: '111111' });
    expect(await changed.json()).toEqual({ pinSet: true, authenticated: true });
    expect((await ctx.get('/api/settings')).status).toBe(200);
    expect(await ctx.auth.verify('111111')).toBe(true);

    const removed = await ctx.json('PUT', '/api/auth/pin', { current: '111111', next: null });
    expect(await removed.json()).toEqual({ pinSet: false, authenticated: true });
    expect(ctx.auth.pinSet).toBe(false);
    expect((await ctx.get('/api/settings')).status).toBe(200);
  });

  it('locks out repeated failures and logs out', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) {
      await ctx.json('POST', '/api/auth/login', { pin: '000000' });
    }
    const locked = await ctx.json('POST', '/api/auth/login', { pin: PIN });
    expect(locked.status).toBe(429);
    // Guessing through the change form counts too.
    expect((await ctx.json('PUT', '/api/auth/pin', { current: PIN, next: null })).status).toBe(429);

    expect(await (await ctx.json('POST', '/api/auth/logout', {})).json()).toEqual({
      pinSet: true,
      authenticated: false,
    });
    expect((await ctx.get('/api/settings')).status).toBe(401);
  });
});

describe('forgotten PIN', () => {
  const plex = { PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'good' };

  it('is removed after signing in with Plex as the server owner', async () => {
    const ctx = await setup({ ...plex, NOTIFY_URLS: 'ntfy://ntfy.sh/alerts' });
    const otherBrowser = (await ctx.json('POST', '/api/auth/login', { pin: PIN })).headers.get('set-cookie')!;
    await ctx.json('POST', '/api/auth/logout', {});

    expect(await (await ctx.get('/api/auth/recover')).json()).toEqual({ available: true });
    const pin = await (await ctx.json('POST', '/api/auth/recover/pin', {})).json();
    expect(pin).toMatchObject({ id: 9, authUrl: expect.stringContaining('app.plex.tv') });
    expect(await (await ctx.get('/api/auth/recover/pin/9')).json()).toEqual({ status: 'verified' });

    const res = await ctx.json('POST', '/api/auth/recover', { pinId: 9 });
    expect(await res.json()).toEqual({ pinSet: false, authenticated: true });
    expect(ctx.auth.pinSet).toBe(false);
    expect((await ctx.get('/api/settings')).status).toBe(200);
    await vi.waitFor(() =>
      expect(ctx.sent).toContainEqual(expect.objectContaining({ title: 'Plex Visibility settings PIN removed' })),
    );

    // Setting a new PIN signs out the other browser's old session, and the sign-in can't be used again.
    await ctx.json('PUT', '/api/auth/pin', { next: '111111' });
    ctx.setCookie(otherBrowser.split(';')[0]!);
    expect((await ctx.get('/api/settings')).status).toBe(401);
    expect((await ctx.json('POST', '/api/auth/recover', { pinId: 9 })).status).toBe(410);
    expect(ctx.auth.pinSet).toBe(true);
  });

  it("refuses accounts that don't own the monitored server", async () => {
    const ctx = await setup({ ...plex, PLEX_URL: 'http://not-mine:32400' }, { loggedIn: false });
    await ctx.json('POST', '/api/auth/recover/pin', {});
    const status = await (await ctx.get('/api/auth/recover/pin/9')).json();
    expect(status).toMatchObject({ status: 'denied', error: expect.stringContaining("doesn't own") });
    expect((await ctx.json('POST', '/api/auth/recover', { pinId: 9 })).status).toBe(410);
    expect(ctx.auth.pinSet).toBe(true);
  });

  it("ignores PINs it didn't start, such as a Settings sign-in", async () => {
    const ctx = await setup(plex);
    await ctx.json('POST', '/api/plex/pin', {});
    await ctx.json('POST', '/api/auth/logout', {});
    expect(await (await ctx.get('/api/auth/recover/pin/9')).json()).toEqual({ status: 'expired' });
    expect((await ctx.json('POST', '/api/auth/recover', { pinId: 9 })).status).toBe(410);

    // ...and leaves that sign-in working.
    await ctx.json('POST', '/api/auth/login', { pin: PIN });
    expect(await (await ctx.get('/api/plex/pin/9')).json()).toMatchObject({ status: 'authorized' });
  });

  it('is unavailable until a Plex server is set up', async () => {
    const ctx = await setup({}, { loggedIn: false });
    expect(await (await ctx.get('/api/auth/recover')).json()).toEqual({ available: false });
    expect((await ctx.json('POST', '/api/auth/recover/pin', {})).status).toBe(409);
  });
});

describe('config backup', () => {
  const exportConfig = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    const res = await ctx.json('POST', '/api/config/export', {});
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="plex-visibility-config-.*\.json"/);
    return (await res.json()) as ConfigExport;
  };

  it('exports everything, secrets included, but not the client ID', async () => {
    const ctx = await setup({
      PLEX_URL: 'http://plex:32400',
      PLEX_TOKEN: 'good',
      NOTIFY_URLS: 'mailtos://me:pw@x.com',
    });
    const config = await exportConfig(ctx);
    expect(config).toMatchObject({ app: 'plex-visibility', version: 'dev' });
    expect(config.settings.plex.token).toBe('good');
    expect(config.settings.notifications.targets[0]?.url).toBe('mailtos://me:pw@x.com');
    expect(JSON.stringify(config)).not.toContain(ctx.settings.get().clientId);
  });

  it('round-trips into another install, keeping that install’s client ID', async () => {
    const source = await setup({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'good', NOTIFY_URLS: 'ntfy://ntfy.sh/t' });
    await source.json('PUT', '/api/settings', {
      monitor: { checkInterval: 300 },
      heartbeatUrl: 'https://hc-ping.com/x',
    });
    const config = await exportConfig(source);

    const target = await setup();
    const clientId = target.settings.get().clientId;
    const res = await target.json('POST', '/api/config/import', config);
    expect(res.status).toBe(200);
    const { clientId: newId, ...imported } = target.settings.get();
    expect(newId).toBe(clientId);
    expect(imported).toEqual(config.settings);
  });

  it('fills in defaults and ids for partial files', async () => {
    const ctx = await setup();
    const res = await ctx.json('POST', '/api/config/import', {
      app: 'plex-visibility',
      settings: { notifications: { targets: [{ url: 'ntfy://ntfy.sh/t' }] } },
    });
    expect(res.status).toBe(200);
    const s = ctx.settings.get();
    expect(s.monitor.checkInterval).toBe(60);
    expect(s.notifications.targets[0]).toMatchObject({ url: 'ntfy://ntfy.sh/t', enabled: true });
    expect(s.notifications.targets[0]?.id).toBeTruthy();
  });

  it('rejects a backup from a newer format with a clear message, leaving settings alone', async () => {
    const ctx = await setup({ PLEX_TOKEN: 'keep' });
    const config = await exportConfig(ctx);
    const res = await ctx.json('POST', '/api/config/import', {
      ...config,
      schemaVersion: config.schemaVersion + 1,
      settings: { ...config.settings, plex: { ...config.settings.plex, token: 'replaced' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('newer version of Plex Visibility');
    expect(ctx.settings.get().plex.token).toBe('keep');
  });

  it('rejects files that are not a valid configuration, leaving settings alone', async () => {
    const ctx = await setup({ PLEX_TOKEN: 'keep' });
    const notOurs = await ctx.json('POST', '/api/config/import', { settings: {} });
    expect(notOurs.status).toBe(400);
    expect(((await notOurs.json()) as { error: string }).error).toContain('Not a Plex Visibility configuration file');
    const invalid = await ctx.json('POST', '/api/config/import', {
      app: 'plex-visibility',
      settings: { monitor: { checkInterval: 1 } },
    });
    expect(invalid.status).toBe(400);
    expect(ctx.settings.get().plex.token).toBe('keep');
  });
});
