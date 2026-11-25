import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { History } from '../src/history.ts';
import { AppriseClient, pingHeartbeat } from '../src/notify.ts';
import { MonitorService } from '../src/service.ts';
import { SettingsStore } from '../src/settings.ts';

/** A fake network: a Plex server whose mapping state we control, apprise-api, and a heartbeat endpoint. */
function fakeNetwork() {
  const state = { mapping: 'mapped', appriseFails: false };
  const notified: { urls: string; title: string; type: string }[] = [];
  const heartbeats: string[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/myplex/account')) {
      return Response.json({ MyPlex: { signInState: 'ok', mappingState: state.mapping, publicAddress: '1.2.3.4' } });
    }
    if (url.endsWith('/notify/')) {
      if (state.appriseFails) {
        return Response.json({ error: 'No valid URLs', details: [['WARNING', '', 'bad url']] }, { status: 400 });
      }
      notified.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }
    if (url.endsWith('/details/')) {
      return Response.json({ schemas: [] });
    }
    if (url.startsWith('https://hc-ping')) {
      heartbeats.push(url);
      return new Response('OK');
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { state, notified, heartbeats, fetchImpl };
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  const net = fakeNetwork();
  const dir = await mkdtemp(path.join(tmpdir(), 'pv-svc-'));
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  await settings.load({
    PLEX_URL: 'http://plex:32400',
    PLEX_TOKEN: 'tok',
    NOTIFY_URLS: 'ntfy://ntfy.sh/topic',
    HEARTBEAT_URL: 'https://hc-ping.com/abc',
    ...env,
  });
  await settings.update({ monitor: { failThreshold: 2 } });
  const history = new History(path.join(dir, 'history.json'));
  const logs: string[] = [];
  const service = new MonitorService({
    settings,
    history,
    apprise: new AppriseClient('http://apprise', net.fetchImpl),
    fetchImpl: net.fetchImpl,
    log: (m) => logs.push(m),
  });
  return { ...net, settings, history, service, logs, dir };
}

describe('MonitorService', () => {
  it('alerts after the threshold, then sends a recovery, and pings the heartbeat every check', async () => {
    const t = await setup();
    expect((await t.service.checkNow()).state).toBe('ok');

    t.state.mapping = 'failed';
    await t.service.checkNow();
    expect(t.notified).toHaveLength(0);
    await t.service.checkNow();
    expect(t.notified).toEqual([expect.objectContaining({ title: 'Plex is not reachable remotely', type: 'failure' })]);
    expect(t.service.snapshot().alerting).toBe(true);

    t.state.mapping = 'mapped';
    await t.service.checkNow();
    expect(t.notified.at(-1)).toMatchObject({ title: 'Plex remote access restored', type: 'success' });

    const snap = t.service.snapshot();
    expect(snap.alerting).toBe(false);
    expect(snap.alerts.map((a) => a.kind)).toEqual(['recovered', 'down']);
    expect(snap.appriseReady).toBe(true);
    expect(t.heartbeats).toHaveLength(4);

    // History was persisted.
    const reloaded = new History(path.join(t.dir, 'history.json'));
    await reloaded.load();
    expect(reloaded.data.alerts).toHaveLength(2);
  });

  it('skips the recovery message when turned off, and skips disabled destinations', async () => {
    const t = await setup();
    await t.settings.update({ notifications: { notifyOnRecovery: false } });
    t.state.mapping = 'failed';
    await t.service.checkNow();
    await t.service.checkNow();
    t.state.mapping = 'mapped';
    await t.service.checkNow();
    expect(t.notified.map((n) => n.type)).toEqual(['failure']);

    const [target] = t.settings.get().notifications.targets;
    await t.settings.update({ notifications: { targets: [{ ...target!, enabled: false }] } });
    t.state.mapping = 'failed';
    await t.service.checkNow();
    await t.service.checkNow();
    expect(t.notified).toHaveLength(1);
  });

  it('records undelivered alerts and logs why', async () => {
    const t = await setup();
    t.state.appriseFails = true;
    t.state.mapping = 'failed';
    await t.service.checkNow();
    await t.service.checkNow();
    expect(t.service.snapshot().alerts[0]?.delivered).toBe(false);
    expect(t.logs.some((l) => l.includes('No valid URLs: bad url'))).toBe(true);
  });

  it('keeps text from Plex on one log line', async () => {
    const t = await setup();
    t.state.mapping = 'failed\n2026-01-01T00:00:00.000Z Status: ok';
    await t.service.checkNow();
    expect(t.logs).toEqual([expect.stringContaining('mappingState=failed 2026-01-01t00:00:00.000z status: ok')]);
    expect(t.logs.some((l) => /[\r\n]/.test(l))).toBe(false);
  });

  it('shares one run between concurrent checks', async () => {
    const t = await setup();
    const [a, b] = [t.service.checkNow(), t.service.checkNow()];
    expect(a).toBe(b);
    await a;
  });

  it('schedules checks once started and stops cleanly', async () => {
    const t = await setup();
    t.service.start();
    expect(t.service.snapshot().nextCheckAt).not.toBeNull();
    await t.settings.update({ monitor: { checkInterval: 30 } });
    t.service.stop();
  });
});

describe('pingHeartbeat', () => {
  it('does nothing without a URL and reports failures', async () => {
    expect(await pingHeartbeat('')).toBe(true);
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await pingHeartbeat('https://hc-ping.com/x', failing)).toBe(false);
  });
});
