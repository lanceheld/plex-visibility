import { ArrowLeft, KeyRound, LockKeyhole, LockKeyholeOpen, LogIn, LogOut } from 'lucide-react';
import { type SubmitEvent, type InputHTMLAttributes, useEffect, useRef, useState } from 'react';
import { api, type AuthState } from '../api.ts';
import { Button, Card, Field, Input, cx, useAction, useToast } from './ui.tsx';

const PIN_LENGTH = 6; // keep in sync with PIN_LENGTH in server/src/auth.ts
const complete = (pin: string) => pin.length === PIN_LENGTH;

/** A masked, digits-only PIN field. */
function PinInput({
  value,
  onChange,
  className,
  ...props
}: Readonly<
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: string;
    onChange: (pin: string) => void;
  }
>) {
  return (
    <Input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={PIN_LENGTH}
      pattern={String.raw`\d{${PIN_LENGTH}}`}
      placeholder={'•'.repeat(PIN_LENGTH)}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
      className={cx('text-center font-mono tracking-[0.5em]', className)}
      {...props}
    />
  );
}

export function LoginCard({ onLoggedIn }: Readonly<{ onLoggedIn: (a: AuthState) => void }>) {
  const { busy, run } = useAction();
  const [pin, setPin] = useState('');
  const [recovering, setRecovering] = useState(false);

  if (recovering) {
    return <RecoverCard onLoggedIn={onLoggedIn} onCancel={() => setRecovering(false)} />;
  }

  const login = async (value: string) => {
    const result = await run('login', () => api.login(value));
    if (result) {
      onLoggedIn(result);
    } else {
      setPin('');
    }
  };

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (complete(pin)) {
      void login(pin);
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
              <h1 className="text-lg font-semibold">Enter PIN</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Settings are protected by a PIN.</p>
            </div>
          </div>
          <PinInput
            aria-label="PIN"
            autoFocus
            value={pin}
            onChange={(next) => {
              setPin(next);
              // Submit as soon as the last digit is typed. The field stays enabled so it keeps focus for a retry.
              if (complete(next) && busy !== 'login') {
                void login(next);
              }
            }}
          />
          <Button type="submit" variant="primary" className="w-full" busy={busy === 'login'} disabled={!complete(pin)}>
            Unlock settings
          </Button>
          <p className="text-center text-xs">
            <button
              type="button"
              className="text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => setRecovering(true)}
            >
              Forgot PIN?
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
      Delete <code className="font-mono">plex-visibility/auth.json</code> in the config folder and restart to remove the
      PIN.
    </>
  );
}

/** Remove a forgotten PIN by signing in with Plex as the owner of the monitored server. */
function RecoverCard({ onLoggedIn, onCancel }: Readonly<{ onLoggedIn: (a: AuthState) => void; onCancel: () => void }>) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [waitingFor, setWaitingFor] = useState<number | null>(null);
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    api.recoveryAvailable().then(
      (r) => setAvailable(r.available),
      () => setAvailable(false),
    );
  }, []);

  // Poll the plex.tv PIN until the user approves in the plex.tv window, then remove the settings PIN.
  useEffect(() => {
    if (waitingFor === null) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const stop = (message: string) => {
      popup.current?.close();
      toast('bad', message);
      setWaitingFor(null);
    };
    const tick = async () => {
      try {
        const res = await api.checkRecovery(waitingFor);
        if (cancelled) {
          return;
        }
        if (res.status === 'verified') {
          popup.current?.close();
          const result = await api.removePinWithPlex(waitingFor);
          if (!cancelled) {
            toast('ok', 'PIN removed. You can set a new one under Security.');
            onLoggedIn(result);
          }
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
  }, [waitingFor, toast, onLoggedIn]);

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
    setWaitingFor(pin.id);
  };

  const waiting = waitingFor !== null;

  return (
    <div className="mx-auto max-w-sm pt-8">
      <Card>
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <KeyRound className="size-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Forgot PIN</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {available === false
                  ? 'Removing the PIN with Plex works once a Plex server is set up.'
                  : 'Sign in with the Plex account that owns the monitored server to remove the PIN.'}
              </p>
            </div>
          </div>

          {available && (
            <div className="space-y-2">
              <Button variant="primary" className="w-full" onClick={signIn} busy={busy === 'pin' || waiting}>
                {!waiting && <LogIn className="size-4" />}
                {waiting ? 'Waiting for Plex…' : 'Sign in with Plex'}
              </Button>
              {waiting && (
                <Button variant="ghost" className="w-full" onClick={() => setWaitingFor(null)}>
                  Cancel
                </Button>
              )}
            </div>
          )}

          {available !== null && !waiting && (
            <p className="text-center text-xs text-slate-500 dark:text-slate-400">
              {available ? 'No access to that account? ' : ''}
              <ResetByFileHint />
            </p>
          )}

          <Button variant="ghost" className="w-full" onClick={onCancel}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Set a PIN, or change or remove the current one. */
function PinForm({ pinSet, onChanged }: Readonly<{ pinSet: boolean; onChanged: (a: AuthState) => void }>) {
  const { busy, run } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = complete(confirm) && next !== confirm;
  const canSet = complete(next) && next === confirm && (!pinSet || complete(current));

  const save = async (key: string, value: string | null, success: string) => {
    const result = await run(key, () => api.setPin(pinSet ? current : undefined, value), success);
    if (result) {
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged(result);
    }
  };

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (canSet) {
      void save('set', next, pinSet ? 'PIN changed' : 'PIN set');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {pinSet && (
        <Field label="Current PIN">
          <PinInput value={current} onChange={setCurrent} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={pinSet ? 'New PIN' : 'PIN'} hint={`${PIN_LENGTH} digits`}>
          <PinInput value={next} onChange={setNext} />
        </Field>
        <Field label={pinSet ? 'Confirm new PIN' : 'Confirm PIN'} hint={mismatch ? "PINs don't match." : undefined}>
          <PinInput value={confirm} onChange={setConfirm} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy === 'set'} disabled={!canSet}>
          {pinSet ? 'Change PIN' : 'Set PIN'}
        </Button>
        {pinSet && (
          <Button
            variant="ghost"
            busy={busy === 'remove'}
            disabled={!complete(current)}
            onClick={() => save('remove', null, 'PIN removed')}
          >
            <LockKeyholeOpen className="size-4" /> Remove PIN
          </Button>
        )}
      </div>
    </form>
  );
}

export function SecurityCard({
  auth,
  onChanged,
  onLogout,
}: Readonly<{
  auth: AuthState;
  onChanged: (a: AuthState) => void;
  onLogout: () => void;
}>) {
  return (
    <Card
      title="Security"
      description={
        auth.pinSet
          ? 'Settings are protected by a PIN. Changing or removing it signs out other browsers.'
          : 'Settings are not protected. Anyone who can open this page can change them, or download a backup that includes your Plex token. Set a PIN to require it for Settings.'
      }
      actions={
        auth.pinSet && (
          <Button size="sm" variant="ghost" onClick={onLogout}>
            <LogOut className="size-4" /> Log out
          </Button>
        )
      }
    >
      <div className="max-w-sm">
        <PinForm pinSet={auth.pinSet} onChanged={onChanged} />
      </div>
    </Card>
  );
}
