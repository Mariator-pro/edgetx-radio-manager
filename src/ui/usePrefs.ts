import { createContext, use } from 'react';
import type { Lang, Texts } from './texts.ts';
import type { Theme } from './appearance.ts';

export type { Theme };

interface Prefs {
  t: Texts;
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  sidebarCollapsed: boolean; // the sidebar shows only its icons
  toggleSidebar: () => void;
}

export const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const p = use(PrefsContext);
  if (!p) throw new Error('PrefsProvider missing');
  return p;
}
