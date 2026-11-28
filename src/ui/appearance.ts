// Light or dark: "system" follows the computer and switches along with it (also when the Mac changes on its own
// during the day); "light" and "dark" stay as chosen.
export type Theme = 'system' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export const toTheme = (v: unknown): Theme => (THEMES.includes(v as Theme) ? (v as Theme) : 'system');

// Sets the page's colours and tells `shown` which ones it got; returns a function that stops following the computer.
export function applyTheme(theme: Theme, shown?: (look: 'light' | 'dark') => void): () => void {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const set = () => {
    const dark = theme === 'dark' || (theme === 'system' && query.matches);
    document.documentElement.classList.toggle('dark', dark);
    shown?.(dark ? 'dark' : 'light');
  };
  set();
  if (theme !== 'system') return () => {};
  query.addEventListener('change', set);
  return () => query.removeEventListener('change', set);
}
