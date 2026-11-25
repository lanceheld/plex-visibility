/**
 * Notifications are delivered by apprise-api, which runs in the same container
 * on 127.0.0.1:8000. Each destination is sent separately so the UI can show
 * which ones worked.
 */
import type { MonitorEvent } from './monitor.ts';
import type { NotifyTarget, ServiceInfo, State, TestResult } from './types.ts';

export type NotifyType = 'info' | 'success' | 'warning' | 'failure';

const TITLES: Partial<Record<State, string>> = {
  unreachable: 'Plex is not reachable remotely',
  signed_out: 'Plex is signed out of plex.tv',
  server_down: 'Plex server is not responding',
  auth_error: 'Plex monitor cannot sign in to your server',
};

export function formatDuration(ms: number): string {
  let minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'under a minute';
  }
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(' ');
}

export function render(event: MonitorEvent, serverName: string): { title: string; body: string; type: NotifyType } {
  const { status } = event;
  const lines = [status.detail];
  if (status.publicAddress) {
    lines.push(`Public endpoint: ${status.publicAddress}${status.publicPort ? `:${status.publicPort}` : ''}`);
  }
  if (event.downSince) {
    const label = event.kind === 'recovered' ? 'Was down for' : 'Down for';
    lines.push(`${label}: ${formatDuration(event.now.getTime() - event.downSince.getTime())}`);
  }
  if (serverName) {
    lines.push(`Server: ${serverName}`);
  }
  const body = lines.join('\n');

  if (event.kind === 'recovered') {
    return { title: 'Plex remote access restored', body, type: 'success' };
  }
  let title = TITLES[status.state] ?? 'Plex remote access problem';
  if (event.kind === 'reminder') {
    title = `Still down: ${title}`;
  }
  return { title, body, type: 'failure' };
}

interface AppriseSchema {
  service_name: string;
  setup_url?: string;
  service_url?: string;
  protocols?: string[] | null;
  secure_protocols?: string[] | null;
  details?: { templates?: string[] };
}

export class AppriseClient {
  private services: ServiceInfo[] | null = null;

  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl = 'http://127.0.0.1:8000', fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async notifyOne(
    url: string,
    title: string,
    body: string,
    type: NotifyType,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/notify/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ urls: url, title, body, type }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        return { ok: true };
      }
      return { ok: false, error: await describeError(res) };
    } catch (err) {
      return { ok: false, error: `Notification service unavailable: ${(err as Error).message}` };
    }
  }

  async notifyAll(targets: NotifyTarget[], title: string, body: string, type: NotifyType): Promise<TestResult[]> {
    return Promise.all(
      targets.map(async (t) => ({ id: t.id, label: t.label, ...(await this.notifyOne(t.url, title, body, type)) })),
    );
  }

  async ready(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/details/`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Catalogue of supported services, for the "add destination" picker. */
  async listServices(): Promise<ServiceInfo[]> {
    if (this.services) {
      return this.services;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/details/`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`apprise-api returned HTTP ${res.status}`);
    }
    const { schemas } = (await res.json()) as { schemas: AppriseSchema[] };
    this.services = schemas
      .map((s) => ({
        name: s.service_name,
        setupUrl: s.setup_url ?? s.service_url ?? '',
        schemas: [...(s.secure_protocols ?? []), ...(s.protocols ?? [])],
        templates: s.details?.templates ?? [],
      }))
      .filter((s) => s.schemas.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return this.services;
  }
}

async function describeError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; details?: [string, string, string][] };
    const problems = (data.details ?? []).filter(([level]) => level !== 'INFO' && level !== 'DEBUG').map((d) => d[2]);
    return [data.error, ...problems].filter(Boolean).join(': ') || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Ping a dead-man's switch such as healthchecks.io. If pings stop because the
 * host or internet connection is down, that service alerts you; this monitor
 * couldn't, since it can't reach the internet either.
 */
export async function pingHeartbeat(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!url) {
    return true;
  }
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}
