import { Alert, Button, Card, Chip, CloseButton, Label, ListBox, Select, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import type { RadioSourceView, RadioView, VoiceView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { ArrowIcon, BackupsIcon, CheckIcon } from '../components/icons.tsx';
import { backupLabel, isNewer, languageName } from '../format.ts';
import type { Texts } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

function Versions({ s }: { s: RadioSourceView }) {
  const { t } = usePrefs();
  const changes = s.on && s.available && s.available !== s.installed;
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
      <span className="rounded-md bg-surface-secondary px-2 py-0.5 whitespace-nowrap text-muted">
        {s.installed ?? (s.found === 'unknown' ? t.versionUnknown : t.notInstalled)}
      </span>
      {changes && (
        <>
          <ArrowIcon size={14} className="text-warning" />
          <span className="rounded-md bg-warning-soft px-2 py-0.5 text-warning-soft-foreground">{s.available}</span>
        </>
      )}
      {!changes && s.voicesChanged && (
        <span className="rounded-md bg-warning-soft px-2 py-0.5 text-warning-soft-foreground">{t.voicesChanged}</span>
      )}
      {!s.on && s.installed && <span className="text-muted">{t.removedNext}</span>}
    </div>
  );
}

function originLabel(origin: RadioSourceView['origin'], t: Texts): string {
  return { release: t.tagRelease, main: t.tagMain, local: t.tagLocal }[origin];
}

function SourceRow({ radio, s, run }: { radio: RadioView; s: RadioSourceView; run: Run }) {
  const { t } = usePrefs();
  const origins = (
    [
      ['release', s.hasRelease, t.tagRelease],
      ['main', s.hasMain, t.tagMain],
      ['local', s.hasLocal, t.tagLocal],
    ] as const
  ).filter(([id, has]) => has || id === s.origin || (id === 'main' && !s.releaseOnly)); // main is fetched when chosen
  const set = (change: { on?: boolean; origin?: string }) =>
    run(() => post('/api/radio/selection', { board: radio.board, source: s.name, ...change }));
  return (
    <tr className={`border-t border-separator ${s.isNew ? 'bg-warning-soft/40' : ''}`}>
      <td className="px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`font-semibold ${s.on ? '' : 'text-muted'}`}>{s.name}</span>
          {s.isNew && (
            <Chip size="sm" variant="soft" color="warning">
              {t.tagNew}
            </Chip>
          )}
        </div>
        <div className="text-xs text-muted">{s.repo}</div>
      </td>
      <td className="px-3 py-2.5">
        {s.kind === 'project' && origins.length > 1 ? (
          <ToggleButtonGroup
            aria-label={t.originOf(s.name)}
            isDisabled={!s.on}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([s.origin])}
            onSelectionChange={(keys) => {
              const origin = [...keys][0];
              if (origin && origin !== s.origin) set({ origin: String(origin) });
            }}
          >
            {origins.map(([id, , label]) => (
              <ToggleButton key={id} id={id}>
                {label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : (
          <Chip size="sm" variant="soft">
            {s.fixed ? `${originLabel(s.origin, t)} · ${t.tagRequired}` : originLabel(s.origin, t)}
          </Chip>
        )}
      </td>
      <td className="px-3 py-2.5">
        <Versions s={s} />
      </td>
      <td className="px-5 py-2.5">
        <div className="flex justify-end">
          <Switch aria-label={t.onThisRadio(s.name)} isSelected={s.on} isDisabled={s.fixed} onChange={(on) => set({ on })}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </td>
    </tr>
  );
}

// One card in "What's next": a numbered step, or a check mark once nothing is left to do.
function Step(props: { mark: ReactNode; done: boolean; primary?: boolean; title: string; tag?: ReactNode; children: ReactNode; action: ReactNode }) {
  const { mark, done, primary, title, tag, children, action } = props;
  const circle = done
    ? 'bg-success-soft text-success-soft-foreground'
    : primary
      ? 'bg-accent text-accent-foreground'
      : 'bg-surface-secondary text-muted';
  return (
    <Card className={primary ? 'border-2 border-accent' : undefined}>
      <Card.Content className="flex h-full flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-semibold">
            <span className={`inline-flex size-[22px] items-center justify-center rounded-full text-xs font-semibold ${circle}`}>
              {done ? <CheckIcon size={13} /> : mark}
            </span>
            {title}
          </span>
          {tag}
        </div>
        {children}
        <div className="mt-auto flex flex-col">{action}</div>
      </Card.Content>
    </Card>
  );
}

// The voices of the sound packs, right below the sounds source in the table: one small field per language.
function SoundsRow({ radio, run }: { radio: RadioView; run: Run }) {
  const { t } = usePrefs();
  const [voices, setVoices] = useState<VoiceView[]>([]);
  useEffect(() => {
    get<VoiceView[]>('/api/voices').then(setVoices, () => {});
  }, []);
  const save = (sounds: string[]) => run(() => post('/api/radio/sounds', { board: radio.board, sounds }));
  const name = (code: string) => languageName(code, t.locale);
  const used = radio.sounds.map((id) => voices.find((v) => v.id === id)?.language ?? id.split(/[_-]/)[0]!);
  const addable = [...new Set(voices.map((v) => v.language))].filter((l) => !used.includes(l));
  return (
    <tr>
      <td colSpan={4} className="px-5 pt-0.5 pb-3">
        <div role="group" aria-label={t.sounds} className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {radio.language && <span className="basis-full text-xs text-muted">{t.ttsLanguage(name(radio.language))}</span>}
          {radio.sounds.length === 0 && <span className="basis-full text-xs text-muted">{t.noSounds}</span>}
          {radio.sounds.map((id, i) => {
            const lang = used[i]!;
            const options = voices.filter((v) => v.language === lang);
            return (
              <div key={id} className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{name(lang)}</span>
                <Select
                  className="w-36"
                  selectedKey={id}
                  aria-label={t.voiceFor(name(lang))}
                  onSelectionChange={(key) => key !== null && save(radio.sounds.map((x) => (x === id ? String(key) : x)))}
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {(options.length > 0 ? options : [{ id, language: lang, label: id }]).map((v) => (
                        <ListBox.Item key={v.id} id={v.id} textValue={v.label}>
                          {v.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <CloseButton aria-label={t.removeLanguage(name(lang))} onPress={() => save(radio.sounds.filter((x) => x !== id))} />
              </div>
            );
          })}
          {addable.length > 0 && (
            <Select
              className="w-48"
              selectedKey={null}
              placeholder={t.addLanguage}
              aria-label={t.addLanguage}
              onSelectionChange={(key) => key !== null && save([...radio.sounds, String(key)])}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {addable.map((l) => (
                    <ListBox.Item key={l} id={l} textValue={name(l)}>
                      {name(l)}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          )}
        </div>
      </td>
    </tr>
  );
}

function ChooseBoard({ radio, run }: { radio: RadioView; run: Run }) {
  const { t } = usePrefs();
  const [board, setBoard] = useState<string>();
  const [boards, setBoards] = useState<{ board: string; name: string }[]>();
  useEffect(() => {
    get<{ board: string; name: string }[]>('/api/boards').then(setBoards, () => setBoards([]));
  }, []);
  if (boards?.length === 0) {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t.whichRadio}</Alert.Title>
          <Alert.Description>{t.noBoards}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.whichRadio}</Card.Title>
        <Card.Description>{t.noRadioYml}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-wrap items-end gap-3">
        <Select className="min-w-56" selectedKey={board ?? null} onSelectionChange={(k) => setBoard(k === null ? undefined : String(k))}>
          <Label>{t.radioType}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {(boards ?? []).map((b) => (
                <ListBox.Item key={b.board} id={b.board} textValue={b.name}>
                  {b.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Button isDisabled={!board} onPress={() => run(() => post('/api/radio/board', { volume: radio.volume, board }))}>
          {t.useType}
        </Button>
      </Card.Content>
    </Card>
  );
}

export function RadioPage(props: {
  radio: RadioView;
  busy?: string;
  keep: number;
  run: Run;
  onPlan: () => void;
  onFlash: () => void;
  onSources: () => void;
}) {
  const { radio, busy, keep, run, onPlan, onFlash, onSources } = props;
  const { t } = usePrefs();
  const n = radio.updates.length;
  const newer = !!radio.firmwareAvailable && (!radio.firmware || isNewer(radio.firmwareAvailable, radio.firmware));
  const firmwareDone = !!radio.firmware && !newer && !radio.belowMin;
  // the full release title of the version the card shows, e.g. 'EdgeTX "Queen Anne's Revenge" v2.12.5'
  const shownName = radio.firmwareNames[(newer ? radio.firmwareAvailable : radio.firmware) ?? ''];
  const sdPrimary = !radio.belowMin && n > 0;
  const chip = (label: string, color: 'default' | 'success' | 'warning') => (
    <Chip size="sm" variant="soft" color={color}>
      {label}
    </Chip>
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted">{t.connectedRadio(radio.volume)}</span>
        <h1 className="m-0 text-3xl font-bold tracking-tight">{radio.name}</h1>
      </div>

      {!radio.board ? (
        <ChooseBoard radio={radio} run={run} />
      ) : (
        <>
          {radio.belowMin && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.tooOld(radio.firmware ?? '')}</Alert.Title>
                <Alert.Description>{t.tooOldText}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {/* In the order they should happen: firmware first, then the SD card that matches it. */}
          <section aria-labelledby="next" className="flex flex-col gap-3">
            <h2 id="next" className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">
              {t.whatsNext}
            </h2>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
              <Step
                mark={1}
                done={firmwareDone}
                primary={radio.belowMin}
                title={t.firmware}
                tag={
                  radio.belowMin
                    ? chip(t.neededFirst, 'warning')
                    : newer
                      ? chip(t.newVersion, 'warning')
                      : firmwareDone && chip(t.current, 'success')
                }
                action={
                  <Button variant={radio.belowMin ? 'primary' : 'outline'} isDisabled={!!busy} onPress={onFlash}>
                    {t.flashFirmware}
                  </Button>
                }
              >
                <div className="flex items-center gap-2.5 font-mono text-xl">
                  {newer && (
                    <>
                      <span className="text-muted">{radio.firmware ?? t.unknown}</span>
                      <ArrowIcon className="text-warning" />
                    </>
                  )}
                  <span>{newer ? radio.firmwareAvailable : (radio.firmware ?? t.unknown)}</span>
                </div>
                {shownName && <span className="text-sm text-muted">{shownName}</span>}
              </Step>

              <Step
                mark={2}
                done={n === 0 && !radio.belowMin}
                primary={sdPrimary}
                title={t.sdCard}
                tag={
                  n > 0 ? chip(t.updatesReady(n), radio.belowMin ? 'default' : 'warning') : !radio.belowMin && chip(t.upToDate, 'success')
                }
                action={
                  <Button variant={sdPrimary ? 'primary' : 'outline'} isDisabled={!!busy || radio.belowMin} onPress={onPlan}>
                    {t.reviewPlan}
                  </Button>
                }
              >
                <p className="m-0 text-sm text-muted">
                  {radio.belowMin ? t.waitsForFirmware : n === 0 ? t.matches : t.backupFirst(radio.updates.join(', '))}
                </p>
              </Step>

              <Step
                mark={<BackupsIcon size={13} />}
                done={!!radio.lastBackup}
                title={t.backup}
                action={
                  <Button variant="outline" isDisabled={!!busy} onPress={() => run(() => post('/api/backup', { volume: radio.volume }))}>
                    {busy === 'backup' ? t.backingUp : t.backUpNow}
                  </Button>
                }
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-muted">{t.lastBackup}</span>
                  <span className="font-mono">{radio.lastBackup ? backupLabel(radio.lastBackup) : t.noneYet}</span>
                  <span className="text-xs text-muted">{t.stored(radio.backups, keep)}</span>
                </div>
              </Step>
            </div>
          </section>

          <Card className="min-w-0 gap-0 overflow-hidden p-0">
            <section aria-labelledby="sources">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="flex flex-col">
                  <h2 id="sources" className="m-0 text-base font-semibold">
                    {t.sourcesOnRadio}
                  </h2>
                  <span className="text-sm text-muted">{t.sourcesCount(radio.sources.length, radio.sources.filter((s) => s.on).length)}</span>
                </div>
                <Button variant="ghost" size="sm" onPress={onSources}>
                  {t.addSource}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th scope="col" className="px-5 py-2 font-medium">
                        {t.colSource}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t.colOrigin}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t.colVersion}
                      </th>
                      <th scope="col" className="px-5 py-2 text-right font-medium">
                        {t.colActive}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {radio.sources.map((s) => (
                      <Fragment key={s.name}>
                        <SourceRow radio={radio} s={s} run={run} />
                        {s.kind === 'sounds' && s.on && <SoundsRow radio={radio} run={run} />}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </Card>
        </>
      )}
    </div>
  );
}
