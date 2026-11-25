import { Activity, Settings as SettingsIcon, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type PublicSettings, type StatusResponse } from './api.ts';
import { Dashboard } from './components/Dashboard.tsx';
import { HeartbeatCard, MonitoringCard } from './components/MonitoringCard.tsx';
import { NotificationsCard } from './components/Notifications.tsx';
import { PlexCard } from './components/PlexCard.tsx';
import { cx, useAction } from './components/ui.tsx';
import { STATE_META, TONE } from './format.ts';

type Page = 'dashboard' | 'settings';
const pageFromHash = (): Page => (location.hash === '#/settings' ? 'settings' : 'dashboard');

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (p: Page) => {
    location.hash = p === 'settings' ? '#/settings' : '#/';
  };

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    api.settings().then(setSettings, (err: Error) => setError(err.message));
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const onSaved = (s: PublicSettings) => {
    setSettings(s);
    // The server re-checks shortly after a settings change.
    setTimeout(refresh, 1500);
  };

  const state = status?.current?.state ?? 'unconfigured';
  const tone = TONE[STATE_META[state].tone];

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <a href="#/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" className="size-8" />
          Plex Visibility
        </a>
        <nav className="flex items-center gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800/60">
          <NavButton active={page === 'dashboard'} onClick={() => go('dashboard')}>
            <span className={cx('size-2 rounded-full', tone.bg)} />
            <Activity className="size-4" /> Status
          </NavButton>
          <NavButton active={page === 'settings'} onClick={() => go('settings')}>
            <SettingsIcon className="size-4" /> Settings
          </NavButton>
        </nav>
      </header>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/30 ring-inset dark:text-rose-300">
          <TriangleAlert className="size-4" /> Can't reach the monitor: {error}
        </div>
      )}
      {status && !status.appriseReady && status.current && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-500/30 ring-inset dark:text-amber-200">
          <TriangleAlert className="size-4" /> The built-in notification service (apprise-api) isn't responding, so
          alerts can't be sent.
        </div>
      )}

      {!status || !settings ? (
        <div className="space-y-4">
          <div className="h-44 animate-pulse rounded-3xl bg-slate-200 dark:bg-slate-800" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
        </div>
      ) : page === 'dashboard' ? (
        <Dashboard
          status={status}
          settings={settings}
          checking={busy === 'check'}
          onCheck={async () => {
            const s = await run('check', api.checkNow);
            if (s) {
              setStatus(s);
            }
          }}
          goToSettings={() => go('settings')}
        />
      ) : (
        <div className="space-y-6">
          <PlexCard settings={settings} onSaved={onSaved} />
          <NotificationsCard settings={settings} onSaved={onSaved} />
          <MonitoringCard key={JSON.stringify(settings.monitor)} settings={settings} onSaved={onSaved} />
          <HeartbeatCard key={settings.heartbeatUrl} settings={settings} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-white shadow-sm dark:bg-slate-950'
          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
      )}
    >
      {children}
    </button>
  );
}
