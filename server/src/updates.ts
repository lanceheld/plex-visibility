import type { UpdateInfo } from './types.ts';

export const RELEASES_API = 'https://api.github.com/repos/lanceheld/plex-visibility/releases/latest';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

interface Version {
  core: [number, number, number];
  /** Pre-release identifiers (e.g. ['rc', '1']); empty for a release. */
  pre: string[];
}

/**
 * Parse a release version (1.2.3, v1.2.3, 1.3.0-rc.1) or a snapshot's
 * `git describe` (1.2.3-4-gabc1234, optionally -dirty). A snapshot counts as
 * the release it was built after: it's ahead of 1.2.3 but behind 1.2.4.
 * Returns null for anything else, such as `dev`.
 */
export function parseVersion(raw: string): Version | null {
  const v = raw
    .trim()
    .replace(/^v/, '')
    .replace(/-\d+-g[0-9a-f]{7,40}(?:-dirty)?$/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) {
    return null;
  }
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = a.core[i]! - b.core[i]!;
    if (d !== 0) {
      return d;
    }
  }
  return comparePreRelease(a.pre, b.pre);
}

function comparePreRelease(a: string[], b: string[]): number {
  // A pre-release is older than its release.
  if (!a.length || !b.length) {
    return b.length - a.length;
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareIdentifier(a[i]!, b[i]!);
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
}

/** Numbers compare numerically and sort before words, which compare as text. */
function compareIdentifier(x: string, y: string): number {
  const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
  if (xn && yn) {
    return Number(x) - Number(y);
  }
  if (xn !== yn) {
    return xn ? -1 : 1;
  }
  if (x === y) {
    return 0;
  }
  return x < y ? -1 : 1;
}

export interface UpdateCheckerOptions {
  currentVersion: string;
  /** Set to false to never contact GitHub. */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Checks GitHub for the latest published release (drafts and pre-releases
 * aren't returned by /releases/latest) twice a day, and remembers the answer.
 */
export class UpdateChecker {
  private readonly current: string;
  private readonly currentParsed: Version | null;
  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  private latest: { version: string; url: string } | null = null;
  private checkedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: UpdateCheckerOptions) {
    this.current = opts.currentVersion;
    this.currentParsed = parseVersion(opts.currentVersion);
    // A development build has no version to compare.
    this.enabled = (opts.enabled ?? true) && this.currentParsed !== null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? console.log;
  }

  start(): void {
    if (this.enabled && !this.timer) {
      this.schedule(0);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delay: number) {
    this.timer = setTimeout(async () => {
      const ok = await this.check();
      if (this.timer) {
        this.schedule(ok ? CHECK_INTERVAL_MS : RETRY_MS);
      }
    }, delay);
    this.timer.unref();
  }

  /** Ask GitHub now. Returns whether it answered. */
  async check(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    try {
      const res = await this.fetchImpl(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'plex-visibility' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) {
        // No releases published yet.
        this.latest = null;
      } else if (res.ok) {
        const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
        const version = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : '';
        const url =
          typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/') ? data.html_url : '';
        this.latest = parseVersion(version) && url ? { version, url } : null;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
      this.checkedAt = new Date().toISOString();
      return true;
    } catch (err) {
      this.log(`Could not check for updates: ${(err as Error).message}`);
      return false;
    }
  }

  info(): UpdateInfo {
    const latest = this.latest;
    const parsedLatest = latest && parseVersion(latest.version);
    const available = !!parsedLatest && !!this.currentParsed && compareVersions(parsedLatest, this.currentParsed) > 0;
    return {
      enabled: this.enabled,
      current: this.current,
      latest: latest?.version ?? null,
      url: latest?.url ?? null,
      available,
      checkedAt: this.checkedAt,
    };
  }
}
