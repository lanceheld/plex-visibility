/** Runs the check loop: Plex status → history → alert decision → notifications → heartbeat. */
import { Monitor } from './monitor.ts';
import type { History } from './history.ts';
import { type AppriseClient, pingHeartbeat, render } from './notify.ts';
import { fetchStatus } from './plex.ts';
import type { SettingsStore } from './settings.ts';
import type { RemoteStatus, Settings, StatusResponse } from './types.ts';

const DAY = 86400_000;

export interface ServiceDeps {
  settings: SettingsStore;
  history: History;
  apprise: AppriseClient;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export class MonitorService {
  private monitor: Monitor;
  private current: RemoteStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextCheckAt: Date | null = null;
  private running: Promise<RemoteStatus> | null = null;
  private appriseReady = false;
  private started = false;
  private log: (msg: string) => void;

  private deps: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.monitor = new Monitor(monitorOptions(deps.settings.get()));
    this.log = deps.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    deps.settings.onChange((s) => {
      this.monitor.options = monitorOptions(s);
      // Re-check promptly so changes (like a new server) show up right away.
      if (this.started) {
        this.schedule(1000);
      }
    });
  }

  start(): void {
    this.started = true;
    this.schedule(2000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.nextCheckAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => {
      void this.checkNow().finally(() => this.schedule(this.deps.settings.get().monitor.checkInterval * 1000));
    }, delayMs);
  }

  /** Run a check now; concurrent callers share the same run. */
  checkNow(): Promise<RemoteStatus> {
    this.running ??= this.runCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runCheck(): Promise<RemoteStatus> {
    const s = this.deps.settings.get();
    const status = await fetchStatus({
      url: s.plex.url,
      token: s.plex.token,
      clientId: s.clientId,
      fetchImpl: this.deps.fetchImpl,
    });
    if (status.state !== this.current?.state) {
      this.log(`Status: ${status.state}: ${status.detail}`);
    }
    this.current = status;
    this.deps.history.record(status);

    const event = this.monitor.observe(status, new Date(status.checkedAt));
    if (event && !(event.kind === 'recovered' && !s.notifications.notifyOnRecovery)) {
      const msg = render(event, s.plex.serverName || s.plex.url);
      const targets = s.notifications.targets.filter((t) => t.enabled);
      const results = await this.deps.apprise.notifyAll(targets, msg.title, msg.body, msg.type);
      for (const r of results.filter((r) => !r.ok)) {
        this.log(`Notification to "${r.label}" failed: ${r.error}`);
      }
      this.log(`Alert (${event.kind}): ${msg.title}`);
      this.deps.history.logAlert({
        at: event.now.toISOString(),
        kind: event.kind,
        state: status.state,
        title: msg.title,
        body: msg.body,
        delivered: results.some((r) => r.ok),
      });
    }

    await this.deps.history.save().catch((err) => this.log(`Could not save history: ${err}`));
    if (!(await pingHeartbeat(s.heartbeatUrl, this.deps.fetchImpl))) {
      this.log('Heartbeat ping failed');
    }
    this.appriseReady = await this.deps.apprise.ready();
    return status;
  }

  snapshot(now = new Date()): StatusResponse {
    const { history } = this.deps;
    return {
      current: this.current,
      alerting: this.monitor.alerting,
      downSince: this.monitor.downSince?.toISOString() ?? null,
      nextCheckAt: this.nextCheckAt?.toISOString() ?? null,
      uptime: { day: history.uptime(DAY, now), week: history.uptime(7 * DAY, now) },
      segments: history.segmentsSince(7 * DAY, now),
      alerts: history.data.alerts.slice(0, 50),
      appriseReady: this.appriseReady,
    };
  }
}

function monitorOptions(s: Settings) {
  return { failThreshold: s.monitor.failThreshold, remindIntervalMs: s.monitor.remindInterval * 1000 };
}
