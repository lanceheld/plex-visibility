/**
 * Ask the Plex server for its remote access status.
 *
 * Plex tests its own reachability: plex.tv regularly connects back to the
 * server's public address and port and records the result. The server reports
 * that at `GET /myplex/account`, the data behind Settings > Remote Access.
 *   signInState          "ok" when signed in to plex.tv
 *   mappingState         "mapped" when reachable; also "unknown", "waiting", "failed"
 *   mappingErrorMessage  why it isn't reachable
 *   publicAddress/Port   what plex.tv tested
 */
import type { RemoteStatus } from './types.ts';
import { stripTrailingSlashes } from './url.ts';
import { APP_VERSION } from './version.ts';

export const PLEX_HEADERS = {
  'X-Plex-Product': 'Plex Visibility',
  'X-Plex-Version': APP_VERSION,
  Accept: 'application/json',
};

type Account = Record<string, unknown>;

/** A non-empty string, number or boolean as a string; anything else (objects included) as undefined. */
const str = (v: unknown): string | undefined =>
  (typeof v === 'string' && v !== '') || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

export function parseAccount(account: Account, checkedAt = new Date()): RemoteStatus {
  const signIn = str(account.signInState)?.toLowerCase();
  const mapping = str(account.mappingState)?.toLowerCase();
  const error = str(account.mappingErrorMessage) ?? str(account.mappingError);
  const base = {
    mappingState: mapping,
    publicAddress: str(account.publicAddress),
    publicPort: str(account.publicPort),
    checkedAt: checkedAt.toISOString(),
  };

  if (signIn && signIn !== 'ok') {
    return { ...base, state: 'signed_out', detail: `Server is not signed in to plex.tv (signInState=${signIn})` };
  }
  if (mapping === 'mapped') {
    return { ...base, state: 'ok', detail: 'Fully accessible outside your network' };
  }
  let detail = `Not reachable from outside your network (mappingState=${mapping ?? 'missing'})`;
  if (error) {
    detail += `: ${error}`;
  }
  return { ...base, state: 'unreachable', detail };
}

/** Plex answers in JSON when asked; fall back to reading XML attributes. */
function decode(body: string, contentType: string): Account {
  if (contentType.includes('json')) {
    const data = JSON.parse(body) as Record<string, unknown>;
    for (const key of ['MyPlex', 'MediaContainer']) {
      const inner = data[key];
      if (inner && typeof inner === 'object') {
        return inner as Account;
      }
    }
    return data;
  }
  const tag = /<MyPlex\b([^>]*)\/?>/.exec(body);
  if (!tag) {
    throw new Error('no <MyPlex> element in response');
  }
  const attrs: Account = {};
  for (const [, key, value] of tag[1]!.matchAll(/\b(\w+)="([^"]*)"/g)) {
    attrs[key!] = value;
  }
  return attrs;
}

export interface FetchOptions {
  url: string;
  token: string;
  clientId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchStatus(opts: FetchOptions): Promise<RemoteStatus> {
  const checkedAt = new Date().toISOString();
  const fail = (state: RemoteStatus['state'], detail: string): RemoteStatus => ({ state, detail, checkedAt });
  if (!opts.url || !opts.token) {
    return fail('unconfigured', 'No PLEX server has been set up yet');
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${stripTrailingSlashes(opts.url)}/myplex/account`, {
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': opts.token, 'X-Plex-Client-Identifier': opts.clientId },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    return fail('server_down', `Could not connect to PLEX at ${opts.url}: ${cause}`);
  }

  if (response.status === 401 || response.status === 403) {
    return fail('auth_error', `PLEX rejected the token (HTTP ${response.status}). Sign in again in Settings.`);
  }
  if (!response.ok) {
    return fail('server_down', `PLEX returned HTTP ${response.status}`);
  }
  try {
    return parseAccount(decode(await response.text(), response.headers.get('content-type') ?? ''), new Date(checkedAt));
  } catch (err) {
    return fail('server_down', `Unexpected response from PLEX: ${(err as Error).message}`);
  }
}

/**
 * The server's machine identifier, from `GET /identity`. It matches the
 * `clientIdentifier` plex.tv lists for the server among an account's resources.
 */
export async function fetchMachineId(opts: FetchOptions): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${stripTrailingSlashes(opts.url)}/identity`, {
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': opts.token, 'X-Plex-Client-Identifier': opts.clientId },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    throw new Error(`Could not connect to PLEX at ${opts.url}: ${cause}`);
  }
  if (!response.ok) {
    throw new Error(`PLEX returned HTTP ${response.status}`);
  }
  const body = await response.text();
  const id = (response.headers.get('content-type') ?? '').includes('json')
    ? str((JSON.parse(body) as { MediaContainer?: Account }).MediaContainer?.machineIdentifier)
    : /\bmachineIdentifier="([^"]+)"/.exec(body)?.[1];
  if (!id) {
    throw new Error('PLEX did not report a machine identifier');
  }
  return id;
}
