import { describe, expect, it } from 'vitest';
import { History } from '../src/history.ts';
import { Monitor } from '../src/monitor.ts';
import { formatDuration, render } from '../src/notify.ts';
import type { RemoteStatus, State } from '../src/types.ts';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const status = (state: State, minutes = 0): RemoteStatus => ({
  state,
  detail: state,
  checkedAt: at(minutes).toISOString(),
});

describe('Monitor', () => {
  it('waits for the threshold before alerting', () => {
    const m = new Monitor({ failThreshold: 3, remindIntervalMs: 0 });
    expect(m.observe(status('unreachable'), at(0))).toBeNull();
    expect(m.observe(status('unreachable'), at(1))).toBeNull();
    const event = m.observe(status('unreachable'), at(2));
    expect(event?.kind).toBe('down');
    expect(event?.downSince).toEqual(at(0));
  });

  it('ignores a single blip', () => {
    const m = new Monitor({ failThreshold: 2, remindIntervalMs: 0 });
    m.observe(status('unreachable'), at(0));
    expect(m.observe(status('ok'), at(1))).toBeNull();
    expect(m.observe(status('unreachable'), at(2))).toBeNull();
  });

  it('alerts once, then recovers', () => {
    const m = new Monitor({ failThreshold: 1, remindIntervalMs: 0 });
    expect(m.observe(status('unreachable'), at(0))?.kind).toBe('down');
    expect(m.observe(status('unreachable'), at(1))).toBeNull();
    expect(m.observe(status('ok'), at(10))?.kind).toBe('recovered');
    expect(m.observe(status('ok'), at(11))).toBeNull();
  });

  it('sends reminders', () => {
    const m = new Monitor({ failThreshold: 1, remindIntervalMs: 30 * 60_000 });
    m.observe(status('unreachable'), at(0));
    expect(m.observe(status('unreachable'), at(29))).toBeNull();
    expect(m.observe(status('unreachable'), at(30))?.kind).toBe('reminder');
    expect(m.observe(status('unreachable'), at(45))).toBeNull();
    expect(m.observe(status('unreachable'), at(60))?.kind).toBe('reminder');
  });

  it('alerts again when the reason changes', () => {
    const m = new Monitor({ failThreshold: 1, remindIntervalMs: 0 });
    m.observe(status('unreachable'), at(0));
    const event = m.observe(status('server_down'), at(1));
    expect(event?.kind).toBe('changed');
    expect(event?.downSince).toEqual(at(0));
  });

  it('never alerts while unconfigured', () => {
    const m = new Monitor({ failThreshold: 1, remindIntervalMs: 0 });
    expect(m.observe(status('unconfigured'), at(0))).toBeNull();
    expect(m.alerting).toBe(false);
  });
});

describe('messages', () => {
  it('formats durations', () => {
    expect(formatDuration(20_000)).toBe('under a minute');
    expect(formatDuration((26 * 60 + 5) * 60_000)).toBe('1d 2h 5m');
  });

  it('renders a recovery message with the outage length', () => {
    const msg = render({ kind: 'recovered', status: status('ok', 90), downSince: at(0), now: at(90) }, 'Home');
    expect(msg.title).toBe('Plex remote access restored');
    expect(msg.body).toContain('Was down for: 1h 30m');
    expect(msg.type).toBe('success');
  });
});

describe('History', () => {
  it('merges consecutive checks into segments and computes uptime', () => {
    const h = new History();
    for (let i = 0; i <= 30; i++) {
      h.record(status('ok', i));
    }
    for (let i = 31; i <= 40; i++) {
      h.record(status('unreachable', i));
    }
    expect(h.data.segments.map((s) => s.state)).toEqual(['ok', 'unreachable']);
    // 31 min up (0→31), 9 min down (31→40)
    expect(h.uptime(86_400_000, at(40))).toBeCloseTo(31 / 40);
  });

  it('starts a new segment after a gap and has no uptime without data', () => {
    const h = new History();
    expect(h.uptime(86_400_000, at(0))).toBeNull();
    h.record(status('ok', 0));
    h.record(status('ok', 60));
    expect(h.data.segments).toHaveLength(2);
  });
});
