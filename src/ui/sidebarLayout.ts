// Frame of the sidebar every app shares, and the shortcut that collapses it: Cmd+B on the Mac, Ctrl+B on Windows and
// Linux. Its parts are in components/SidebarParts.tsx.
// Collapsed, the sidebar is 80 px wide: room for a short label below each icon; entries and the app icon centre
// themselves in the 60 px inside.
import { useEffect } from 'react';

export const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? '');

// The shortcut as each system writes it; `ctrl` is the Ctrl key in the interface language ("Ctrl", „Strg“).
export const shortcutLabel = (ctrl: string) => (IS_MAC ? '⌘B' : `${ctrl}+B`);

// Classes of the <nav>. Always dark: the "dark" class gives its HeroUI parts dark colours in the light theme too.
// On wide screens it stays in place while long pages scroll, so its bottom row stays visible. Both widths are whole
// numbers: a fractional one moves with the Windows scrollbar and leaves half pixels. Collapsed, it scrolls without a
// scrollbar, which on Windows and Linux would take a quarter of its width.
export const sidebarClass = (collapsed: boolean) =>
  `dark flex flex-col gap-6 overflow-x-hidden bg-zinc-900 py-5 text-zinc-200 transition-[flex-basis,padding] duration-200 ease-out md:sticky md:top-0 md:h-screen md:self-start md:overflow-y-auto ${
    collapsed ? 'flex-[0_0_80px] px-2.5 [scrollbar-width:none]' : 'flex-[1_1_240px] px-3.5 md:flex-[0_0_240px]'
  }`;

// Fades a text out while the sidebar is collapsed.
export const fadeClass = (collapsed: boolean) => `transition-opacity duration-150 ${collapsed ? 'opacity-0' : ''}`;

// Cmd+B (Ctrl+B) collapses and expands the sidebar, wherever the focus is, once per press (holding the keys does not
// repeat it). Only the system's own key counts: Ctrl+B on the Mac moves the cursor in text fields, and Windows takes
// Win+B for itself.
export function useCollapseShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [toggle]);
}
