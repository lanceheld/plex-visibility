import { useEffect, useState } from 'react';

/** Stored per browser. The inline script in index.html applies it before first paint. */
export type ThemePreference = 'dark' | 'light' | 'system';

const KEY = 'theme';
const DEFAULT: ThemePreference = 'dark';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)');

function readPreference(): ThemePreference {
  const saved = localStorage.getItem(KEY);
  return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : DEFAULT;
}

function apply(pref: ThemePreference): void {
  const dark = pref === 'system' ? systemDark().matches : pref === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPref] = useState(readPreference);

  useEffect(() => {
    apply(pref);
    if (pref !== 'system') {
      return;
    }
    // Follow the OS while "System" is chosen.
    const media = systemDark();
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref]);

  const update = (next: ThemePreference) => {
    localStorage.setItem(KEY, next);
    setPref(next);
  };
  return [pref, update];
}
