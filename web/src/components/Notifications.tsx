import { ArrowLeft, BellPlus, CheckCircle2, ExternalLink, Search, Send, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type PublicSettings, type ServiceInfo } from "../api.ts";
import { Badge, Button, Card, cx, Field, Input, Modal, Toggle, useAction } from "./ui.tsx";

// Shown first in the picker: the most common ways to get an alert.
const POPULAR = ["E-Mail", "ntfy", "Pushover", "Telegram", "Discord", "Slack", "Gotify", "Microsoft Teams"];

export function NotificationsCard({ settings, onSaved }: { settings: PublicSettings; onSaved: (s: PublicSettings) => void }) {
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const { targets, notifyOnRecovery } = settings.notifications;

  const save = async (key: string, fn: () => Promise<PublicSettings>, msg?: string) => {
    const s = await run(key, fn, msg);
    if (s) onSaved(s);
  };

  const test = async (id: string) => {
    const r = await run(`test-${id}`, () => api.testTarget(id));
    if (r) setResults((prev) => ({ ...prev, [id]: r }));
  };

  return (
    <Card
      title="Notifications"
      description="Where alerts go. Add as many destinations as you like; each one gets every alert."
      actions={
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          <BellPlus className="size-4" /> Add destination
        </Button>
      }
    >
      {targets.length === 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full rounded-xl border-2 border-dashed border-slate-300 py-8 text-sm text-slate-500 hover:border-amber-500 hover:text-amber-600 dark:border-slate-700"
        >
          No destinations yet. Add email, a phone push app, or a chat service.
        </button>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {targets.map((t) => {
            const r = results[t.id];
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Toggle
                  checked={t.enabled}
                  label={`Send alerts to ${t.label}`}
                  onChange={(enabled) => save(`toggle-${t.id}`, () => api.patchTarget(t.id, { enabled }))}
                />
                <div className={cx("min-w-0 flex-1", !t.enabled && "opacity-50")}>
                  <p className="font-medium">{t.label}</p>
                  <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{t.url}</p>
                  {r && !r.ok && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{r.error}</p>}
                </div>
                {r && (
                  <Badge tone={r.ok ? "ok" : "bad"}>
                    {r.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />} {r.ok ? "Sent" : "Failed"}
                  </Badge>
                )}
                <Button size="sm" onClick={() => test(t.id)} busy={busy === `test-${t.id}`}>
                  <Send className="size-3.5" /> Test
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Remove ${t.label}`}
                  onClick={() => confirm(`Remove "${t.label}"?`) && save(`del-${t.id}`, () => api.deleteTarget(t.id), "Destination removed")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div>
          <p className="text-sm font-medium">Tell me when it's back</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Send a message when remote access is restored.</p>
        </div>
        <Toggle
          checked={notifyOnRecovery}
          label="Notify on recovery"
          onChange={(v) => save("recovery", () => api.updateSettings({ notifications: { notifyOnRecovery: v } }))}
        />
      </div>

      <AddDestination
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(s) => {
          onSaved(s);
          setAdding(false);
        }}
      />
    </Card>
  );
}

function AddDestination({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (s: PublicSettings) => void }) {
  const { busy, run } = useAction();
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ServiceInfo | null>(null);
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [test, setTest] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!open || services) return;
    api.services().then(setServices, (err: Error) => setLoadError(err.message));
  }, [open, services]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setPicked(null);
    setCustom(false);
    setUrl("");
    setLabel("");
    setTest(null);
  }, [open]);

  const list = useMemo(() => {
    if (!services) return [];
    const q = query.trim().toLowerCase();
    if (q) return services.filter((s) => s.name.toLowerCase().includes(q) || s.schemas.some((p) => p.includes(q)));
    const rank = (s: ServiceInfo) => {
      const i = POPULAR.findIndex((p) => s.name.toLowerCase().startsWith(p.toLowerCase()));
      return i === -1 ? POPULAR.length : i;
    };
    return [...services].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [services, query]);

  const choose = (s: ServiceInfo | null) => {
    setPicked(s);
    setCustom(s === null);
    setUrl(s ? `${s.schemas[0]}://` : "");
    setLabel(s?.name ?? "");
    setTest(null);
  };

  const editing = picked || custom;

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Add ${picked?.name ?? "destination"}` : "Add a destination"} wide>
      {!editing ? (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input autoFocus className="pl-9" placeholder={`Search ${services?.length ?? ""} services…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {loadError && <p className="text-sm text-rose-600">Couldn't load the service list: {loadError}</p>}
          <div className="grid max-h-[50vh] gap-1.5 overflow-y-auto sm:grid-cols-2">
            {list.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => choose(s)}
                className="flex items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ring-1 ring-slate-200 hover:bg-amber-500/5 hover:ring-amber-500 dark:ring-slate-800"
              >
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-xs text-slate-400">{s.schemas[0]}://</span>
              </button>
            ))}
            {!services && !loadError && <p className="text-sm text-slate-500">Loading services…</p>}
          </div>
          <button type="button" className="text-sm text-amber-600 underline dark:text-amber-400" onClick={() => choose(null)}>
            I already have an Apprise URL
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <button type="button" onClick={() => {
              setPicked(null);
              setCustom(false);
            }} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <ArrowLeft className="size-4" /> All services
          </button>

          {picked && (
            <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-950/60">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">URL formats</p>
                {picked.setupUrl && (
                  <a href={picked.setupUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-amber-600 underline dark:text-amber-400">
                    Setup guide <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              <ul className="space-y-1">
                {picked.templates.slice(0, 6).map((t) => (
                  <li key={t}>
                    <code className="font-mono text-xs break-all text-slate-600 dark:text-slate-300">{t.replace("{schema}", picked.schemas[0]!)}</code>
                  </li>
                ))}
              </ul>
              {picked.schemas.includes("mailto") && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  For Gmail, use an app password: <code className="font-mono">mailtos://you:app-password@gmail.com?to=you@example.com</code>
                </p>
              )}
              {picked.schemas.includes("ntfy") && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Install the ntfy app, subscribe to a hard-to-guess topic, then use <code className="font-mono">ntfys://ntfy.sh/your-topic</code>.
                </p>
              )}
            </div>
          )}

          <Field label="Name" hint="Shown in this list only.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My phone" />
          </Field>
          <Field label="Apprise URL" hint="Stored on the server and never shown in full again.">
            <Input
              autoFocus
              className="font-mono"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setTest(null);
              }}
              placeholder="mailtos://user:pass@example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {test && (
            <p className={cx("text-sm", test.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
              {test.ok ? "Test sent. Check that it arrived." : `Test failed: ${test.error}`}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button onClick={async () => setTest((await run("test", () => api.testUrl(url))) ?? null)} busy={busy === "test"} disabled={!url.includes("://")}>
              <Send className="size-4" /> Send test
            </Button>
            <Button
              variant="primary"
              busy={busy === "add"}
              disabled={!url.includes("://")}
              onClick={async () => {
                const s = await run("add", () => api.addTarget(label, url), "Destination added");
                if (s) onAdded(s);
              }}
            >
              Save destination
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
