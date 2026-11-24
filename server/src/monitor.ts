/** Alerting state machine: ignores brief blips, sends one alert per outage, reminders, and recovery. */
import type { AlertKind, RemoteStatus, State } from "./types.ts";

export interface MonitorEvent {
  kind: AlertKind;
  status: RemoteStatus;
  downSince: Date | null;
  now: Date;
}

export interface MonitorOptions {
  failThreshold: number;
  remindIntervalMs: number; // 0 = no reminders
}

export class Monitor {
  private consecutiveBad = 0;
  private firstBadAt: Date | null = null;
  private alertedState: State | null = null;
  private lastAlertAt: Date | null = null;

  options: MonitorOptions;

  constructor(options: MonitorOptions) {
    this.options = options;
  }

  get alerting(): boolean {
    return this.alertedState !== null;
  }

  get downSince(): Date | null {
    return this.alerting ? this.firstBadAt : null;
  }

  /** Record one check result; returns the notification to send, if any. */
  observe(status: RemoteStatus, now: Date): MonitorEvent | null {
    // Nothing to monitor yet: neither healthy nor an outage.
    if (status.state === "unconfigured") {
      this.reset();
      return null;
    }

    if (status.state === "ok") {
      const event = this.alerting ? this.event("recovered", status, now) : null;
      this.reset();
      return event;
    }

    this.consecutiveBad += 1;
    this.firstBadAt ??= now;

    if (!this.alerting) {
      return this.consecutiveBad >= this.options.failThreshold ? this.alert("down", status, now) : null;
    }
    if (status.state !== this.alertedState) return this.alert("changed", status, now);

    const { remindIntervalMs } = this.options;
    if (remindIntervalMs > 0 && this.lastAlertAt && now.getTime() - this.lastAlertAt.getTime() >= remindIntervalMs) {
      return this.alert("reminder", status, now);
    }
    return null;
  }

  private reset(): void {
    this.consecutiveBad = 0;
    this.firstBadAt = null;
    this.alertedState = null;
    this.lastAlertAt = null;
  }

  private alert(kind: AlertKind, status: RemoteStatus, now: Date): MonitorEvent {
    this.alertedState = status.state;
    this.lastAlertAt = now;
    return this.event(kind, status, now);
  }

  private event(kind: AlertKind, status: RemoteStatus, now: Date): MonitorEvent {
    return { kind, status, downSince: this.firstBadAt, now };
  }
}
