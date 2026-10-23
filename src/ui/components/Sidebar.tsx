import { Button, Spinner, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import type { ProgressEvent, StateView } from '../../server/api.ts';
import { dateTime } from '../format.ts';
import type { Lang } from '../texts.ts';
import { usePrefs, type Theme } from '../usePrefs.ts';
import { BackupsIcon, MoonIcon, PackagesIcon, RadioIcon, RefreshIcon, SourcesIcon, SunIcon } from './icons.tsx';

export type Page = 'radio' | 'update' | 'flash' | 'sources' | 'packages' | 'backups' | 'restore';

export function Sidebar(props: {
  state?: StateView;
  progress?: ProgressEvent;
  page: Page;
  volume?: string;
  onNavigate: (page: Page, volume?: string) => void;
  onDownload: () => void;
}) {
  const { state, progress, page, volume, onNavigate, onDownload } = props;
  const { t, lang, setLang, theme, setTheme } = usePrefs();
  const downloading = state?.busy === 'download';
  const overview = [
    { page: 'sources' as const, label: t.sources, Icon: SourcesIcon },
    { page: 'packages' as const, label: t.packages, Icon: PackagesIcon },
    { page: 'backups' as const, label: t.backups, Icon: BackupsIcon },
  ];
  const progressText = progress?.op === 'download' && progress.source
    ? progress.file
      ? `${progress.source}: ${progress.file}`
      : t.checkingSource(progress.source)
    : t.checking;
  // Always dark: the "dark" class gives its HeroUI controls dark colours in the light theme too.
  // On wide screens it stays in place while long pages scroll, so its bottom row stays visible.
  const item = 'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left no-underline transition-colors';
  return (
    <nav
      aria-label={t.nav}
      className="dark flex flex-[1_1_240px] flex-col gap-6 bg-zinc-900 px-3.5 py-5 text-zinc-200 md:sticky md:top-0 md:h-screen md:max-w-[260px] md:self-start md:overflow-y-auto"
    >
      <div className="flex items-center gap-2.5 px-2">
        <span className="flex size-[30px] items-center justify-center rounded-lg bg-accent text-white">
          <RadioIcon size={16} />
        </span>
        <span className="font-semibold text-white">Radio Manager</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="px-2 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">{t.connected}</span>
        {state?.radios.length ? (
          state.radios.map((r) => {
            const active = (page === 'radio' || page === 'update') && volume === r.volume;
            return (
              <button
                key={r.volume}
                type="button"
                onClick={() => onNavigate('radio', r.volume)}
                aria-current={active ? 'page' : undefined}
                className={`${item} ${active ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-800/60'}`}
              >
                <span className="size-2 shrink-0 rounded-full bg-green-400" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{r.name}</span>
                  <span className="truncate font-mono text-xs text-zinc-400">{r.board ?? t.typeUnknown}</span>
                </span>
                {r.updates.length > 0 && (
                  <>
                    <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-zinc-900" aria-hidden="true">
                      {r.updates.length}
                    </span>
                    <span className="sr-only">{t.updatesReady(r.updates.length)}</span>
                  </>
                )}
              </button>
            );
          })
        ) : (
          <p className="m-0 px-2 text-sm text-zinc-400">{t.noRadio}</p>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">{t.overview}</span>
        {overview.map(({ page: target, label, Icon }) => (
          <button
            key={target}
            type="button"
            onClick={() => onNavigate(target)}
            aria-current={page === target || (page === 'restore' && target === 'backups') ? 'page' : undefined}
            className={`${item} ${page === target || (page === 'restore' && target === 'backups') ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-800/60'}`}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <ToggleButtonGroup
            aria-label={t.theme}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([theme])}
            onSelectionChange={(keys) => {
              const v = [...keys][0];
              if (v) setTheme(String(v) as Theme);
            }}
          >
            <ToggleButton id="light" isIconOnly aria-label={t.light}>
              <SunIcon size={16} />
            </ToggleButton>
            <ToggleButton id="dark" isIconOnly aria-label={t.dark}>
              <MoonIcon size={16} />
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            aria-label={t.language}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([lang])}
            onSelectionChange={(keys) => {
              const v = [...keys][0];
              if (v) setLang(String(v) as Lang);
            }}
          >
            <ToggleButton id="de" aria-label="Deutsch">
              DE
            </ToggleButton>
            <ToggleButton id="en" aria-label="English">
              EN
            </ToggleButton>
          </ToggleButtonGroup>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
          <span className="text-xs text-zinc-400">
            {downloading ? progressText : state?.lastCheck ? t.lastChecked(dateTime(state.lastCheck, t.locale)) : t.notChecked}
          </span>
          <Button variant="outline" className="text-white" isDisabled={!!state?.busy} onPress={onDownload}>
            {downloading ? <Spinner size="sm" color="current" /> : <RefreshIcon size={16} />}
            {t.checkUpdates}
          </Button>
        </div>
      </div>
    </nav>
  );
}
