import { CircleArrowUp, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type UpdateInfo } from '../api.ts';

/** The release this browser dismissed the banner for; a newer release shows it again. */
const DISMISSED_KEY = 'dismissedUpdate';
/** The server checks GitHub twice a day; asking it hourly picks that up without a reload. */
const POLL_MS = 60 * 60 * 1000;

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY));

  useEffect(() => {
    // Best-effort: a failed check just means no banner.
    const load = () => api.update().then(setInfo, () => {});
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  if (!info?.available || !info.latest || info.latest === dismissed) {
    return null;
  }

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, info.latest!);
    setDismissed(info.latest);
  };

  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-2 rounded-xl bg-sky-500/10 px-4 py-3 text-sm text-sky-800 ring-1 ring-sky-500/30 ring-inset dark:text-sky-200"
    >
      <CircleArrowUp className="size-4 shrink-0" />
      <span className="grow">
        PLEX Visibility <strong>{info.latest}</strong> is available. You're running {info.current}.
      </span>
      {info.url && (
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
          What's new <ExternalLink className="size-3.5" />
        </a>
      )}
      <button
        type="button"
        onClick={dismiss}
        title="Dismiss until the next release"
        aria-label="Dismiss until the next release"
        className="shrink-0 rounded-md p-1 hover:bg-sky-500/15"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
