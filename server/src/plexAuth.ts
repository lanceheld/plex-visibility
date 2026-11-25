/**
 * "Sign in with Plex" using plex.tv's PIN flow, so nobody has to dig a token
 * out of the Plex web app. The browser opens app.plex.tv/auth with the PIN
 * code; we poll the PIN until plex.tv attaches an auth token, then list the
 * account's servers. Each server comes with its own access token, which is
 * what we store: it is scoped to that server, unlike the account token.
 */
import { PLEX_HEADERS } from './plex.ts';
import type { PinStatus, PlexServerOption } from './types.ts';

interface PlexResource {
  name: string;
  clientIdentifier: string;
  provides: string;
  owned: boolean;
  accessToken?: string;
  connections?: { uri: string; local: boolean; relay: boolean }[];
}

interface PendingPin {
  code: string;
  createdAt: number;
  servers?: (PlexServerOption & { accessToken: string })[];
}

const PIN_TTL_MS = 15 * 60 * 1000;

export class PlexAuth {
  private readonly pins = new Map<number, PendingPin>();

  private readonly clientId: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(clientId: () => string, fetchImpl: typeof fetch = fetch) {
    this.clientId = clientId;
    this.fetchImpl = fetchImpl;
  }

  private headers(token?: string): Record<string, string> {
    return {
      ...PLEX_HEADERS,
      'X-Plex-Client-Identifier': this.clientId(),
      ...(token ? { 'X-Plex-Token': token } : {}),
    };
  }

  private prune(): void {
    const cutoff = Date.now() - PIN_TTL_MS;
    for (const [id, pin] of this.pins) {
      if (pin.createdAt < cutoff) {
        this.pins.delete(id);
      }
    }
  }

  async createPin(): Promise<{ id: number; authUrl: string }> {
    this.prune();
    const res = await this.fetchImpl('https://plex.tv/api/v2/pins?strong=true', {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`plex.tv refused the sign-in request (HTTP ${res.status})`);
    }
    const pin = (await res.json()) as { id: number; code: string };
    this.pins.set(pin.id, { code: pin.code, createdAt: Date.now() });
    const params = new URLSearchParams({
      clientID: this.clientId(),
      code: pin.code,
      'context[device][product]': PLEX_HEADERS['X-Plex-Product'],
    });
    return { id: pin.id, authUrl: `https://app.plex.tv/auth#?${params}` };
  }

  async checkPin(id: number): Promise<PinStatus> {
    const pending = this.pins.get(id);
    if (!pending || Date.now() - pending.createdAt > PIN_TTL_MS) {
      return { status: 'expired' };
    }
    if (pending.servers) {
      return { status: 'authorized', servers: pending.servers.map(stripToken) };
    }

    const res = await this.fetchImpl(`https://plex.tv/api/v2/pins/${id}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return { status: 'expired' };
    }
    if (!res.ok) {
      throw new Error(`plex.tv returned HTTP ${res.status}`);
    }
    const { authToken } = (await res.json()) as { authToken: string | null };
    if (!authToken) {
      return { status: 'waiting' };
    }

    pending.servers = await this.listServers(authToken);
    return { status: 'authorized', servers: pending.servers.map(stripToken) };
  }

  /** Token for a server the user picked after signing in with this PIN. */
  serverToken(pinId: number, serverId: string): string | undefined {
    return this.pins.get(pinId)?.servers?.find((s) => s.id === serverId)?.accessToken;
  }

  finish(pinId: number): void {
    this.pins.delete(pinId);
  }

  private async listServers(accountToken: string): Promise<(PlexServerOption & { accessToken: string })[]> {
    const res = await this.fetchImpl('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
      headers: this.headers(accountToken),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Could not list your PLEX servers (HTTP ${res.status})`);
    }
    const resources = (await res.json()) as PlexResource[];
    return resources
      .filter((r) => r.provides.split(',').includes('server'))
      .map((r) => ({
        id: r.clientIdentifier,
        name: r.name,
        owned: r.owned,
        accessToken: r.accessToken ?? accountToken,
        // Local, direct connections first: that's what a monitor on the LAN should use.
        connections: (r.connections ?? [])
          .map(({ uri, local, relay }) => ({ uri, local, relay }))
          .sort((a, b) => Number(b.local) - Number(a.local) || Number(a.relay) - Number(b.relay)),
      }));
  }
}

function stripToken({ accessToken: _, ...server }: PlexServerOption & { accessToken: string }): PlexServerOption {
  return server;
}
