import { CheckCircle2, ChevronDown, LogIn, Server, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type PlexServerOption, type PublicSettings, type RemoteStatus } from '../api.ts';
import { STATE_META } from '../format.ts';
import { Badge, Button, Card, cx, Field, Input, useAction, useToast } from './ui.tsx';

type Flow =
  | { step: 'idle' }
  | { step: 'waiting'; pinId: number }
  | { step: 'choose'; pinId: number; servers: PlexServerOption[] };

export function PlexCard({
  settings,
  onSaved,
}: Readonly<{ settings: PublicSettings; onSaved: (s: PublicSettings) => void }>) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState(settings.plex.url);
  const [token, setToken] = useState('');
  const [test, setTest] = useState<RemoteStatus | null>(null);
  const popup = useRef<Window | null>(null);

  // Poll the PIN until the user approves in the plex.tv window.
  useEffect(() => {
    if (flow.step !== 'waiting') {
      return;
    }
    let cancelled = false;
    const started = Date.now();
    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const res = await api.checkPin(flow.pinId);
        if (cancelled) {
          return;
        }
        if (res.status === 'authorized') {
          popup.current?.close();
          if (res.servers.length === 0) {
            toast('bad', 'Signed in, but this PLEX account has no servers.');
            setFlow({ step: 'idle' });
          } else {
            setFlow({ step: 'choose', pinId: flow.pinId, servers: res.servers });
          }
          return;
        }
        if (res.status === 'expired' || Date.now() - started > 10 * 60_000) {
          toast('bad', 'Sign-in timed out. Please try again.');
          setFlow({ step: 'idle' });
          return;
        }
      } catch (err) {
        toast('bad', (err as Error).message);
        setFlow({ step: 'idle' });
        return;
      }
      setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [flow, toast]);

  const signIn = async () => {
    // Open the window synchronously so popup blockers allow it, then point it at plex.tv.
    popup.current = window.open('', 'plex-auth', 'width=600,height=720');
    const pin = await run('pin', api.createPin);
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

  const runTest = async (u?: string, t?: string) => {
    const result = await run('test', () => api.testPlex(u, t));
    if (result) {
      setTest(result);
    }
    return result;
  };

  const saveManual = async () => {
    const result = await runTest(url, token || undefined);
    if (!result || result.state === 'server_down' || result.state === 'auth_error') {
      return;
    }
    const s = await run(
      'save',
      () => api.updateSettings({ plex: { url, ...(token ? { token } : {}) } }),
      'PLEX server saved',
    );
    if (s) {
      onSaved(s);
      setManual(false);
      setToken('');
    }
  };

  const configured = settings.plex.url && settings.plex.hasToken;
  let signInLabel = 'Sign in with PLEX';
  if (flow.step === 'waiting') {
    signInLabel = 'Waiting for PLEX…';
  } else if (configured) {
    signInLabel = 'Sign in again';
  }

  return (
    <Card
      title="PLEX server"
      description="The server to monitor. Signing in with PLEX finds your server and gets a token for you."
      actions={
        configured && (
          <Button size="sm" onClick={() => runTest()} busy={busy === 'test'}>
            Test connection
          </Button>
        )
      }
    >
      {configured && flow.step === 'idle' && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-950/60">
          <Server className="size-5 text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{settings.plex.serverName || 'PLEX Media Server'}</p>
            <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{settings.plex.url}</p>
          </div>
          {test && <TestBadge status={test} />}
        </div>
      )}

      {flow.step === 'choose' ? (
        <ServerPicker
          servers={flow.servers}
          busy={busy === 'select'}
          onCancel={() => setFlow({ step: 'idle' })}
          onPick={async (server, uri) => {
            const s = await run(
              'select',
              () => api.selectServer(flow.pinId, server.id, uri, server.name),
              `Now monitoring ${server.name}`,
            );
            if (s) {
              onSaved(s);
              setFlow({ step: 'idle' });
              void runTest();
            }
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={signIn} busy={busy === 'pin' || flow.step === 'waiting'}>
            {flow.step !== 'waiting' && <LogIn className="size-4" />}
            {signInLabel}
          </Button>
          {flow.step === 'waiting' && (
            <Button variant="ghost" onClick={() => setFlow({ step: 'idle' })}>
              Cancel
            </Button>
          )}
          <Button variant="ghost" onClick={() => setManual((m) => !m)}>
            Enter address and token manually{' '}
            <ChevronDown className={cx('size-4 transition-transform', manual && 'rotate-180')} />
          </Button>
        </div>
      )}

      {manual && flow.step === 'idle' && (
        <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2 dark:border-slate-800">
          <Field label="Server address" hint="As seen from this container, e.g. http://192.168.1.10:32400">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:32400" />
          </Field>
          <Field
            label="PLEX token"
            hint={
              <>
                {settings.plex.hasToken ? 'Leave blank to keep the saved token. ' : ''}
                <a
                  className="underline"
                  href="https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/"
                  target="_blank"
                  rel="noreferrer"
                >
                  How to find it
                </a>
              </>
            }
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={settings.plex.hasToken ? '••••••••' : 'X-Plex-Token'}
              autoComplete="off"
            />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button variant="primary" onClick={saveManual} busy={busy === 'save' || busy === 'test'} disabled={!url}>
              Test and save
            </Button>
            {test && <TestBadge status={test} />}
          </div>
        </div>
      )}
    </Card>
  );
}

function connectionKind(c: { local: boolean; relay: boolean }): string {
  if (c.relay) {
    return 'Relay';
  }
  return c.local ? 'Local' : 'Remote';
}

function TestBadge({ status }: Readonly<{ status: RemoteStatus }>) {
  const meta = STATE_META[status.state];
  const reachedServer =
    status.state !== 'server_down' && status.state !== 'auth_error' && status.state !== 'unconfigured';
  return (
    <span title={status.detail}>
      <Badge tone={meta.tone}>
        {reachedServer ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
        {reachedServer ? `Connected · ${meta.label.toLowerCase()}` : meta.label}
      </Badge>
    </span>
  );
}

function ServerPicker({
  servers,
  onPick,
  onCancel,
  busy,
}: Readonly<{
  servers: PlexServerOption[];
  onPick: (server: PlexServerOption, uri: string) => void;
  onCancel: () => void;
  busy: boolean;
}>) {
  const [serverId, setServerId] = useState(servers.find((s) => s.owned)?.id ?? servers[0]!.id);
  const server = servers.find((s) => s.id === serverId)!;
  const [uri, setUri] = useState(server.connections[0]?.uri ?? '');

  useEffect(() => setUri(server.connections[0]?.uri ?? ''), [server]);

  return (
    <div className="space-y-4">
      {servers.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {servers.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setServerId(s.id)}
              className={cx(
                'rounded-lg px-3 py-2 text-sm font-medium ring-1',
                s.id === serverId ? 'bg-amber-500/10 ring-amber-500' : 'ring-slate-300 dark:ring-slate-700',
              )}
            >
              {s.name} {!s.owned && <span className="text-xs text-slate-500">(shared)</span>}
            </button>
          ))}
        </div>
      )}
      <div>
        <p className="mb-2 text-sm font-medium">How should the monitor reach {server.name}?</p>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Pick a local address: the monitor asks the server itself, and plex.tv does the remote test.
        </p>
        <div className="space-y-2">
          {server.connections.map((c) => (
            <label
              key={c.uri}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ring-1',
                uri === c.uri ? 'bg-amber-500/5 ring-amber-500' : 'ring-slate-200 dark:ring-slate-800',
              )}
            >
              <input
                type="radio"
                name="conn"
                checked={uri === c.uri}
                onChange={() => setUri(c.uri)}
                className="accent-amber-500"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.uri}</span>
              <Badge tone={c.local ? 'ok' : 'idle'}>{connectionKind(c)}</Badge>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" busy={busy} disabled={!uri} onClick={() => onPick(server, uri)}>
          Monitor this server
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
