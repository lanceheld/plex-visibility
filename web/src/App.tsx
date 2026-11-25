import { Activity, Heart, LockKeyhole, LogOut, Settings as SettingsIcon, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type AuthState, LOGGED_OUT_EVENT, type PublicSettings, type StatusResponse } from './api.ts';
import { ChangePasswordCard, LoginCard, SecurityCard } from './components/Auth.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { HeartbeatCard, MonitoringCard } from './components/MonitoringCard.tsx';
import { NotificationsCard } from './components/Notifications.tsx';
import { PlexCard } from './components/PlexCard.tsx';
import { AppearanceCard } from './components/AppearanceCard.tsx';
import { BackupCard } from './components/BackupCard.tsx';
import { cx, useAction } from './components/ui.tsx';
import { STATE_META, TONE } from './format.ts';

type Page = 'dashboard' | 'settings';
const pageFromHash = (): Page => (location.hash === '#/settings' ? 'settings' : 'dashboard');

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
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
    api.auth().then(setAuth, (err: Error) => setError(err.message));
    const onLoggedOut = () => {
      setAuth({ authenticated: false, mustChangePassword: false });
      setSettings(null);
    };
    window.addEventListener(LOGGED_OUT_EVENT, onLoggedOut);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, onLoggedOut);
  }, []);

  // Settings are admin-only: load them once logged in with a changed password.
  const canAdmin = auth?.authenticated === true && !auth.mustChangePassword;
  useEffect(() => {
    if (canAdmin) {
      api.settings().then(setSettings, (err: Error) => setError(err.message));
    }
  }, [canAdmin]);

  const logout = async () => {
    setAuth(await api.logout());
    setSettings(null);
  };

  useEffect(() => {
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
            {auth?.authenticated ? <SettingsIcon className="size-4" /> : <LockKeyhole className="size-4" />} Settings
          </NavButton>
          {auth?.authenticated && (
            <button
              type="button"
              onClick={logout}
              title="Log out"
              aria-label="Log out"
              className="rounded-lg p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              <LogOut className="size-4" />
            </button>
          )}
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

      {page === 'settings' && auth && !auth.authenticated ? (
        <LoginCard onLoggedIn={setAuth} />
      ) : page === 'settings' && auth?.mustChangePassword ? (
        <ChangePasswordCard onChanged={setAuth} />
      ) : !status || !auth || (page === 'settings' && !settings) ? (
        <div className="space-y-4">
          <div className="h-44 animate-pulse rounded-3xl bg-slate-200 dark:bg-slate-800" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
        </div>
      ) : page === 'dashboard' || !settings ? (
        <Dashboard
          status={status}
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
          <AppearanceCard />
          <BackupCard onImported={onSaved} />
          <SecurityCard onChanged={setAuth} onLogout={logout} />
        </div>
      )}

      {status && <Footer version={status.version} />}
    </div>
  );
}

const REPO = 'https://github.com/lanceheld/plex-visibility';
const DONATE_URL = 'https://venmo.com/u/lanceheld';

/** Version, linked to its commit (snapshots, e.g. 1.2.3-4-gabc1234) or the releases page. */
function Footer({ version }: { version: string }) {
  const commit = /-g([0-9a-f]{7,40})(?:-dirty)?$/.exec(version)?.[1];
  const href = commit ? `${REPO}/commit/${commit}` : version === 'dev' ? REPO : `${REPO}/releases`;
  return (
    <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>Plex Visibility</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={commit ? 'Snapshot build' : version === 'dev' ? 'Development build' : 'Release'}
        className="rounded-md bg-slate-200/70 px-1.5 py-0.5 font-mono hover:text-slate-900 dark:bg-slate-800/70 dark:hover:text-slate-100"
      >
        {version}
      </a>
      <span aria-hidden="true">·</span>
      <a
        href={DONATE_URL}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
      >
        <Heart className="size-3 text-rose-500" /> Support this project
      </a>
    </footer>
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
