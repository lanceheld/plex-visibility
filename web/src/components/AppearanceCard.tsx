import { Monitor, Moon, Sun } from 'lucide-react';
import { type ThemePreference, useTheme } from '../theme.ts';
import { Card, cx } from './ui.tsx';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

export function AppearanceCard() {
  const [theme, setTheme] = useTheme();
  return (
    <Card title="Appearance" description="Saved in this browser only.">
      <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onClick={() => setTheme(value)}
            className={cx(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              theme === value
                ? 'bg-white shadow-sm dark:bg-slate-950'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
    </Card>
  );
}
