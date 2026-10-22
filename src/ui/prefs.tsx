import { useEffect, useState } from 'react';
import { TEXTS, type Lang } from './texts.ts';
import { PrefsContext, type Theme } from './usePrefs.ts';

// Per-browser choices; unreadable storage just means the system default every time.
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    // private window or blocked storage
  }
  return fallback;
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not storable: the choice holds for this session only
  }
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(() =>
    stored('radio-manager:lang', ['en', 'de'] as const, navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    stored('radio-manager:theme', ['light', 'dark'] as const, window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    store('radio-manager:lang', lang);
  }, [lang]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    store('radio-manager:theme', theme);
  }, [theme]);
  return <PrefsContext value={{ t: TEXTS[lang], lang, setLang, theme, setTheme }}>{children}</PrefsContext>;
}
