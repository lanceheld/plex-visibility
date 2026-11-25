import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { History } from './history.ts';
import { AppriseClient } from './notify.ts';
import { PlexAuth } from './plexAuth.ts';
import { MonitorService } from './service.ts';
import { SettingsStore } from './settings.ts';

const env = process.env;
const dataDir = env.DATA_DIR ?? '/config/plex-visibility';
const port = Number(env.PORT ?? 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/index.js next to dist/public.
const publicDir = env.PUBLIC_DIR ?? path.resolve(here, '../public');

const settings = new SettingsStore(path.join(dataDir, 'settings.json'));
await settings.load();
const history = new History(path.join(dataDir, 'history.json'));
await history.load();

const apprise = new AppriseClient(env.APPRISE_URL ?? 'http://127.0.0.1:8000');
const service = new MonitorService({ settings, history, apprise });
const plexAuth = new PlexAuth(() => settings.get().clientId);

const app = createApp({ settings, service, apprise, plexAuth, password: env.UI_PASSWORD || undefined });
const relativePublic = path.relative(process.cwd(), publicDir);
app.use('/*', serveStatic({ root: relativePublic }));
// Single-page app: unknown non-API paths get index.html.
app.get('*', serveStatic({ root: relativePublic, path: 'index.html' }));

service.start();
const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(
    `Plex Visibility ${env.APP_VERSION ?? 'dev'} listening on http://${info.address}:${info.port} (data in ${dataDir})`,
  );
  if (!env.UI_PASSWORD) {
    console.log('UI_PASSWORD is not set: anyone who can reach this port can change settings.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    service.stop();
    server.close();
    void history.save().finally(() => process.exit(0));
  });
}
