// Types shared by the server and the web UI (the UI imports these as type-only).

export type State =
  | 'ok' // reachable from the internet
  | 'unreachable' // server is up, but plex.tv can't reach it
  | 'signed_out' // server isn't signed in to plex.tv, so remote access is impossible
  | 'server_down' // the monitor can't talk to the Plex server at all
  | 'auth_error' // the Plex token was rejected
  | 'unconfigured'; // no Plex server set up yet

export interface RemoteStatus {
  state: State;
  detail: string;
  mappingState?: string;
  publicAddress?: string;
  publicPort?: string;
  checkedAt: string; // ISO timestamp
}

export interface NotifyTarget {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
}

export interface Settings {
  clientId: string;
  plex: { url: string; token: string; serverName: string };
  monitor: {
    checkInterval: number; // seconds between checks
    failThreshold: number; // consecutive bad checks before alerting
    remindInterval: number; // seconds between "still down" reminders, 0 = off
  };
  notifications: { targets: NotifyTarget[]; notifyOnRecovery: boolean };
  heartbeatUrl: string;
}

/** Settings as sent to the browser: the Plex token never leaves the server. */
export type PublicSettings = Omit<Settings, 'plex' | 'clientId'> & {
  plex: { url: string; serverName: string; hasToken: boolean };
};

export type SettingsUpdate = {
  plex?: Partial<Settings['plex']>;
  monitor?: Partial<Settings['monitor']>;
  notifications?: Partial<Settings['notifications']>;
  heartbeatUrl?: string;
};

/** A run of consecutive checks with the same state. */
export interface Segment {
  state: State;
  start: string;
  end: string;
  detail: string;
}

export type AlertKind = 'down' | 'changed' | 'reminder' | 'recovered';

export interface AlertLogEntry {
  at: string;
  kind: AlertKind;
  state: State;
  title: string;
  body: string;
  delivered: boolean;
}

/** A settings backup. Includes secrets: the Plex token and full notification URLs. */
export interface ConfigExport {
  app: 'plex-visibility';
  version: string;
  exportedAt: string;
  settings: Omit<Settings, 'clientId'>;
}

export interface StatusResponse {
  current: RemoteStatus | null;
  alerting: boolean;
  downSince: string | null;
  nextCheckAt: string | null;
  uptime: { day: number | null; week: number | null };
  segments: Segment[]; // last 7 days, oldest first
  alerts: AlertLogEntry[]; // newest first
  appriseReady: boolean;
  version: string;
  // Enough for the public status page, which can't read the (admin-only) settings.
  serverName: string;
  enabledTargets: number;
}

export interface AuthState {
  authenticated: boolean;
  mustChangePassword: boolean;
}

export interface TestResult {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
}

export interface ServiceInfo {
  name: string;
  setupUrl: string;
  schemas: string[];
  templates: string[];
}

export interface PlexServerOption {
  id: string;
  name: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

export type PinStatus =
  { status: 'waiting' } | { status: 'expired' } | { status: 'authorized'; servers: PlexServerOption[] };
