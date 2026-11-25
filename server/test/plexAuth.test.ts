import { describe, expect, it } from 'vitest';
import { AppriseClient } from '../src/notify.ts';
import { PlexAuth } from '../src/plexAuth.ts';

function fakePlexTv() {
  const state = { authToken: null as string | null, pinStatus: 200 };
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.startsWith('https://plex.tv/api/v2/pins?')) {
      return Response.json({ id: 42, code: 'abcd' });
    }
    if (url === 'https://plex.tv/api/v2/pins/42') {
      return state.pinStatus === 200
        ? Response.json({ authToken: state.authToken })
        : new Response('', { status: state.pinStatus });
    }
    if (url.startsWith('https://clients.plex.tv/api/v2/resources')) {
      return Response.json([
        { name: 'Phone', clientIdentifier: 'phone', provides: 'client,player', owned: true },
        {
          name: 'Home',
          clientIdentifier: 'srv1',
          provides: 'server',
          owned: true,
          accessToken: 'server-token',
          connections: [
            { uri: 'https://relay.plex.direct', local: false, relay: true, address: 'x' },
            { uri: 'https://1-2-3-4.plex.direct:32400', local: false, relay: false },
            { uri: 'http://192.168.1.5:32400', local: true, relay: false },
          ],
        },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { state, requests, fetchImpl };
}

describe('PlexAuth', () => {
  it('runs the PIN flow and returns servers with local connections first, without tokens', async () => {
    const net = fakePlexTv();
    const auth = new PlexAuth(() => 'client-1', net.fetchImpl);

    const pin = await auth.createPin();
    expect(pin.id).toBe(42);
    expect(pin.authUrl).toContain('https://app.plex.tv/auth#?');
    expect(pin.authUrl).toContain('clientID=client-1');
    expect(pin.authUrl).toContain('code=abcd');
    expect(net.requests[0]?.headers['X-Plex-Client-Identifier']).toBe('client-1');

    expect(await auth.checkPin(42)).toEqual({ status: 'waiting' });

    net.state.authToken = 'account-token';
    const result = await auth.checkPin(42);
    expect(result.status).toBe('authorized');
    if (result.status !== 'authorized') {
      return;
    }
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.connections.map((c) => c.uri)).toEqual([
      'http://192.168.1.5:32400',
      'https://1-2-3-4.plex.direct:32400',
      'https://relay.plex.direct',
    ]);
    expect(JSON.stringify(result)).not.toContain('token');
    expect(net.requests.at(-1)?.headers['X-Plex-Token']).toBe('account-token');

    // Cached after authorization; no extra plex.tv calls.
    const calls = net.requests.length;
    await auth.checkPin(42);
    expect(net.requests.length).toBe(calls);

    expect(auth.serverToken(42, 'srv1')).toBe('server-token');
    auth.finish(42);
    expect(auth.serverToken(42, 'srv1')).toBeUndefined();
  });

  it('reports unknown or expired PINs', async () => {
    const net = fakePlexTv();
    const auth = new PlexAuth(() => 'c', net.fetchImpl);
    expect(await auth.checkPin(7)).toEqual({ status: 'expired' });
    await auth.createPin();
    net.state.pinStatus = 404;
    expect(await auth.checkPin(42)).toEqual({ status: 'expired' });
  });
});

describe('AppriseClient', () => {
  it('lists services sorted, skipping ones without a URL scheme, and caches them', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json({
        schemas: [
          { service_name: 'ntfy', setup_url: 'https://x/ntfy', protocols: ['ntfy'], secure_protocols: ['ntfys'] },
          {
            service_name: 'E-Mail',
            service_url: 'https://x/mail',
            protocols: ['mailto'],
            details: { templates: ['t'] },
          },
          { service_name: 'Broken', protocols: null },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new AppriseClient('http://apprise', fetchImpl);
    const services = await client.listServices();
    expect(services.map((s) => s.name)).toEqual(['E-Mail', 'ntfy']);
    expect(services[1]).toEqual({
      name: 'ntfy',
      setupUrl: 'https://x/ntfy',
      schemas: ['ntfys', 'ntfy'],
      templates: [],
    });
    await client.listServices();
    expect(calls).toBe(1);
  });

  it('reports apprise-api being down', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new AppriseClient('http://apprise', down);
    expect(await client.ready()).toBe(false);
    expect(await client.notifyOne('ntfy://x', 't', 'b', 'info')).toEqual({
      ok: false,
      error: 'Notification service unavailable: ECONNREFUSED',
    });
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetchImpl = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const client = new AppriseClient('http://apprise', fetchImpl);
    expect(await client.notifyOne('ntfy://x', 't', 'b', 'info')).toEqual({ ok: false, error: 'HTTP 500' });
    await expect(client.listServices()).rejects.toThrow('HTTP 500');
  });
});
