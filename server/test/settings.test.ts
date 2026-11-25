import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  exportConfig,
  migrate,
  parseImport,
  SCHEMA_VERSION,
  SettingsStore,
  SettingsVersionError,
} from '../src/settings.ts';

describe('migrate', () => {
  // A pretend history: v1 had `interval`, v2 renamed it to `checkInterval`, v3 added `extra`.
  const migrations = {
    1: ({ interval, ...rest }: Record<string, unknown>) => ({ ...rest, checkInterval: interval }),
    2: (s: Record<string, unknown>) => ({ ...s, extra: true }),
  };

  it('runs each step from the file’s version up to the current one', () => {
    expect(migrate({ interval: 60 }, 1, migrations, 3)).toEqual({ checkInterval: 60, extra: true });
    expect(migrate({ checkInterval: 60 }, 2, migrations, 3)).toEqual({ checkInterval: 60, extra: true });
    expect(migrate({ checkInterval: 60, extra: true }, 3, migrations, 3)).toEqual({ checkInterval: 60, extra: true });
  });

  it('refuses newer formats, unknown versions, and gaps in the chain', () => {
    expect(() => migrate({}, 4, migrations, 3)).toThrow(/newer version of PLEX Visibility.*Update PLEX Visibility/);
    expect(() => migrate({}, 0, migrations, 3)).toThrow(SettingsVersionError);
    expect(() => migrate({}, Number.NaN, migrations, 3)).toThrow(/Unknown settings format/);
    expect(() => migrate({}, 1, { 1: migrations[1] }, 3)).toThrow(/No migration from settings format 2 to 3/);
  });
});

describe('import versions', () => {
  const current = defaultSettings();
  const settings = { monitor: { checkInterval: 120 } };

  it('exports the current format version', () => {
    expect(exportConfig(current, '1.2.3').schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('treats files without a format version as format 1', () => {
    expect(parseImport({ app: 'plex-visibility', settings }, current).monitor.checkInterval).toBe(120);
  });

  it('rejects files from a newer format', () => {
    const newer = { app: 'plex-visibility', schemaVersion: SCHEMA_VERSION + 1, settings };
    expect(() => parseImport(newer, current)).toThrow(SettingsVersionError);
    expect(() => parseImport({ ...newer, schemaVersion: 'two' }, current)).toThrow(SettingsVersionError);
  });
});

describe('SettingsStore format version', () => {
  const tempFile = async () => path.join(await mkdtemp(path.join(tmpdir(), 'pv-settings-')), 'settings.json');

  it('writes the format version, and upgrades files written before it existed', async () => {
    const file = await tempFile();
    const legacy = { ...defaultSettings(), heartbeatUrl: 'https://hc-ping.com/x' };
    await writeFile(file, JSON.stringify(legacy));

    const store = new SettingsStore(file);
    const loaded = await store.load({});
    expect(loaded.heartbeatUrl).toBe('https://hc-ping.com/x');
    expect(loaded.clientId).toBe(legacy.clientId);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('refuses to load a newer format and leaves the file alone', async () => {
    const file = await tempFile();
    const newer = JSON.stringify({ ...defaultSettings(), schemaVersion: SCHEMA_VERSION + 1 });
    await writeFile(file, newer);
    await expect(new SettingsStore(file).load({})).rejects.toThrow(/newer version of PLEX Visibility/);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
