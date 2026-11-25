import { describe, expect, it } from 'vitest';
import { fetchStatus, parseAccount } from '../src/plex.ts';

describe('parseAccount', () => {
  it('treats mapped as reachable', () => {
    const s = parseAccount({ signInState: 'ok', mappingState: 'mapped', publicAddress: '1.2.3.4', publicPort: 32400 });
    expect(s.state).toBe('ok');
    expect(s.publicPort).toBe('32400');
  });

  it('reports the reason when mapping failed', () => {
    const s = parseAccount({ signInState: 'ok', mappingState: 'failed', mappingErrorMessage: 'Port 32400 closed' });
    expect(s.state).toBe('unreachable');
    expect(s.detail).toContain('Port 32400 closed');
  });

  it('treats missing mapping as unreachable', () => {
    expect(parseAccount({ signInState: 'ok' }).state).toBe('unreachable');
  });

  it('detects a signed-out server', () => {
    expect(parseAccount({ signInState: 'none', mappingState: 'unknown' }).state).toBe('signed_out');
  });
});

const respond = (body: string, init: ResponseInit = {}) =>
  (async () =>
    new Response(body, { headers: { 'content-type': 'application/json' }, ...init })) as unknown as typeof fetch;

const opts = { url: 'http://plex:32400/', token: 'tok', clientId: 'cid' };

describe('fetchStatus', () => {
  it('reads JSON wrapped in MyPlex and sends the token', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ MyPlex: { signInState: 'ok', mappingState: 'mapped' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    expect((await fetchStatus({ ...opts, fetchImpl })).state).toBe('ok');
    expect(seen?.url).toBe('http://plex:32400/myplex/account');
    expect(seen?.headers['X-Plex-Token']).toBe('tok');
  });

  it('falls back to XML', async () => {
    const xml = '<?xml version="1.0"?><MyPlex signInState="ok" mappingState="failed" mappingError="unreachable" />';
    const fetchImpl = (async () =>
      new Response(xml, { headers: { 'content-type': 'text/xml' } })) as unknown as typeof fetch;
    expect((await fetchStatus({ ...opts, fetchImpl })).state).toBe('unreachable');
  });

  it('reports a connection error as server_down', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    }) as unknown as typeof fetch;
    const s = await fetchStatus({ ...opts, fetchImpl });
    expect(s.state).toBe('server_down');
    expect(s.detail).toContain('ECONNREFUSED');
  });

  it('reports 401 as auth_error', async () => {
    expect((await fetchStatus({ ...opts, fetchImpl: respond('', { status: 401 }) })).state).toBe('auth_error');
  });

  it('is unconfigured without a URL or token', async () => {
    expect((await fetchStatus({ ...opts, token: '' })).state).toBe('unconfigured');
  });
});
