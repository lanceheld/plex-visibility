import { ArrowLeft, KeyRound, LockKeyhole, LogIn, LogOut } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, type AuthState } from '../api.ts';
import { Button, Card, Field, Input, useAction, useToast } from './ui.tsx';

const MIN_LENGTH = 8; // keep in sync with MIN_PASSWORD_LENGTH in server/src/auth.ts

export function LoginCard({ onLoggedIn }: { onLoggedIn: (a: AuthState) => void }) {
  const { busy, run } = useAction();
  const [password, setPassword] = useState('');
  const [recovering, setRecovering] = useState(false);

  if (recovering) {
    return <RecoverCard onLoggedIn={onLoggedIn} onCancel={() => setRecovering(false)} />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run('login', () => api.login(password));
    if (result) {
      onLoggedIn(result);
    } else {
      setPassword('');
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-8">
      <Card>
        <form onSubmit={submit} className="space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <LockKeyhole className="size-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Admin login</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Settings are password protected.</p>
            </div>
          </div>
          {/* Username field for password managers; there is only one admin account. */}
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
          <Field label="Password">
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" className="w-full" busy={busy === 'login'} disabled={!password}>
            Log in
          </Button>
          <p className="text-center text-xs">
            <button
              type="button"
              className="text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => setRecovering(true)}
            >
              Forgot password?
            </button>
          </p>
        </form>
      </Card>
    </div>
  );
}

function ResetByFileHint() {
  return (
    <>
      Delete <code className="font-mono">plex-visibility/auth.json</code> in the config folder and restart to reset the
      password to <code className="font-mono">admin</code>.
    </>
  );
}

type Recovery = { step: 'idle' } | { step: 'waiting'; pinId: number } | { step: 'verified'; pinId: number };

/** Reset the password by signing in with Plex as the owner of the monitored server. */
function RecoverCard({ onLoggedIn, onCancel }: { onLoggedIn: (a: AuthState) => void; onCancel: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [flow, setFlow] = useState<Recovery>({ step: 'idle' });
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    api.recoveryAvailable().then(
      (r) => setAvailable(r.available),
      () => setAvailable(false),
    );
  }, []);

  // Poll the PIN until the user approves in the plex.tv window.
  useEffect(() => {
    if (flow.step !== 'waiting') {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const stop = (message: string) => {
      popup.current?.close();
      toast('bad', message);
      setFlow({ step: 'idle' });
    };
    const tick = async () => {
      try {
        const res = await api.checkRecovery(flow.pinId);
        if (cancelled) {
          return;
        }
        if (res.status === 'verified') {
          popup.current?.close();
          setFlow({ step: 'verified', pinId: flow.pinId });
        } else if (res.status === 'denied') {
          stop(res.error);
        } else if (res.status === 'expired' || Date.now() - started > 10 * 60_000) {
          stop('Sign-in timed out. Please try again.');
        } else {
          timer = setTimeout(tick, 2000);
        }
      } catch (err) {
        if (!cancelled) {
          stop((err as Error).message);
        }
      }
    };
    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, toast]);

  const signIn = async () => {
    // Open the window synchronously so popup blockers allow it, then point it at plex.tv.
    popup.current = window.open('', 'plex-auth', 'width=600,height=720');
    const pin = await run('pin', api.startRecovery);
    if (!pin) {
      popup.current?.close();
      return;
    }
    if (popup.current) {
      popup.current.location.href = pin.authUrl;
    } else {
      window.open(pin.authUrl, '_blank');
    }
    setFlow({ step: 'waiting', pinId: pin.id });
  };

  const mismatch = confirm !== '' && next !== confirm;
  const tooShort = next !== '' && next.length < MIN_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (flow.step !== 'verified') {
      return;
    }
    const result = await run('reset', () => api.recover(flow.pinId, next), 'Password reset');
    if (result) {
      onLoggedIn(result);
    } else {
      // A rejected password keeps the sign-in; an expired sign-in means starting over.
      const status = await api.checkRecovery(flow.pinId).catch(() => null);
      if (status?.status !== 'verified') {
        setFlow({ step: 'idle' });
      }
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-8">
      <Card>
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <KeyRound className="size-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Reset admin password</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {flow.step === 'verified'
                  ? 'Signed in as the server owner. Choose a new password.'
                  : available === false
                    ? 'Reset with Plex works once a Plex server is set up.'
                    : 'Sign in with the Plex account that owns the monitored server.'}
              </p>
            </div>
          </div>

          {flow.step === 'verified' ? (
            <form onSubmit={submit} className="space-y-4">
              <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
              <Field label="New password" hint={tooShort ? `Use at least ${MIN_LENGTH} characters.` : undefined}>
                <Input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </Field>
              <Field label="Confirm new password" hint={mismatch ? "Passwords don't match." : undefined}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                busy={busy === 'reset'}
                disabled={!next || next !== confirm || next.length < MIN_LENGTH}
              >
                Set password and log in
              </Button>
            </form>
          ) : available ? (
            <div className="space-y-2">
              <Button
                variant="primary"
                className="w-full"
                onClick={signIn}
                busy={busy === 'pin' || flow.step === 'waiting'}
              >
                {flow.step !== 'waiting' && <LogIn className="size-4" />}
                {flow.step === 'waiting' ? 'Waiting for Plex…' : 'Sign in with Plex'}
              </Button>
              {flow.step === 'waiting' && (
                <Button variant="ghost" className="w-full" onClick={() => setFlow({ step: 'idle' })}>
                  Cancel
                </Button>
              )}
            </div>
          ) : null}

          {available !== null && flow.step === 'idle' && (
            <p className="text-center text-xs text-slate-500 dark:text-slate-400">
              {available ? 'No access to that account? ' : ''}
              <ResetByFileHint />
            </p>
          )}

          <Button variant="ghost" className="w-full" onClick={onCancel}>
            <ArrowLeft className="size-4" /> Back to login
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ChangePasswordForm({ onChanged, submitLabel }: { onChanged: (a: AuthState) => void; submitLabel: string }) {
  const { busy, run } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = confirm !== '' && next !== confirm;
  const tooShort = next !== '' && next.length < MIN_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run('change', () => api.changePassword(current, next), 'Password changed');
    if (result) {
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged(result);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
      <Field label="Current password">
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password" hint={tooShort ? `Use at least ${MIN_LENGTH} characters.` : undefined}>
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new password" hint={mismatch ? "Passwords don't match." : undefined}>
        <Input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        busy={busy === 'change'}
        disabled={!current || !next || next !== confirm || next.length < MIN_LENGTH}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

/** Shown after the first login with the default password; nothing else is reachable until it's changed. */
export function ChangePasswordCard({ onChanged }: { onChanged: (a: AuthState) => void }) {
  return (
    <div className="mx-auto max-w-md pt-8">
      <Card
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="size-4 text-amber-500" /> Set an admin password
          </span>
        }
        description={
          <>
            You're using the default password <code className="font-mono">admin</code>. Choose a new one to continue.
          </>
        }
      >
        <ChangePasswordForm onChanged={onChanged} submitLabel="Set password and continue" />
      </Card>
    </div>
  );
}

export function SecurityCard({ onChanged, onLogout }: { onChanged: (a: AuthState) => void; onLogout: () => void }) {
  return (
    <Card
      title="Security"
      description="Change the admin password. Other browsers that are logged in will be signed out."
      actions={
        <Button size="sm" variant="ghost" onClick={onLogout}>
          <LogOut className="size-4" /> Log out
        </Button>
      }
    >
      <div className="max-w-sm">
        <ChangePasswordForm onChanged={onChanged} submitLabel="Change password" />
      </div>
    </Card>
  );
}
