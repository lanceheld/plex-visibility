import { KeyRound, LockKeyhole, LogOut } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type AuthState } from '../api.ts';
import { Button, Card, Field, Input, useAction } from './ui.tsx';

const MIN_LENGTH = 8; // keep in sync with MIN_PASSWORD_LENGTH in server/src/auth.ts

export function LoginCard({ onLoggedIn }: { onLoggedIn: (a: AuthState) => void }) {
  const { busy, run } = useAction();
  const [password, setPassword] = useState('');

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
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">
            Forgot it? Delete <code className="font-mono">plex-visibility/auth.json</code> in the config folder and
            restart to reset the password to <code className="font-mono">admin</code>.
          </p>
        </form>
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
