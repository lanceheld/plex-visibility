import { Download, ShieldAlert, Upload } from 'lucide-react';
import { useRef } from 'react';
import { api, type PublicSettings } from '../api.ts';
import { Button, Card, useAction, useToast } from './ui.tsx';

export function BackupCard({ onImported }: Readonly<{ onImported: (s: PublicSettings) => void }>) {
  const { busy, run } = useAction();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const exportConfig = () =>
    run('export', async () => {
      const config = await api.exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `plex-visibility-config-${config.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    });

  const importFile = async (file: File) => {
    let config: unknown;
    try {
      config = JSON.parse(await file.text());
    } catch {
      toast('bad', `${file.name} isn't a valid JSON file.`);
      return;
    }
    if (!confirm('Replace all current settings with the ones in this file?')) {
      return;
    }
    const s = await run('import', () => api.importConfig(config), 'Configuration imported');
    if (s) {
      onImported(s);
    }
  };

  return (
    <Card
      title="Backup"
      description="Save all settings to a file, or restore them on this or another install. Check history isn't included."
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={exportConfig} busy={busy === 'export'}>
          {busy !== 'export' && <Download className="size-4" />} Export configuration
        </Button>
        <Button onClick={() => fileInput.current?.click()} busy={busy === 'import'}>
          {busy !== 'import' && <Upload className="size-4" />} Import configuration
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // allow picking the same file again
            if (file) {
              void importFile(file);
            }
          }}
        />
      </div>
      <p className="mt-4 flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        The exported file contains your Plex token and full notification URLs, including any passwords in them. Keep it
        somewhere private.
      </p>
    </Card>
  );
}
