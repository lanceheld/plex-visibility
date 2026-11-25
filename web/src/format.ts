import { CheckCircle2, CircleDashed, KeyRound, LogOut, ServerCrash, XCircle } from 'lucide-react';
import type { State } from './api.ts';

export const STATE_META: Record<
  State,
  { label: string; tone: 'ok' | 'bad' | 'warn' | 'idle'; icon: typeof CheckCircle2; hint: string }
> = {
  ok: {
    label: 'Reachable',
    tone: 'ok',
    icon: CheckCircle2,
    hint: 'Your server can be reached from outside your network.',
  },
  unreachable: {
    label: 'Not reachable remotely',
    tone: 'bad',
    icon: XCircle,
    hint: "Plex is running, but plex.tv can't connect to it. Check port forwarding, UPnP, or whether your public IP changed.",
  },
  signed_out: {
    label: 'Signed out of plex.tv',
    tone: 'warn',
    icon: LogOut,
    hint: "The server isn't signed in to plex.tv, so remote access can't work. Sign the server back in from Plex settings.",
  },
  server_down: {
    label: 'Server not responding',
    tone: 'bad',
    icon: ServerCrash,
    hint: "The monitor can't reach your Plex server. It may be stopped, or its address may have changed.",
  },
  auth_error: {
    label: "Can't sign in to server",
    tone: 'warn',
    icon: KeyRound,
    hint: "Plex rejected the monitor's token. Sign in with Plex again in Settings.",
  },
  unconfigured: {
    label: 'Not set up yet',
    tone: 'idle',
    icon: CircleDashed,
    hint: 'Connect your Plex server in Settings to start monitoring.',
  },
};

export const TONE = {
  ok: {
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500',
    soft: 'bg-emerald-500/10 ring-emerald-500/30',
  },
  bad: { text: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-500', soft: 'bg-rose-500/10 ring-rose-500/30' },
  warn: { text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500', soft: 'bg-amber-500/10 ring-amber-500/30' },
  idle: { text: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-400', soft: 'bg-slate-500/10 ring-slate-500/20' },
} as const;

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  }
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  return ms < 5000 ? 'just now' : `${duration(ms)} ago`;
}

export function percent(v: number | null): string {
  if (v === null) {
    return '—';
  }
  if (v === 1) {
    return '100%';
  }
  return `${(Math.floor(v * 1000) / 10).toFixed(1)}%`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
