/**
 * Admin password recovery by signing in with Plex.
 *
 * Whoever owns the monitored Plex server can set a new admin password: they
 * sign in through the same plex.tv PIN flow as Settings, and we check that the
 * account's resources include the configured server, owned rather than shared.
 * The server is identified by its machine identifier from `GET /identity`, so
 * this works whether it was set up through Plex sign-in or entered by hand.
 *
 * Recovery PINs are tracked apart from the Settings sign-in, so a PIN started
 * there can't be used here, and a recovery PIN is used up once the password is
 * set or the account turns out not to own the server.
 */
import { HTTPException } from 'hono/http-exception';
import { fetchMachineId } from './plex.ts';
import type { PlexAuth } from './plexAuth.ts';
import type { SettingsStore } from './settings.ts';
import type { RecoveryStatus } from './types.ts';

const PIN_TTL_MS = 15 * 60 * 1000; // as in plexAuth.ts
const MAX_PENDING = 10; // the routes are public; don't let them pile up plex.tv PINs

export class PasswordRecovery {
  private pins = new Map<number, { createdAt: number; verified: boolean }>();

  private plexAuth: PlexAuth;
  private settings: SettingsStore;
  private fetchImpl?: typeof fetch;

  constructor(plexAuth: PlexAuth, settings: SettingsStore, fetchImpl?: typeof fetch) {
    this.plexAuth = plexAuth;
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  /** Recovery needs a Plex server to check ownership of. */
  get available(): boolean {
    const { url, token } = this.settings.get().plex;
    return Boolean(url && token);
  }

  async start(): Promise<{ id: number; authUrl: string }> {
    if (!this.available) {
      throw new HTTPException(409, { message: 'No Plex server is set up, so recovery with Plex is not available' });
    }
    const cutoff = Date.now() - PIN_TTL_MS;
    for (const [id, pin] of this.pins) {
      if (pin.createdAt < cutoff) {
        this.drop(id);
      }
    }
    if (this.pins.size >= MAX_PENDING) {
      throw new HTTPException(429, { message: 'Too many recovery attempts in progress. Try again later.' });
    }
    const pin = await this.plexAuth.createPin();
    this.pins.set(pin.id, { createdAt: Date.now(), verified: false });
    return pin;
  }

  async check(id: number): Promise<RecoveryStatus> {
    const entry = this.pins.get(id);
    if (!entry || Date.now() - entry.createdAt > PIN_TTL_MS) {
      this.drop(id);
      return { status: 'expired' };
    }
    if (entry.verified) {
      return { status: 'verified' };
    }

    const pin = await this.plexAuth.checkPin(id);
    if (pin.status !== 'authorized') {
      if (pin.status === 'expired') {
        this.drop(id);
      }
      return pin;
    }

    const s = this.settings.get();
    let machineId: string;
    try {
      machineId = await fetchMachineId({
        url: s.plex.url,
        token: s.plex.token,
        clientId: s.clientId,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      throw new HTTPException(502, {
        message: `Can't confirm who owns the Plex server: ${(err as Error).message}`,
      });
    }
    if (pin.servers.some((server) => server.id === machineId && server.owned)) {
      entry.verified = true;
      return { status: 'verified' };
    }
    this.drop(id);
    const name = s.plex.serverName || 'the monitored Plex server';
    return { status: 'denied', error: `That Plex account doesn't own ${name}. Sign in with the owner's account.` };
  }

  /** Whether this PIN's account was confirmed as the server owner and the PIN hasn't been used. */
  verified(id: number): boolean {
    const entry = this.pins.get(id);
    return Boolean(entry?.verified && Date.now() - entry.createdAt <= PIN_TTL_MS);
  }

  /** Use up a recovery PIN. Other PINs (a Settings sign-in in progress) are left alone. */
  drop(id: number): void {
    if (this.pins.delete(id)) {
      this.plexAuth.finish(id);
    }
  }
}
