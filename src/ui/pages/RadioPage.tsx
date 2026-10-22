import { Alert, Button, Card, Chip, CloseButton, Label, ListBox, Select, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { RadioSourceView, RadioView, VoiceView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { ArrowIcon } from '../components/icons.tsx';
import { backupLabel, languageName } from '../format.ts';
import type { Texts } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

// "2.12.5" newer than "2.12.3"; missing parts count as 0.
function isNewer(a: string, b: string): boolean {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function Versions({ s }: { s: RadioSourceView }) {
  const { t } = usePrefs();
  const changes = s.on && s.available && s.available !== s.installed;
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
      <span className="rounded-md bg-surface-secondary px-2 py-0.5 text-muted">{s.installed ?? t.notInstalled}</span>
      {changes && (
        <>
          <ArrowIcon size={14} className="text-warning" />
          <span className="rounded-md bg-warning-soft px-2 py-0.5 text-warning-soft-foreground">{s.available}</span>
        </>
      )}
      {!s.on && s.installed && <span className="text-muted">{t.removedNext}</span>}
    </div>
  );
}

function tag(s: RadioSourceView, t: Texts): { label: string; color: 'default' | 'accent' | 'warning' } {
  if (s.isNew) return { label: t.tagNew, color: 'warning' };
  if (s.fixed) return { label: t.tagRequired, color: 'default' };
  return s.origin === 'local' ? { label: t.tagLocal, color: 'accent' } : { label: t.tagRelease, color: 'default' };
}

function SourceCard({ radio, s, run }: { radio: RadioView; s: RadioSourceView; run: Run }) {
  const { t } = usePrefs();
  const chip = tag(s, t);
  const set = (change: { on?: boolean; origin?: string }) =>
    run(() => post('/api/radio/selection', { board: radio.board, source: s.name, ...change }));
  return (
    <Card className={s.isNew ? 'border border-warning' : undefined}>
      <Card.Content className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{s.name}</span>
            <span className="truncate text-xs text-muted">{s.repo}</span>
          </div>
          <Switch
            aria-label={t.onThisRadio(s.name)}
            isSelected={s.on}
            isDisabled={s.fixed}
            onChange={(on) => set({ on })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Versions s={s} />
          <Chip size="sm" variant="soft" color={chip.color}>
            {chip.label}
          </Chip>
        </div>
        {s.kind === 'project' && s.hasRelease && s.hasLocal && (
          <ToggleButtonGroup
            size="sm"
            aria-label={t.originOf(s.name)}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([s.origin])}
            onSelectionChange={(keys) => {
              const origin = [...keys][0];
              if (origin && origin !== s.origin) set({ origin: String(origin) });
            }}
          >
            <ToggleButton id="release">{t.tagRelease}</ToggleButton>
            <ToggleButton id="local">{t.tagLocal}</ToggleButton>
          </ToggleButtonGroup>
        )}
      </Card.Content>
    </Card>
  );
}

function SoundsCard({ radio, run }: { radio: RadioView; run: Run }) {
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
    <Card>
      <Card.Header>
        <Card.Title>{t.sounds}</Card.Title>
        {radio.language && <Card.Description>{t.ttsLanguage(name(radio.language))}</Card.Description>}
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {radio.sounds.length === 0 && <p className="m-0 text-sm text-muted">{t.noSounds}</p>}
        {radio.sounds.map((id, i) => {
          const lang = used[i]!;
          const options = voices.filter((v) => v.language === lang);
          return (
            <div key={id} className="flex items-end gap-2">
              <Select
                fullWidth
                selectedKey={id}
                aria-label={t.voiceFor(name(lang))}
                onSelectionChange={(key) => key !== null && save(radio.sounds.map((x) => (x === id ? String(key) : x)))}
              >
                <Label>{name(lang)}</Label>
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
            fullWidth
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
      </Card.Content>
    </Card>
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

export function RadioPage(props: { radio: RadioView; busy?: string; keep: number; run: Run; onPlan: () => void; onFlash: () => void }) {
  const { radio, busy, keep, run, onPlan, onFlash } = props;
  const { t } = usePrefs();
  const n = radio.updates.length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t.connectedRadio(radio.volume)}</span>
          <h1 className="m-0 text-3xl font-bold tracking-tight">{radio.name}</h1>
        </div>
        {radio.board && (
          <Button variant="outline" isDisabled={!!busy} onPress={() => run(() => post('/api/backup', { volume: radio.volume }))}>
            {busy === 'backup' ? t.backingUp : t.backUpNow}
          </Button>
        )}
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

          <section aria-labelledby="status" className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-accent-soft px-6 py-5 text-accent-soft-foreground dark:bg-zinc-900 dark:text-white">
            <div className="flex flex-col gap-1.5">
              <h2 id="status" className="m-0 text-xl font-semibold">
                {n === 0 ? t.upToDate : t.updatesReady(n)}
              </h2>
              <p className="m-0 text-sm opacity-80 dark:text-zinc-300 dark:opacity-100">
                {n === 0 ? t.matches : t.backupFirst(radio.updates.join(', '))}
              </p>
            </div>
            <Button size="lg" isDisabled={!!busy || radio.belowMin} onPress={onPlan}>
              {t.reviewPlan}
            </Button>
          </section>

          <div className="flex flex-wrap items-start gap-6">
            <section aria-labelledby="sources" className="flex min-w-0 flex-[999_1_420px] flex-col gap-3">
              <h2 id="sources" className="m-0 text-base font-semibold">
                {t.sources}
              </h2>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                {radio.sources.map((s) => (
                  <SourceCard key={s.name} radio={radio} s={s} run={run} />
                ))}
              </div>
            </section>

            <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
              <Card>
                <Card.Header>
                  <Card.Title>{t.firmware}</Card.Title>
                </Card.Header>
                <Card.Content className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 font-mono text-lg">
                    <span>{radio.firmware ?? t.unknown}</span>
                    {radio.firmwareAvailable && (!radio.firmware || isNewer(radio.firmwareAvailable, radio.firmware)) && (
                      <>
                        <ArrowIcon className="text-muted" />
                        <span className="text-warning-soft-foreground">{radio.firmwareAvailable}</span>
                      </>
                    )}
                  </div>
                  <Button variant="outline" isDisabled={!!busy} onPress={onFlash}>
                    {t.flashFirmware}
                  </Button>
                </Card.Content>
              </Card>
              <SoundsCard radio={radio} run={run} />
              <Card>
                <Card.Header>
                  <Card.Title>{t.lastBackup}</Card.Title>
                </Card.Header>
                <Card.Content className="flex flex-col gap-1">
                  <span className="font-mono text-sm">{radio.lastBackup ? backupLabel(radio.lastBackup) : t.noneYet}</span>
                  <span className="text-xs text-muted">
                    {t.stored(radio.backups, keep)}
                  </span>
                </Card.Content>
              </Card>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
