// Parts of the sidebar every app shares: the header with the button that collapses it, entries, groups and the
// theme switch; frame and the shortcut in sidebarLayout.ts. They work the same on macOS, Windows and Linux.
// The app keeps its own Sidebar.tsx with its content and whether it is collapsed (saved with its other choices);
// texts come in from its texts.
import { Button, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import type { ReactNode } from 'react';
import { THEMES, type Theme } from '../appearance.ts';
import { fadeClass, shortcutLabel } from '../sidebarLayout.ts';

// A window with the sidebar on the left.
const SidebarIcon = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

// App icon, name and version, and the button that collapses the sidebar. Collapsed, the button takes the place of the
// icon while the pointer is over it or it has the keyboard focus; on a touch screen (no hover) it always does.
export function SidebarHeader(props: {
  collapsed: boolean;
  onToggle: () => void;
  name: string;
  version: string;
  texts: { collapse: string; expand: string; ctrl: string }; // ctrl: the Ctrl key as written on Windows and Linux
}) {
  const { collapsed, onToggle, name, version, texts } = props;
  const label = collapsed ? texts.expand : texts.collapse;
  return (
    <div className={`group relative flex min-h-8 items-center gap-2.5 transition-[padding] duration-200 ${collapsed ? 'px-[15px]' : 'px-2'}`}>
      <img src="/favicon.svg" alt="" className={`size-[30px] shrink-0 transition-opacity ${collapsed ? 'group-hover:opacity-0 group-has-focus-visible:opacity-0 pointer-coarse:opacity-0' : ''}`} />
      <span className={`flex flex-col whitespace-nowrap ${fadeClass(collapsed)}`}>
        <span className="font-semibold text-white">{name}</span>
        <span className="text-xs text-zinc-400">v{version}</span>
      </span>
      <Tooltip delay={300} closeDelay={0}>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={label}
          onPress={onToggle}
          className={`shrink-0 text-zinc-400 ${collapsed ? 'absolute left-[14px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100' : 'ml-auto'}`}
        >
          <SidebarIcon />
        </Button>
        <Tooltip.Content placement={collapsed ? 'right' : 'bottom'} offset={collapsed ? 14 : 6}>
          {label} <kbd className="ml-1 font-sans text-muted">{shortcutLabel(texts.ctrl)}</kbd>
        </Tooltip.Content>
      </Tooltip>
    </div>
  );
}

// One entry. Collapsed, only its icon shows (with the short name below it, if any, for entries that share an icon)
// and its label and note move into a tooltip. `mark` draws a status dot or badge: next to the label, collapsed on
// the icon with the class it gets.
export function NavItem(props: {
  collapsed: boolean;
  active: boolean;
  icon: ReactNode;
  label: ReactNode;
  name?: string; // what a screen reader says when collapsed, if the label is not plain text
  short?: string;
  mark?: (className: string) => ReactNode;
  note?: ReactNode; // second line of the tooltip
  onPress: () => void;
}) {
  const { collapsed, active, icon, label, name, short, mark, note, onPress } = props;
  const look = active ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-white';
  return (
    <Tooltip isDisabled={!collapsed} delay={300} closeDelay={0}>
      {/* a HeroUI button, as the tooltip needs a trigger that handles presses; the classes replace its own look */}
      <Button
        variant="ghost"
        onPress={onPress}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? (name ?? (typeof label === 'string' ? label : undefined)) : undefined}
        className={`h-auto w-full min-w-0 justify-start gap-2.5 overflow-hidden rounded-xl py-2.5 text-left text-base font-normal transition-[padding,background-color,color] duration-200 data-[pressed=true]:scale-100 ${collapsed ? 'px-4' : 'px-2.5'} ${look}`}
      >
        <span className="relative flex w-7 shrink-0 flex-col items-center">
          {icon}
          {short && (
            <span
              aria-hidden="true"
              className={`text-[9.5px] leading-none font-semibold whitespace-nowrap transition-all duration-200 ${active ? 'text-white' : 'text-zinc-400'} ${collapsed ? 'mt-1 h-2.5 opacity-100' : 'h-0 opacity-0'}`}
            >
              {short}
            </span>
          )}
          {collapsed && mark?.('absolute -top-1 right-0 ring-2 ring-zinc-900')}
        </span>
        <span className={`min-w-0 flex-1 truncate ${fadeClass(collapsed)}`}>{label}</span>
        {!collapsed && mark?.('')}
      </Button>
      <Tooltip.Content placement="right" offset={12}>
        <span className="flex flex-col">
          <span>{name ?? label}</span>
          {note && <span className="text-xs text-muted">{note}</span>}
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

// A group of entries under a small heading; collapsed, a line stands in for the heading.
export function NavGroup({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactNode }) {
  return (
    <div className="relative flex flex-col gap-0.5">
      <span className={`px-2 pb-1.5 text-[11px] font-medium tracking-wider whitespace-nowrap text-zinc-400 uppercase ${fadeClass(collapsed)}`}>{label}</span>
      <span aria-hidden="true" className={`absolute inset-x-2.5 top-2 h-px bg-zinc-700 transition-opacity duration-150 ${collapsed ? '' : 'opacity-0'}`} />
      {children}
    </div>
  );
}

const SunIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MoonIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
);
const MonitorIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);
const THEME_ICON: Record<Theme, ReactNode> = { light: <SunIcon />, dark: <MoonIcon />, system: <MonitorIcon /> };

// Light, dark or system. Expanded three toggle buttons; collapsed one button that shows the current choice and
// switches to the next (button-variants.md).
export function ThemeSwitch(props: {
  collapsed: boolean;
  theme: Theme;
  onChange: (theme: Theme) => void;
  texts: { theme: string; light: string; dark: string; system: string; switchTo: (next: string) => string };
}) {
  const { collapsed, theme, onChange, texts } = props;
  const label: Record<Theme, string> = { light: texts.light, dark: texts.dark, system: texts.system };
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  return (
    <div className={`flex items-center gap-2 ${collapsed ? 'justify-center' : 'px-1'}`}>
      {collapsed ? (
        <Tooltip delay={300} closeDelay={0}>
          <Button variant="ghost" isIconOnly aria-label={`${texts.theme}: ${label[theme]}`} onPress={() => onChange(next)} className="text-zinc-300">
            {THEME_ICON[theme]}
          </Button>
          <Tooltip.Content placement="right" offset={14}>
            <span className="flex flex-col">
              <span>
                {texts.theme}: {label[theme]}
              </span>
              <span className="text-xs text-muted">{texts.switchTo(label[next])}</span>
            </span>
          </Tooltip.Content>
        </Tooltip>
      ) : (
        <ToggleButtonGroup
          aria-label={texts.theme}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([theme])}
          onSelectionChange={(keys) => {
            const v = [...keys][0];
            if (v) onChange(String(v) as Theme);
          }}
        >
          {THEMES.map((k) => (
            <ToggleButton key={k} id={k} isIconOnly aria-label={label[k]}>
              {THEME_ICON[k]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
    </div>
  );
}
