import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AuthStore } from './auth.ts';
import { createApp } from './app.ts';
import { History } from './history.ts';
import { AppriseClient } from './notify.ts';
import { PlexAuth } from './plexAuth.ts';
import { MonitorService } from './service.ts';
import { SettingsStore } from './settings.ts';
import { APP_VERSION } from './version.ts';

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

const auth = new AuthStore(path.join(dataDir, 'auth.json'));
await auth.load();

const apprise = new AppriseClient(env.APPRISE_URL ?? 'http://127.0.0.1:8000');
const service = new MonitorService({ settings, history, apprise });
const plexAuth = new PlexAuth(() => settings.get().clientId);

const app = createApp({ settings, service, apprise, plexAuth, auth });
const relativePublic = path.relative(process.cwd(), publicDir);
app.use('/*', serveStatic({ root: relativePublic }));
// Single-page app: unknown non-API paths get index.html.
app.get('*', serveStatic({ root: relativePublic, path: 'index.html' }));

service.start();
const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`Plex Visibility ${APP_VERSION} listening on http://${info.address}:${info.port} (data in ${dataDir})`);
  if (!auth.pinSet) {
    console.log('No settings PIN is set, so anyone who can open the web UI can change settings.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    service.stop();
    server.close();
    void history.save().finally(() => process.exit(0));
  });
}
