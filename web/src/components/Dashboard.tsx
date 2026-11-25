import {
  BellRing,
  CheckCircle2,
  Clock,
  Globe,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import type { AlertLogEntry, Segment, StatusResponse } from '../api.ts';
import { ago, dateTime, duration, percent, STATE_META, TONE } from '../format.ts';
import { Badge, Button, Card, cx, useNow } from './ui.tsx';

export function Dashboard({
  status,
  onCheck,
  checking,
  goToSettings,
}: Readonly<{
  status: StatusResponse;
  onCheck: () => void;
  checking: boolean;
  goToSettings: () => void;
}>) {
  const now = useNow();
  const current = status.current;
  const meta = STATE_META[current?.state ?? 'unconfigured'];
  const tone = TONE[meta.tone];
  const Icon = meta.icon;
  const enabledTargets = status.enabledTargets;
  let endpoint: string | null = null;
  if (current?.publicAddress) {
    endpoint = current.publicPort ? `${current.publicAddress}:${current.publicPort}` : current.publicAddress;
  }
  let nextCheck = '—';
  if (status.nextCheckAt) {
    const wait = Date.parse(status.nextCheckAt) - now;
    nextCheck = wait <= 0 ? 'now' : `in ${duration(wait)}`;
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className={cx('relative overflow-hidden rounded-3xl p-6 ring-1 ring-inset sm:p-8', tone.soft)}>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div
              className={cx(
                'relative mt-1 grid size-14 shrink-0 place-items-center rounded-2xl bg-white shadow-sm dark:bg-slate-900',
                tone.text,
              )}
            >
              <Icon className="size-8" />
              {meta.tone !== 'idle' && (
                <span
                  className={cx(
                    'absolute -top-1 -right-1 size-3.5 rounded-full ring-4 ring-white dark:ring-slate-900',
                    tone.bg,
                  )}
                >
                  <span className={cx('absolute inset-0 animate-ping rounded-full opacity-60', tone.bg)} />
                </span>
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                {status.serverName || 'PLEX Media Server'}
              </p>
              <h1 className={cx('text-2xl font-bold tracking-tight sm:text-3xl', tone.text)}>{meta.label}</h1>
              <p className="mt-1 max-w-xl text-sm text-slate-600 dark:text-slate-300">
                {current && current.state !== 'ok' && current.state !== 'unconfigured' ? current.detail : meta.hint}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {status.downSince && (
                  <Badge tone="bad">
                    <BellRing className="size-3" /> Alerting · down for {duration(now - Date.parse(status.downSince))}
                  </Badge>
                )}
                {endpoint && (
                  <Badge>
                    <Globe className="size-3" /> {endpoint}
                  </Badge>
                )}
                {current && current.state !== 'unconfigured' && (
                  <Badge>
                    <Clock className="size-3" /> Checked {ago(current.checkedAt, now)}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {current?.state === 'unconfigured' ? (
              <Button variant="primary" onClick={goToSettings}>
                <SettingsIcon className="size-4" /> Connect server
              </Button>
            ) : (
              <Button onClick={onCheck} busy={checking}>
                {!checking && <RefreshCw className="size-4" />} Check now
              </Button>
            )}
          </div>
        </div>
      </section>

      {current?.state !== 'unconfigured' && enabledTargets === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-500/10 px-5 py-4 text-sm ring-1 ring-amber-500/30 ring-inset">
          <span className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <TriangleAlert className="size-4" /> No notification destinations are turned on, so you won't hear about
            outages.
          </span>
          <Button size="sm" variant="primary" onClick={goToSettings}>
            Add a destination
          </Button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Uptime · 24h" value={percent(status.uptime.day)} />
        <Stat label="Uptime · 7 days" value={percent(status.uptime.week)} />
        <Stat label="Alert destinations" value={String(enabledTargets)} />
        <Stat label="Next check" value={nextCheck} />
      </div>

      <Timeline segments={status.segments} now={now} />
      <AlertLog alerts={status.alerts} />
    </div>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5 dark:border-slate-800 dark:bg-slate-900/60">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

const WINDOWS = { '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;

function Timeline({ segments, now }: Readonly<{ segments: Segment[]; now: number }>) {
  const [win, setWin] = useState<keyof typeof WINDOWS>('24h');
  const span = WINDOWS[win];
  const from = now - span;
  const visible = segments.filter((s) => Date.parse(s.end) >= from);

  return (
    <Card
      title="History"
      description="Each bar is a stretch of time in one state. Grey means the monitor wasn't running."
      actions={
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
          {(Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setWin(k)}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-medium',
                win === k ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-500',
              )}
            >
              {k}
            </button>
          ))}
        </div>
      }
    >
      <div className="relative h-10 overflow-hidden rounded-lg bg-slate-200/70 dark:bg-slate-800/70">
        {visible.map((s, i) => {
          const start = Math.max(Date.parse(s.start), from);
          const next = visible[i + 1];
          // Extend each segment to the next check so consecutive segments touch.
          const end = Math.min(
            next && Date.parse(next.start) - Date.parse(s.end) < 10 * 60_000
              ? Date.parse(next.start)
              : Date.parse(s.end) + 60_000,
            now,
          );
          // Keep very short (e.g. brand-new) stretches visible inside the track.
          const width = Math.max(((end - start) / span) * 100, 0.4);
          const left = Math.min(((start - from) / span) * 100, 100 - width);
          const meta = STATE_META[s.state];
          return (
            <div
              key={s.start}
              title={`${meta.label}\n${dateTime(s.start)} → ${dateTime(s.end)}\n${s.detail}`}
              className={cx('absolute inset-y-0 transition-opacity hover:opacity-80', TONE[meta.tone].bg)}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{win === '24h' ? '24 hours ago' : '7 days ago'}</span>
        <span>now</span>
      </div>
    </Card>
  );
}

function AlertLog({ alerts }: Readonly<{ alerts: AlertLogEntry[] }>) {
  return (
    <Card title="Alerts sent" description="The notifications this monitor has sent, newest first.">
      {alerts.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          No alerts yet. Hopefully it stays that way.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {alerts.map((a) => {
            const recovered = a.kind === 'recovered';
            return (
              <li key={`${a.at}-${a.kind}`} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <div
                  className={cx(
                    'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
                    recovered
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  )}
                >
                  {recovered ? <CheckCircle2 className="size-4" /> : <BellRing className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{a.title}</p>
                    {!a.delivered && (
                      <Badge tone="warn">
                        <Send className="size-3" /> Not delivered
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm whitespace-pre-line text-slate-500 dark:text-slate-400">{a.body}</p>
                </div>
                <time className="shrink-0 text-xs text-slate-500 dark:text-slate-400" dateTime={a.at}>
                  {dateTime(a.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
