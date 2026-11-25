import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, parseVersion, RELEASES_API, UpdateChecker } from '../src/updates.ts';

const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));

describe('parseVersion', () => {
  it('reads releases, pre-releases and snapshots', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion('v1.2.3')).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion('1.3.0-rc.1')).toEqual({ core: [1, 3, 0], pre: ['rc', '1'] });
    // A snapshot counts as the release it was built after.
    expect(parseVersion('1.2.3-4-gabc1234')).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion('1.2.3-4-gabc1234-dirty')).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion('1.3.0-rc.1-2-gabc1234')).toEqual({ core: [1, 3, 0], pre: ['rc', '1'] });
    expect(parseVersion('0.0.0-12-gabc1234')).toEqual({ core: [0, 0, 0], pre: [] });
  });

  it('rejects anything else', () => {
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, minor and patch', () => {
    expect(cmp('1.2.4', '1.2.3')).toBe(1);
    expect(cmp('1.10.0', '1.9.9')).toBe(1);
    expect(cmp('2.0.0', '1.99.99')).toBe(1);
    expect(cmp('1.2.3', '1.2.3')).toBe(0);
    expect(cmp('1.2.3', '1.2.4')).toBe(-1);
  });

  it('puts pre-releases before their release', () => {
    expect(cmp('1.3.0', '1.3.0-rc.1')).toBe(1);
    expect(cmp('1.3.0-rc.2', '1.3.0-rc.1')).toBe(1);
    expect(cmp('1.3.0-rc.10', '1.3.0-rc.9')).toBe(1);
    expect(cmp('1.3.0-rc.1', '1.3.0-beta.5')).toBe(1);
    expect(cmp('1.3.0-rc', '1.3.0-1')).toBe(1);
    expect(cmp('1.3.0-rc.1.1', '1.3.0-rc.1')).toBe(1);
  });
});

function fakeGitHub(response: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(String(input));
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const release = (tag: string) =>
  Response.json({ tag_name: tag, html_url: `https://github.com/lanceheld/plex-visibility/releases/tag/${tag}` });

describe('UpdateChecker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a newer release', async () => {
    const gh = fakeGitHub(() => release('v1.3.0'));
    const checker = new UpdateChecker({ currentVersion: '1.2.3', fetchImpl: gh.fetchImpl, log: () => {} });
    expect(checker.info()).toMatchObject({ enabled: true, available: false, latest: null, checkedAt: null });
    expect(await checker.check()).toBe(true);
    expect(gh.calls).toEqual([RELEASES_API]);
    expect(checker.info()).toMatchObject({
      enabled: true,
      current: '1.2.3',
      latest: '1.3.0',
      url: 'https://github.com/lanceheld/plex-visibility/releases/tag/v1.3.0',
      available: true,
    });
    expect(checker.info().checkedAt).toEqual(expect.any(String));
  });

  it('reports no update when running the latest release or a snapshot after it', async () => {
    for (const current of ['1.3.0', '1.3.0-4-gabc1234', '1.4.0']) {
      const checker = new UpdateChecker({
        currentVersion: current,
        fetchImpl: fakeGitHub(() => release('v1.3.0')).fetchImpl,
        log: () => {},
      });
      await checker.check();
      expect(checker.info().available).toBe(false);
    }
  });

  it('offers a release to snapshots built after older releases or before any release', async () => {
    for (const current of ['1.2.3-4-gabc1234', '0.0.0-12-gabc1234', '1.3.0-rc.1']) {
      const checker = new UpdateChecker({
        currentVersion: current,
        fetchImpl: fakeGitHub(() => release('v1.3.0')).fetchImpl,
        log: () => {},
      });
      await checker.check();
      expect(checker.info().available).toBe(true);
    }
  });

  it('never contacts GitHub for a development build or when turned off', async () => {
    for (const opts of [{ currentVersion: 'dev' }, { currentVersion: '1.2.3', enabled: false }]) {
      const gh = fakeGitHub(() => release('v9.9.9'));
      const checker = new UpdateChecker({ ...opts, fetchImpl: gh.fetchImpl });
      checker.start();
      expect(await checker.check()).toBe(false);
      checker.stop();
      expect(gh.calls).toEqual([]);
      expect(checker.info()).toMatchObject({ enabled: false, available: false });
    }
  });

  it('treats no releases yet as nothing newer', async () => {
    const checker = new UpdateChecker({
      currentVersion: '0.0.0-1-gabc1234',
      fetchImpl: fakeGitHub(() => new Response('{}', { status: 404 })).fetchImpl,
    });
    expect(await checker.check()).toBe(true);
    expect(checker.info()).toMatchObject({ latest: null, available: false });
  });

  it('logs failures and keeps the last good answer', async () => {
    let fail = false;
    const log = vi.fn();
    const checker = new UpdateChecker({
      currentVersion: '1.2.3',
      fetchImpl: fakeGitHub(() => (fail ? new Response('', { status: 403 }) : release('v1.3.0'))).fetchImpl,
      log,
    });
    await checker.check();
    fail = true;
    expect(await checker.check()).toBe(false);
    expect(log).toHaveBeenCalledWith('Could not check for updates: HTTP 403');
    expect(checker.info()).toMatchObject({ latest: '1.3.0', available: true });
  });

  it('ignores a release with an unusable tag or link', async () => {
    for (const body of [
      { tag_name: 'nightly', html_url: 'https://github.com/x' },
      { tag_name: 'v2.0.0', html_url: 'javascript:alert(1)' },
      {},
    ]) {
      const checker = new UpdateChecker({
        currentVersion: '1.2.3',
        fetchImpl: fakeGitHub(() => Response.json(body)).fetchImpl,
      });
      await checker.check();
      expect(checker.info()).toMatchObject({ latest: null, url: null, available: false });
    }
  });

  it('checks on start, then on a schedule until stopped', async () => {
    vi.useFakeTimers();
    const gh = fakeGitHub(() => release('v1.3.0'));
    const checker = new UpdateChecker({ currentVersion: '1.2.3', fetchImpl: gh.fetchImpl });
    checker.start();
    checker.start(); // a second start doesn't add a second schedule
    await vi.advanceTimersByTimeAsync(0);
    expect(gh.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(gh.calls).toHaveLength(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(gh.calls).toHaveLength(2);
  });

  it('retries sooner after a failure', async () => {
    vi.useFakeTimers();
    const gh = fakeGitHub(() => new Response('', { status: 500 }));
    const checker = new UpdateChecker({ currentVersion: '1.2.3', fetchImpl: gh.fetchImpl, log: () => {} });
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(gh.calls).toHaveLength(2);
    checker.stop();
  });
});
