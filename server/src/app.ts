import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthStore, LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, sessionValid, sessionValue } from './auth.ts';
import type { AppriseClient } from './notify.ts';
import { fetchStatus } from './plex.ts';
import type { PlexAuth } from './plexAuth.ts';
import { PasswordRecovery } from './recovery.ts';
import type { MonitorService } from './service.ts';
import {
  exportConfig,
  parseImport,
  SettingsVersionError,
  type SettingsStore,
  settingsSchema,
  toPublic,
} from './settings.ts';
import { APP_VERSION } from './version.ts';
import type { NotifyTarget, PublicSettings, Settings } from './types.ts';

export interface AppDeps {
  settings: SettingsStore;
  service: MonitorService;
  apprise: AppriseClient;
  plexAuth: PlexAuth;
  auth: AuthStore;
  fetchImpl?: typeof fetch;
}

/**
 * Hide secrets in Apprise URLs: the password in user:pass@, and any long path
 * or host token (webhook IDs, API keys, ntfy topics). Destinations are
 * write-only from the browser, so the full URL never needs to go back to it.
 */
export function maskUrl(url: string): string {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/)([^?#]*)/i);
  if (!m) {
    return '••••';
  }
  const [, scheme, rest] = m;
  const mask = (part: string) => (part.length > 8 ? `${part.slice(0, 3)}•••` : part);
  const [authority, ...pathParts] = rest!.split('/');
  let shownAuthority = authority!;
  const at = shownAuthority.lastIndexOf('@');
  if (at >= 0) {
    const [user, pass] = shownAuthority.slice(0, at).split(':');
    shownAuthority = `${user}${pass !== undefined ? ':•••' : ''}@${shownAuthority.slice(at + 1)}`;
  } else {
    shownAuthority = mask(shownAuthority);
  }
  return `${scheme}${[shownAuthority, ...pathParts.map(mask)].join('/')}`;
}

export function publicSettings(s: Settings): PublicSettings {
  const p = toPublic(s);
  // Build new objects: `p` shares nested objects with the live settings.
  return {
    ...p,
    notifications: { ...p.notifications, targets: p.notifications.targets.map((t) => ({ ...t, url: maskUrl(t.url) })) },
  };
}

const settingsUpdate = z
  .object({
    plex: settingsSchema.shape.plex.partial(),
    monitor: settingsSchema.shape.monitor.partial(),
    notifications: z.object({ notifyOnRecovery: z.boolean() }).partial(),
    heartbeatUrl: settingsSchema.shape.heartbeatUrl,
  })
  .partial()
  .strict();

const newTarget = z.object({
  label: z.string().trim().max(80).default(''),
  url: settingsSchema.shape.notifications.shape.targets.element.shape.url,
});

const targetPatch = z
  .object({ label: z.string().trim().max(80), enabled: z.boolean() })
  .partial()
  .strict();

const testMessage = {
  title: 'Plex Visibility test',
  body: 'If you can read this, Plex remote access alerts will reach you here.',
} as const;

/** Routes anyone can use: the read-only status page, logging in, and password recovery. */
const PUBLIC_API = new Set(['/api/status', '/api/check', '/api/auth', '/api/auth/login', '/api/auth/logout']);
const RECOVER = '/api/auth/recover';
const isPublic = (path: string) => PUBLIC_API.has(path) || path === RECOVER || path.startsWith(`${RECOVER}/`);

export function createApp(deps: AppDeps): Hono {
  const { settings, service, apprise, plexAuth, auth } = deps;
  const app = new Hono();
  const limiter = new LoginLimiter();
  const recovery = new PasswordRecovery(plexAuth, settings, deps.fetchImpl);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof SettingsVersionError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') }, 400);
    }
    console.error(err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });

  app.get('/healthz', (c) => c.text('ok'));

  // Changes must be JSON, which a cross-site form can't send without a CORS preflight.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ error: 'Expected a JSON request' }, 415);
    }
    await next();
  });

  // --- admin sessions ---
  const isLoggedIn = async (c: Context) =>
    sessionValid(await getSignedCookie(c, auth.secret, SESSION_COOKIE), auth.version);

  const startSession = (c: Context) =>
    setSignedCookie(c, SESSION_COOKIE, sessionValue(auth.version), auth.secret, {
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
      maxAge: SESSION_TTL_MS / 1000,
    });

  // Everything except the public routes needs an admin session, and a changed default password.
  app.use('/api/*', async (c, next) => {
    if (isPublic(c.req.path)) {
      return next();
    }
    if (!(await isLoggedIn(c))) {
      return c.json({ error: 'Please log in' }, 401);
    }
    if (auth.mustChange && c.req.path !== '/api/auth/password') {
      return c.json({ error: 'Change the default password first', mustChangePassword: true }, 403);
    }
    return next();
  });

  app.get('/api/auth', async (c) => {
    const authenticated = await isLoggedIn(c);
    return c.json({ authenticated, mustChangePassword: authenticated && auth.mustChange });
  });

  app.post('/api/auth/login', async (c) => {
    const key = clientAddress(c);
    const wait = limiter.lockedFor(key);
    if (wait > 0) {
      return c.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.` }, 429);
    }
    const { password } = await body(c, z.object({ password: z.string().max(1024) }));
    if (!(await auth.verify(password))) {
      limiter.fail(key);
      return c.json({ error: 'Incorrect password' }, 401);
    }
    limiter.succeed(key);
    await startSession(c);
    return c.json({ authenticated: true, mustChangePassword: auth.mustChange });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ authenticated: false, mustChangePassword: false });
  });

  app.post('/api/auth/password', async (c) => {
    const { current, next } = await body(c, z.object({ current: z.string().max(1024), next: z.string().max(1024) }));
    if (!(await auth.verify(current))) {
      return c.json({ error: 'Current password is incorrect' }, 400);
    }
    const problem = await auth.checkNewPassword(next);
    if (problem) {
      return c.json({ error: problem }, 400);
    }
    await auth.setPassword(next);
    // The new password version signs out other sessions; keep this one.
    await startSession(c);
    return c.json({ authenticated: true, mustChangePassword: false });
  });

  // --- password recovery: sign in with Plex as the owner of the monitored server ---
  app.get(RECOVER, (c) => c.json({ available: recovery.available }));

  app.post(`${RECOVER}/pin`, async (c) => c.json(await recovery.start()));

  app.get(`${RECOVER}/pin/:id`, async (c) => c.json(await recovery.check(Number(c.req.param('id')))));

  app.post(RECOVER, async (c) => {
    const { pinId, next } = await body(c, z.object({ pinId: z.number(), next: z.string().max(1024) }));
    if (!recovery.verified(pinId)) {
      throw new HTTPException(410, { message: 'Sign-in expired. Please sign in with Plex again.' });
    }
    const problem = await auth.checkNewPassword(next);
    if (problem) {
      return c.json({ error: problem }, 400);
    }
    recovery.drop(pinId);
    await auth.setPassword(next);
    // As with a change, the new password version signs out every other session.
    await startSession(c);
    console.log(`Admin password reset by signing in with Plex (from ${clientAddress(c)})`);
    const targets = settings.get().notifications.targets.filter((t) => t.enabled);
    void apprise
      .notifyAll(
        targets,
        'Plex Visibility admin password reset',
        "The admin password was reset by signing in with the Plex server owner's account. If this wasn't you, sign in to Plex and change your Plex password, then reset the admin password again.",
        'warning',
      )
      .catch((err: Error) => console.error(`Could not send the password reset notice: ${err.message}`));
    return c.json({ authenticated: true, mustChangePassword: false });
  });

  const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) =>
    schema.parse(await c.req.json().catch(() => ({}))) as z.infer<T>;

  const targetById = (id: string): NotifyTarget => {
    const target = settings.get().notifications.targets.find((t) => t.id === id);
    if (!target) {
      throw new HTTPException(404, { message: 'No such destination' });
    }
    return target;
  };

  const saveTargets = async (targets: NotifyTarget[]) => {
    const s = await settings.update({ notifications: { targets } });
    return publicSettings(s);
  };

  // --- status ---
  app.get('/api/status', (c) => c.json(service.snapshot()));
  app.post('/api/check', async (c) => {
    await service.checkNow();
    return c.json(service.snapshot());
  });

  // --- settings ---
  app.get('/api/settings', (c) => c.json(publicSettings(settings.get())));
  app.put('/api/settings', async (c) => {
    const update = await body(c, settingsUpdate);
    return c.json(publicSettings(await settings.update(update)));
  });

  // --- notification destinations ---
  app.get('/api/services', async (c) => c.json(await apprise.listServices()));

  app.post('/api/targets', async (c) => {
    const { label, url } = await body(c, newTarget);
    const target: NotifyTarget = { id: randomUUID(), label: label || url.split('://')[0]!, url, enabled: true };
    return c.json(await saveTargets([...settings.get().notifications.targets, target]));
  });

  app.patch('/api/targets/:id', async (c) => {
    const patch = await body(c, targetPatch);
    const target = targetById(c.req.param('id'));
    const targets = settings.get().notifications.targets.map((t) => (t.id === target.id ? { ...t, ...patch } : t));
    return c.json(await saveTargets(targets));
  });

  app.delete('/api/targets/:id', async (c) => {
    const target = targetById(c.req.param('id'));
    return c.json(await saveTargets(settings.get().notifications.targets.filter((t) => t.id !== target.id)));
  });

  app.post('/api/targets/:id/test', async (c) => {
    const target = targetById(c.req.param('id'));
    const [result] = await apprise.notifyAll([target], testMessage.title, testMessage.body, 'info');
    return c.json(result);
  });

  // Test a URL before saving it.
  app.post('/api/targets/test', async (c) => {
    const { url } = await body(c, newTarget.pick({ url: true }));
    return c.json(await apprise.notifyOne(url, testMessage.title, testMessage.body, 'info'));
  });

  // --- backup ---
  // POST rather than GET: the export holds secrets, so it goes through the JSON-only guard above.
  app.post('/api/config/export', (c) => {
    const date = new Date().toISOString().slice(0, 10);
    c.header('Content-Disposition', `attachment; filename="plex-visibility-config-${date}.json"`);
    return c.json(exportConfig(settings.get(), APP_VERSION));
  });

  app.post('/api/config/import', async (c) => {
    const next = parseImport(await c.req.json().catch(() => null), settings.get());
    return c.json(publicSettings(await settings.replace(next)));
  });

  // --- Plex connection ---
  app.post('/api/plex/test', async (c) => {
    const given = await body(c, z.object({ url: z.string().optional(), token: z.string().optional() }));
    const s = settings.get();
    const status = await fetchStatus({
      url: given.url?.trim() || s.plex.url,
      token: given.token?.trim() || s.plex.token,
      clientId: s.clientId,
      fetchImpl: deps.fetchImpl,
    });
    return c.json(status);
  });

  app.post('/api/plex/pin', async (c) => c.json(await plexAuth.createPin()));

  app.get('/api/plex/pin/:id', async (c) => c.json(await plexAuth.checkPin(Number(c.req.param('id')))));

  app.post('/api/plex/pin/:id/select', async (c) => {
    const pinId = Number(c.req.param('id'));
    const { serverId, uri, name } = await body(
      c,
      z.object({ serverId: z.string(), uri: z.string().url(), name: z.string().default('') }),
    );
    const token = plexAuth.serverToken(pinId, serverId);
    if (!token) {
      throw new HTTPException(410, { message: 'Sign-in expired. Please sign in with Plex again.' });
    }
    const s = await settings.update({ plex: { url: uri, token, serverName: name } });
    plexAuth.finish(pinId);
    return c.json(publicSettings(s));
  });

  return app;
}

/** The caller's address, for rate limiting. Proxies' X-Forwarded-For is ignored because it can be forged. */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
