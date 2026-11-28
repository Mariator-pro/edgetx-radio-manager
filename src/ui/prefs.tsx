import { useCallback, useEffect, useRef, useState } from 'react';
import { PREFS_META, type PrefsView } from '../server/api.ts';
import { post } from './api.ts';
import { LANGUAGES, TEXTS, type Lang } from './texts.ts';
import { applyTheme, toTheme } from './appearance.ts';
import { useCollapseShortcut } from './sidebarLayout.ts';
import { PrefsContext, type Theme } from './usePrefs.ts';

// The choices the server keeps and puts into the page. The port changes with every start, and the browser
// keeps what a page stores per port, so its own storage would forget them.
function served(): PrefsView {
  try {
    return JSON.parse(document.querySelector<HTMLMetaElement>(`meta[name="${PREFS_META}"]`)?.content ?? '{}') as PrefsView;
  } catch {
    return {};
  }
}

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

// Kept for the next start; if that fails, the choice holds until the page is loaded again.
const save = (prefs: PrefsView) => void post('/api/prefs', prefs).catch(() => {});

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [initial] = useState(served);
  const [lang, setLang] = useState<Lang>(() => pick(initial.lang, LANGUAGES.map((l) => l.id), 'en'));
  const [theme, setTheme] = useState<Theme>(() => toTheme(initial.theme));
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => applyTheme(theme), [theme]);
  const chooseLang = (l: Lang) => {
    setLang(l);
    save({ lang: l });
  };
  const chooseTheme = (t: Theme) => {
    setTheme(t);
    save({ theme: t });
  };
  // Cmd+B (Ctrl+B on Windows and Linux) switches too
  const [collapsed, setCollapsed] = useState(() => initial.sidebarCollapsed === true);
  const collapsedNow = useRef(collapsed);
  const toggleSidebar = useCallback(() => {
    collapsedNow.current = !collapsedNow.current;
    setCollapsed(collapsedNow.current);
    save({ sidebarCollapsed: collapsedNow.current });
  }, []);
  useCollapseShortcut(toggleSidebar);
  return (
    <PrefsContext value={{ t: TEXTS[lang], lang, setLang: chooseLang, theme, setTheme: chooseTheme, sidebarCollapsed: collapsed, toggleSidebar }}>
      {children}
    </PrefsContext>
  );
}
