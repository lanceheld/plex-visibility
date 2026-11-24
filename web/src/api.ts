import type {
  PinStatus,
  PublicSettings,
  RemoteStatus,
  ServiceInfo,
  SettingsUpdate,
  StatusResponse,
  TestResult,
} from "../../server/src/types.ts";

export type * from "../../server/src/types.ts";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data as T;
}

export const api = {
  status: () => request<StatusResponse>("GET", "/api/status"),
  checkNow: () => request<StatusResponse>("POST", "/api/check", {}),
  settings: () => request<PublicSettings>("GET", "/api/settings"),
  updateSettings: (u: SettingsUpdate) => request<PublicSettings>("PUT", "/api/settings", u),
  services: () => request<ServiceInfo[]>("GET", "/api/services"),
  addTarget: (label: string, url: string) => request<PublicSettings>("POST", "/api/targets", { label, url }),
  patchTarget: (id: string, patch: { label?: string; enabled?: boolean }) =>
    request<PublicSettings>("PATCH", `/api/targets/${id}`, patch),
  deleteTarget: (id: string) => request<PublicSettings>("DELETE", `/api/targets/${id}`),
  testTarget: (id: string) => request<TestResult>("POST", `/api/targets/${id}/test`, {}),
  testUrl: (url: string) => request<{ ok: boolean; error?: string }>("POST", "/api/targets/test", { url }),
  testPlex: (url?: string, token?: string) => request<RemoteStatus>("POST", "/api/plex/test", { url, token }),
  createPin: () => request<{ id: number; authUrl: string }>("POST", "/api/plex/pin", {}),
  checkPin: (id: number) => request<PinStatus>("GET", `/api/plex/pin/${id}`),
  selectServer: (pinId: number, serverId: string, uri: string, name: string) =>
    request<PublicSettings>("POST", `/api/plex/pin/${pinId}/select`, { serverId, uri, name }),
};
