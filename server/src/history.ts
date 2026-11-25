/**
 * Check history, stored compactly as segments (runs of the same state) rather
 * than one row per check, plus a log of the alerts that were sent.
 */
import { readJson, writeJson } from './store.ts';
import type { AlertLogEntry, RemoteStatus, Segment } from './types.ts';

const KEEP_MS = 30 * 86_400_000;
const MAX_ALERTS = 200;
// A gap longer than this between checks (e.g. the container was stopped) starts a new segment.
const GAP_MS = 10 * 60_000;

export interface HistoryData {
  segments: Segment[];
  alerts: AlertLogEntry[];
}

export class History {
  data: HistoryData = { segments: [], alerts: [] };

  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!this.file) {
      return;
    }
    const raw = (await readJson(this.file)) as Partial<HistoryData> | undefined;
    this.data = { segments: raw?.segments ?? [], alerts: raw?.alerts ?? [] };
  }

  async save(): Promise<void> {
    if (this.file) {
      await writeJson(this.file, this.data, 0o644);
    }
  }

  record(status: RemoteStatus): void {
    if (status.state === 'unconfigured') {
      return;
    }
    const at = status.checkedAt;
    const last = this.data.segments.at(-1);
    const gap = last ? Date.parse(at) - Date.parse(last.end) : Infinity;
    if (last?.state === status.state && gap <= GAP_MS) {
      last.end = at;
      last.detail = status.detail;
    } else {
      this.data.segments.push({ state: status.state, start: at, end: at, detail: status.detail });
    }
    const cutoff = Date.parse(at) - KEEP_MS;
    this.data.segments = this.data.segments.filter((s) => Date.parse(s.end) >= cutoff);
  }

  logAlert(entry: AlertLogEntry): void {
    this.data.alerts.unshift(entry);
    this.data.alerts.length = Math.min(this.data.alerts.length, MAX_ALERTS);
  }

  /** Segments overlapping the last `windowMs`, clipped to the window. */
  segmentsSince(windowMs: number, now = new Date()): Segment[] {
    const from = now.getTime() - windowMs;
    return this.data.segments
      .filter((s) => Date.parse(s.end) >= from)
      .map((s) => (Date.parse(s.start) < from ? { ...s, start: new Date(from).toISOString() } : s));
  }

  /**
   * Share of observed time in the window spent reachable, or null with no data.
   * Each segment counts up to the next segment's start (or its own end), so time
   * the monitor wasn't running isn't counted either way.
   */
  uptime(windowMs: number, now = new Date()): number | null {
    const segs = this.segmentsSince(windowMs, now);
    let up = 0;
    let total = 0;
    segs.forEach((s, i) => {
      const start = Date.parse(s.start);
      const next = segs[i + 1];
      const end =
        next && Date.parse(next.start) - Date.parse(s.end) <= GAP_MS ? Date.parse(next.start) : Date.parse(s.end);
      const span = Math.max(0, end - start);
      total += span;
      if (s.state === 'ok') {
        up += span;
      }
    });
    if (total === 0) {
      if (segs.length === 0) {
        return null;
      }
      return segs.every((s) => s.state === 'ok') ? 1 : 0;
    }
    return up / total;
  }
}
