import { Button, Spinner, Tooltip } from '@heroui/react';
import type { ProgressEvent, RadioView, StateView } from '../../server/api.ts';
import { dateTime } from '../dates.ts';
import { sidebarClass } from '../sidebarLayout.ts';
import { usePrefs } from '../usePrefs.ts';
import { ConnectedRadios } from './ConnectedRadios.tsx';
import { AppUpdateIcon, BackupsIcon, ModelsIcon, PackagesIcon, RadiosIcon, RefreshIcon, SettingsIcon, SourcesIcon, UsbBusyIcon } from './icons.tsx';
import { NavGroup, NavItem, SidebarHeader, ThemeSwitch } from './SidebarParts.tsx';

// "RadioMaster TX16S MK3": the maker is the first word. Below it the radio's label without the maker.
const maker = (type: string) => (type.includes(' ') ? type.slice(0, type.indexOf(' ')) : '');
const withoutMaker = (label: string, type: string) => (maker(type) && label.startsWith(`${maker(type)} `) ? label.slice(maker(type).length + 1) : label);

export type Page = 'radio' | 'update' | 'flash' | 'sources' | 'packages' | 'radios' | 'backups' | 'restore' | 'models' | 'modelsFlow' | 'settings';

export function Sidebar(props: {
  state?: StateView;
  progress?: ProgressEvent;
  page: Page;
  volume?: string;
  preparing?: string; // the card a flow is reading for its plan
  onNavigate: (page: Page, volume?: string) => void;
  onDownload: () => void;
  onAppUpdate: () => void;
}) {
  const { state, progress, page, volume, preparing, onNavigate, onDownload, onAppUpdate } = props;
  const appUpdate = state?.appUpdate;
  const updatingApp = state?.busy === 'appUpdate';
  const { t, theme, setTheme, sidebarCollapsed: collapsed, toggleSidebar } = usePrefs();
  const downloading = state?.busy === 'download';
  // what the app keeps for all radios, then what it keeps from each radio; settings sit at the bottom
  const groups = [
    {
      title: t.library,
      items: [
        { page: 'sources' as const, label: t.sources, Icon: SourcesIcon },
        { page: 'packages' as const, label: t.packages, Icon: PackagesIcon },
        { page: 'radios' as const, label: t.radios, Icon: RadiosIcon },
      ],
    },
    {
      title: t.radioData,
      items: [
        { page: 'backups' as const, label: t.backups, Icon: BackupsIcon },
        { page: 'models' as const, label: t.models, Icon: ModelsIcon },
      ],
    },
  ];
  // the guided flows count as part of the page they start from
  const current = (target: Page) => page === target || (page === 'restore' && target === 'backups') || (page === 'modelsFlow' && target === 'models');
  const progressText = progress?.op === 'download' && progress.source
    ? progress.file
      ? `${progress.source}: ${progress.file}`
      : t.checkingSource(progress.source)
    : t.checking;
  // the radio's short name below its icon in the collapsed sidebar: the first word without the maker
  const short = (label: string, type: string) => withoutMaker(label, type).split(' ')[0]!.slice(0, 7);
  const appUpdateText = appUpdate
    ? appUpdate.restarting
      ? t.appRestarting
      : updatingApp
        ? t.appDownloading(progress?.op === 'appUpdate' ? (progress.done ?? 0) : 0)
        : t.appUpdateAvailable(appUpdate.version)
    : '';
  const checkText = downloading ? progressText : state?.lastCheck ? `${t.lastChecked} ${dateTime(state.lastCheck, t.locale)}` : t.notChecked;
  return (
    <nav aria-label={t.nav} className={sidebarClass(collapsed)}>
      <SidebarHeader
        collapsed={collapsed}
        onToggle={toggleSidebar}
        name="Radio Manager"
        version={__APP_VERSION__}
        texts={{ collapse: t.collapseSidebar, expand: t.expandSidebar, ctrl: t.ctrlKey }}
      />

      {appUpdate &&
        (collapsed ? (
          <div className="flex justify-center">
            <Tooltip delay={300} closeDelay={0}>
              {appUpdate.installable ? (
                <Button variant="primary" isIconOnly aria-label={appUpdateText} isDisabled={!!state?.busy || appUpdate.restarting} onPress={onAppUpdate}>
                  {updatingApp || appUpdate.restarting ? <Spinner size="sm" color="current" /> : <AppUpdateIcon />}
                </Button>
              ) : (
                // a button, as the tooltip needs a trigger that handles presses
                <Button variant="ghost" isIconOnly aria-label={`${appUpdateText}: ${t.appUpdateDownload}`} className="text-accent" onPress={() => window.open(appUpdate.url, '_blank', 'noreferrer')}>
                  <AppUpdateIcon />
                </Button>
              )}
              <Tooltip.Content placement="right" offset={14}>
                <span className="flex flex-col">
                  <span>{appUpdateText}</span>
                  {!updatingApp && !appUpdate.restarting && <span className="text-xs text-muted">{appUpdate.installable ? t.appUpdateClick : t.appUpdateLink}</span>}
                </span>
              </Tooltip.Content>
            </Tooltip>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
            <span className="text-xs text-zinc-300">{appUpdateText}</span>
            {appUpdate.installable ? (
              <Button variant="primary" isDisabled={!!state?.busy || appUpdate.restarting} onPress={onAppUpdate}>
                {(updatingApp || appUpdate.restarting) && <Spinner size="sm" color="current" />}
                {t.appUpdateInstall}
              </Button>
            ) : (
              <a href={appUpdate.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent no-underline hover:underline">
                {t.appUpdateDownload}
              </a>
            )}
          </div>
        ))}

      <NavGroup collapsed={collapsed} label={t.radioHeading}>
        {collapsed ? (
          state?.radios.length === 0 && (
            <NavItem
              collapsed
              active={false}
              icon={
                <span className="text-zinc-500">
                  <RadiosIcon />
                </span>
              }
              label={t.noRadioConnected}
              short={t.sidebarShort.noRadio}
              note={t.noRadio}
              onPress={() => {}}
            />
          )
        ) : (
          <ConnectedRadios radios={state?.radios} text={t.noRadio}>
            {(radios) => radios.map((r) => radioItem(r))}
          </ConnectedRadios>
        )}
        {collapsed && state?.radios.map((r) => radioItem(r))}
      </NavGroup>

      {groups.map((g) => (
        <NavGroup key={g.title} collapsed={collapsed} label={g.title}>
          {g.items.map(({ page: target, label, Icon }) => (
            <NavItem key={target} collapsed={collapsed} active={current(target)} icon={<Icon />} label={label} short={t.sidebarShort[target]} onPress={() => onNavigate(target)} />
          ))}
        </NavGroup>
      ))}

      <div className="mt-auto flex flex-col gap-3">
        <NavItem collapsed={collapsed} active={current('settings')} icon={<SettingsIcon />} label={t.settings} short={t.sidebarShort.settings} onPress={() => onNavigate('settings')} />
        <ThemeSwitch
          collapsed={collapsed}
          theme={theme}
          onChange={setTheme}
          texts={{ theme: t.theme, light: t.light, dark: t.dark, system: t.systemTheme, switchTo: t.switchTheme }}
        />

        {collapsed ? (
          <div className="flex justify-center">
            <Tooltip delay={300} closeDelay={0}>
              <Button variant="outline" isIconOnly className="text-white" aria-label={t.checkUpdates} isDisabled={!!state?.busy} onPress={onDownload}>
                <RefreshIcon size={16} className={downloading ? 'animate-spin' : ''} />
              </Button>
              <Tooltip.Content placement="right" offset={14}>
                <span className="flex max-w-60 flex-col">
                  <span>{t.checkUpdates}</span>
                  <span className="text-xs text-muted [overflow-wrap:anywhere]">{checkText}</span>
                </span>
              </Tooltip.Content>
            </Tooltip>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
            {/* always two lines high, so the box keeps its size while file names change during a check */}
            <span className="line-clamp-2 h-8 text-xs text-zinc-400 [overflow-wrap:anywhere]">
              {downloading ? progressText : state?.lastCheck ? <>{t.lastChecked}<br />{dateTime(state.lastCheck, t.locale)}</> : t.notChecked}
            </span>
            <Button variant="outline" className="text-white" isDisabled={!!state?.busy} onPress={onDownload}>
              {downloading ? <Spinner size="sm" color="current" /> : <RefreshIcon size={16} />}
              {t.checkUpdates}
            </Button>
          </div>
        )}
      </div>
    </nav>
  );

  // A connected radio: its icon in green. Expanded its maker, name and type beside it; collapsed the number of
  // updates beside the icon. While the app uses the card the USB symbol says to keep it connected (collapsed in
  // place of the icon), 28 px in both.
  function radioItem(r: RadioView) {
    const active = (page === 'radio' || page === 'update') && volume === r.volume;
    const busy = r.checking || preparing === r.volume || state?.busyVolume === r.volume;
    const updates = r.updates.length;
    return (
      <NavItem
        key={r.volume}
        collapsed={collapsed}
        active={active}
        icon={collapsed && busy ? <UsbBusyIcon size={28} className="m-0! size-7! shrink-0" /> : <RadiosIcon className="text-green-400" />}
        name={maker(r.name) ? `${maker(r.name)} ${withoutMaker(r.label, r.name)}` : r.label}
        short={short(r.label, r.name)}
        label={
          <span className="flex min-w-0 flex-col">
            {maker(r.name) && <span className="truncate text-xs text-zinc-400">{maker(r.name)}</span>}
            <span className="truncate font-semibold">{withoutMaker(r.label, r.name)}</span>
            <span className="truncate font-mono text-xs text-zinc-400">{r.board ?? t.typeUnknown}</span>
          </span>
        }
        note={
          <>
            {r.board ?? t.typeUnknown}
            {busy ? <span className="block text-amber-400">{t.keepConnected}</span> : updates > 0 && <span className="block text-amber-400">{t.updatesReady(updates)}</span>}
          </>
        }
        mark={(className) =>
          className ? (
            <>
              {busy ? (
                <span className="sr-only">{t.keepConnected}</span>
              ) : (
                updates > 0 && (
                  // beside the icon, not on it (the shared position is for small dots)
                  <span className="absolute -top-2 -right-3 grid h-4 min-w-4 place-items-center rounded-full bg-amber-400 px-1 text-[10.5px] font-bold text-zinc-900 ring-2 ring-zinc-900" aria-hidden="true">
                    {updates}
                  </span>
                )
              )}
            </>
          ) : busy ? (
            <>
              {/* the entry is a HeroUI button, which makes every icon in it 16 px */}
              <UsbBusyIcon size={28} className="m-0! size-7! shrink-0" />
              <span className="sr-only">{t.keepConnected}</span>
            </>
          ) : (
            updates > 0 && (
              <>
                <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-zinc-900" aria-hidden="true">
                  {updates}
                </span>
                <span className="sr-only">{t.updatesReady(updates)}</span>
              </>
            )
          )
        }
        onPress={() => onNavigate('radio', r.volume)}
      />
    );
  }
}
