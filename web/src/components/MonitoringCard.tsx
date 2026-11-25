import { HeartPulse } from 'lucide-react';
import { useState } from 'react';
import { api, type PublicSettings } from '../api.ts';
import { duration } from '../format.ts';
import { Button, Card, Field, Input, Select, useAction } from './ui.tsx';

const INTERVALS = [30, 60, 120, 300, 900];
const REMINDERS = [0, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600];

export function MonitoringCard({
  settings,
  onSaved,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
}) {
  const { busy, run } = useAction();
  const [m, setM] = useState(settings.monitor);
  const dirty = JSON.stringify(m) !== JSON.stringify(settings.monitor);

  return (
    <Card title="Monitoring" description="How often to check, and how patient to be before alerting.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Check every">
          <Select value={m.checkInterval} onChange={(e) => setM({ ...m, checkInterval: Number(e.target.value) })}>
            {[...new Set([...INTERVALS, m.checkInterval])]
              .sort((a, b) => a - b)
              .map((s) => (
                <option key={s} value={s}>
                  {duration(s * 1000)}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Alert after" hint={`About ${duration(m.checkInterval * m.failThreshold * 1000)} of downtime`}>
          <Select value={m.failThreshold} onChange={(e) => setM({ ...m, failThreshold: Number(e.target.value) })}>
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n} failed check{n > 1 ? 's' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Remind me every">
          <Select value={m.remindInterval} onChange={(e) => setM({ ...m, remindInterval: Number(e.target.value) })}>
            {[...new Set([...REMINDERS, m.remindInterval])]
              .sort((a, b) => a - b)
              .map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? 'Never' : duration(s * 1000)}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          disabled={!dirty}
          busy={busy === 'save'}
          onClick={async () => {
            const s = await run('save', () => api.updateSettings({ monitor: m }), 'Monitoring settings saved');
            if (s) {
              onSaved(s);
            }
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

export function HeartbeatCard({
  settings,
  onSaved,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
}) {
  const { busy, run } = useAction();
  const [url, setUrl] = useState(settings.heartbeatUrl);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <HeartPulse className="size-4 text-rose-500" /> Heartbeat
        </span>
      }
      description={
        <>
          If the power, this machine or your internet goes down, this monitor can't send an alert. A free{' '}
          <a className="underline" href="https://healthchecks.io" target="_blank" rel="noreferrer">
            healthchecks.io
          </a>{' '}
          check (or an Uptime Kuma push monitor) catches that: it's pinged after every check and alerts you when the
          pings stop.
        </>
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="font-mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hc-ping.com/your-check-uuid"
          spellCheck={false}
        />
        <Button
          variant="primary"
          disabled={url === settings.heartbeatUrl}
          busy={busy === 'save'}
          onClick={async () => {
            const s = await run(
              'save',
              () => api.updateSettings({ heartbeatUrl: url }),
              url ? 'Heartbeat saved' : 'Heartbeat removed',
            );
            if (s) {
              onSaved(s);
            }
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}
