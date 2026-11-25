import type {
  AuthState,
  ConfigExport,
  PinStatus,
  PublicSettings,
  RecoveryStatus,
  RemoteStatus,
  ServiceInfo,
  SettingsUpdate,
  StatusResponse,
  TestResult,
} from '../../server/src/types.ts';

export type * from '../../server/src/types.ts';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  // Only ever call this app's own API. Resolved against the page's origin, not document.baseURI,
  // so neither a <base> tag nor a bad path can send the request (and its session cookie) elsewhere.
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) {
    throw new Error(`Refusing to request ${url}`);
  }
  const res = await fetch(target, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  // The session ended (expired, logged out elsewhere, or the PIN changed): let the app show the login.
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    window.dispatchEvent(new Event(LOGGED_OUT_EVENT));
  }
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

/**
 * An id as one URL path segment. Ids come from API responses, so check them
 * rather than trust their type: a number must be a whole number, and any id
 * is escaped so it can't add path segments (like "../") or a query.
 */
function seg(id: number | string): string {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) {
    throw new TypeError(`Invalid id: ${id}`);
  }
  return encodeURIComponent(id);
}

export const LOGGED_OUT_EVENT = 'plex-visibility:logged-out';

export const api = {
  auth: () => request<AuthState>('GET', '/api/auth'),
  login: (pin: string) => request<AuthState>('POST', '/api/auth/login', { pin }),
  logout: () => request<AuthState>('POST', '/api/auth/logout', {}),
  /** Set, change or remove (next: null) the settings PIN. `current` is needed once a PIN is set. */
  setPin: (current: string | undefined, next: string | null) =>
    request<AuthState>('PUT', '/api/auth/pin', { current, next }),
  recoveryAvailable: () => request<{ available: boolean }>('GET', '/api/auth/recover'),
  startRecovery: () => request<{ id: number; authUrl: string }>('POST', '/api/auth/recover/pin', {}),
  checkRecovery: (id: number) => request<RecoveryStatus>('GET', `/api/auth/recover/pin/${seg(id)}`),
  removePinWithPlex: (pinId: number) => request<AuthState>('POST', '/api/auth/recover', { pinId }),
  status: () => request<StatusResponse>('GET', '/api/status'),
  checkNow: () => request<StatusResponse>('POST', '/api/check', {}),
  settings: () => request<PublicSettings>('GET', '/api/settings'),
  updateSettings: (u: SettingsUpdate) => request<PublicSettings>('PUT', '/api/settings', u),
  services: () => request<ServiceInfo[]>('GET', '/api/services'),
  addTarget: (label: string, url: string) => request<PublicSettings>('POST', '/api/targets', { label, url }),
  patchTarget: (id: string, patch: { label?: string; enabled?: boolean }) =>
    request<PublicSettings>('PATCH', `/api/targets/${seg(id)}`, patch),
  deleteTarget: (id: string) => request<PublicSettings>('DELETE', `/api/targets/${seg(id)}`),
  testTarget: (id: string) => request<TestResult>('POST', `/api/targets/${seg(id)}/test`, {}),
  testUrl: (url: string) => request<{ ok: boolean; error?: string }>('POST', '/api/targets/test', { url }),
  exportConfig: () => request<ConfigExport>('POST', '/api/config/export', {}),
  importConfig: (config: unknown) => request<PublicSettings>('POST', '/api/config/import', config),
  testPlex: (url?: string, token?: string) => request<RemoteStatus>('POST', '/api/plex/test', { url, token }),
  createPin: () => request<{ id: number; authUrl: string }>('POST', '/api/plex/pin', {}),
  checkPin: (id: number) => request<PinStatus>('GET', `/api/plex/pin/${seg(id)}`),
  selectServer: (pinId: number, serverId: string, uri: string, name: string) =>
    request<PublicSettings>('POST', `/api/plex/pin/${seg(pinId)}/select`, { serverId, uri, name }),
};
