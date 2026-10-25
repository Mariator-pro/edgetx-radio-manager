import { Alert, Button, Card, Checkbox, Chip, Label, ListBox, Radio, RadioGroup, Select, Spinner } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { CardModelView, DiffGroupView, ImportView, ModelEntryView, ModelRef, ModelsView, RadioView, StateView } from '../../server/api.ts';
import { errorText, get, post, postFile, tokenUrl } from '../api.ts';
import { backupLabel } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';
import { ModelDiff } from './ModelDiff.tsx';

type Run = (fn: () => Promise<unknown>) => void;

// What the guided flow writes: models to copy, each with where it comes from, or models to delete.
export interface ModelsRequest {
  radio: RadioView;
  copy: { ref: ModelRef; source: string }[];
  delete: { file: string; name: string }[];
}

const entryKey = (e: ModelEntryView) => `e:${e.name}\u0000${e.file ?? ''}`;
const STATUS_COLOR = { same: 'success', changed: 'warning', missing: 'default' } as const;

export function ModelsPage({ state, run, onStart }: { state: StateView; run: Run; onStart: (r: ModelsRequest) => void }) {
  const { t } = usePrefs();
  const radios = state.radios.filter((r) => r.board);
  const [board, setBoard] = useState<string>();
  const [view, setView] = useState<ModelsView>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, number>>({}); // entry -> version to use
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [comparing, setComparing] = useState<{ key: string; version: number }>();
  const [diff, setDiff] = useState<{ title: string; subtitle: string; groups?: DiffGroupView[] }>();
  const [imported, setImported] = useState<ImportView>();
  const [error, setError] = useState<unknown>();
  const fileInput = useRef<HTMLInputElement>(null);

  const shown = board ?? radios[0]?.board ?? '';
  // compared with the radio of the shown type, else with whatever radio is connected
  const radio = radios.find((r) => r.board === shown) ?? radios[0];
  const refreshKey = `${state.radios.map((r) => `${r.volume}|${r.lastBackup}`).join()}|${state.busy}`;

  const volume = radio?.volume;
  useEffect(() => {
    let stale = false;
    get<ModelsView>(`/api/models?board=${encodeURIComponent(shown)}${volume ? `&volume=${encodeURIComponent(volume)}` : ''}`).then(
      (v) => {
        if (stale) return;
        // nothing of the connected radio backed up yet: show the first radio that has backups
        if (!board && !v.boards.some((b) => b.board === v.board) && v.boards[0]) setBoard(v.boards[0].board);
        else setView(v);
      },
      (e: unknown) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [shown, volume, board, refreshKey]);

  if (!view) return error ? <p className="m-0 text-danger">{errorText(t, error)}</p> : <Spinner />;

  const toggle = (key: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const versionOf = (e: ModelEntryView) => e.versions[chosen[entryKey(e)] ?? 0]!;
  const refOf = (e: ModelEntryView): ModelRef => ({ board: view.board, backup: versionOf(e).backup, file: versionOf(e).file });
  // the card's model of the same name, the one with the same file first
  const onCard = (name: string, file?: string): CardModelView | undefined => {
    const named = view.card?.models.filter((m) => m.name === name) ?? [];
    return named.find((m) => m.file === file) ?? named[0];
  };

  const entries = view.entries.filter((e) => picked.has(entryKey(e)));
  const cardOnly = view.onlyOnCard.filter((m) => picked.has(`c:${m.file}`));
  const fromFile = imported?.models.filter((m) => picked.has(`i:${m.file}`)) ?? [];
  const count = entries.length + cardOnly.length + fromFile.length;
  const canCopy = !!radio && cardOnly.length === 0 && count > 0;
  const deletable = entries.every((e) => !!onCard(e.name, e.file ?? e.versions[0]?.file)) && fromFile.length === 0;
  const canDelete = !!radio && deletable && count > 0;
  const canExport = cardOnly.length === 0 && fromFile.length === 0 && entries.length > 0;

  const copy = () =>
    radio &&
    onStart({
      radio,
      copy: [
        ...entries.map((e) => ({ ref: refOf(e), source: t.fromBackup(view.radio, backupLabel(versionOf(e).backup)) })),
        ...fromFile.map((m) => ({ ref: { import: imported!.id, file: m.file }, source: t.fromFile(imported!.name) })),
      ],
      delete: [],
    });
  const remove = () => {
    if (!radio) return;
    // two picked entries can be the same card model, e.g. backup twins of one name
    const files = new Map<string, { file: string; name: string }>();
    for (const m of [...entries.map((e) => onCard(e.name, e.file ?? e.versions[0]?.file)!), ...cardOnly]) files.set(m.file, { file: m.file, name: m.name });
    onStart({ radio, copy: [], delete: [...files.values()] });
  };
  const exportAll = () => {
    for (const e of entries) {
      const r = refOf(e) as { board: string; backup: string; file: string };
      const a = document.createElement('a');
      a.href = tokenUrl(`/api/models/export?board=${encodeURIComponent(r.board)}&backup=${encodeURIComponent(r.backup)}&file=${encodeURIComponent(r.file)}`);
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    }
  };
  // the card has the model, and not in this version
  const cardDiffers = (e: ModelEntryView, version: number) => !!e.card && e.card !== 'missing' && e.cardVersion !== version;
  const compare = (e: ModelEntryView, a: number, b: number | 'card') => {
    const left = e.versions[a]!;
    const ref = (v: (typeof e.versions)[number]) => ({ board: view.board, backup: v.backup, file: v.file });
    const other = b === 'card' ? t.theCard : backupLabel(e.versions[b]!.backup);
    setComparing(undefined);
    setDiff({ title: t.diffTitle(e.name), subtitle: `${backupLabel(left.backup)} → ${other}` });
    run(async () => {
      try {
        const groups = await post<DiffGroupView[]>('/api/models/diff', {
          a: ref(left),
          ...(b === 'card' ? { volume: radio?.volume } : { b: ref(e.versions[b]!) }),
        });
        setDiff((d) => d && { ...d, groups });
      } catch (err) {
        setDiff(undefined);
        throw err;
      }
    });
  };
  const importFile = (f: File) =>
    run(async () => {
      const v = await postFile<ImportView>(`/api/models/import?name=${encodeURIComponent(f.name)}`, f);
      if (imported) await post('/api/models/import/close', { id: imported.id });
      setPicked(new Set([...picked].filter((k) => !k.startsWith('i:'))));
      setImported(v);
    });
  const closeImport = () =>
    run(async () => {
      if (imported) await post('/api/models/import/close', { id: imported.id });
      setPicked(new Set([...picked].filter((k) => !k.startsWith('i:'))));
      setImported(undefined);
    });

  const check = (key: string, label: string) => (
    <Checkbox variant="secondary" aria-label={label} isSelected={picked.has(key)} onChange={(on) => toggle(key, on)}>
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
  const picture = (bitmap: string | undefined, backup: string) =>
    bitmap ? (
      <img
        src={tokenUrl(`/api/models/image?board=${encodeURIComponent(view.board)}&backup=${encodeURIComponent(backup)}&file=${encodeURIComponent(bitmap)}`)}
        alt=""
        // model pictures are mostly black drawings on a transparent ground: a light ground in both themes
        className="size-11 shrink-0 rounded-lg border border-separator bg-white object-contain"
        onError={(ev) => ((ev.target as HTMLImageElement).style.visibility = 'hidden')}
      />
    ) : (
      <span className="size-11 shrink-0 rounded-lg bg-surface-secondary" aria-hidden="true" />
    );
  const labels = (l: string[]) => l.map((x) => <Chip key={x} size="sm" variant="soft">{x}</Chip>);

  return (
    <div className="flex flex-col gap-6 pb-20">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1.5">
          <h1 className="m-0 text-3xl font-bold tracking-tight">{t.models}</h1>
          <p className="m-0 text-muted">{t.modelsText}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {view.boards.length > 0 && (
            <Select
              aria-label={t.modelsOf}
              className="w-56"
              selectedKey={view.board}
              onSelectionChange={(k) => {
                if (k === null) return;
                setBoard(String(k));
                setPicked(new Set([...picked].filter((x) => x.startsWith('i:'))));
                setChosen({});
                setOpen(new Set());
                setComparing(undefined);
              }}
            >
              <Label>{t.modelsOf}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {view.boards.map((b) => (
                    <ListBox.Item key={b.board} id={b.board} textValue={b.radio}>
                      {b.radio}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".yml,.yaml,.etx"
            className="hidden"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              ev.target.value = '';
              if (f) importFile(f);
            }}
          />
          <Button variant="outline" isDisabled={!radio} onPress={() => fileInput.current?.click()} aria-describedby="import-hint">
            {t.importFile}
          </Button>
          <span id="import-hint" className="sr-only">
            {t.importHint}
          </span>
        </div>
      </div>

      {!radio && (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t.connectToCopy}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {imported && (
        <Card>
          <Card.Header className="flex flex-row flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col">
              <Card.Title>{t.importedFile(imported.name)}</Card.Title>
              {imported.radio && <Card.Description>{t.importedFrom(imported.radio)}</Card.Description>}
            </div>
            <Button size="sm" variant="ghost" onPress={closeImport}>
              {t.closeImport}
            </Button>
          </Card.Header>
          <Card.Content className="p-0">
            <ul className="m-0 list-none p-0">
              {imported.models.map((m) => (
                <li key={m.file || m.name} className="flex flex-wrap items-center gap-3 border-t border-separator px-5 py-3">
                  {check(`i:${m.file}`, t.selectModel(m.name))}
                  <span className="font-semibold">{m.name}</span>
                  {labels(m.labels)}
                  {m.semver && <span className="text-sm text-muted">EdgeTX {m.semver}</span>}
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      )}

      {view.boards.length === 0 ? (
        <p className="m-0 text-muted">{t.noModelBackups}</p>
      ) : view.entries.length === 0 && view.onlyOnCard.length === 0 ? (
        <p className="m-0 text-muted">{t.noModelsInBackups}</p>
      ) : (
        <Card>
          <Card.Content className="p-0">
            <ul className="m-0 list-none p-0">
              {view.entries.map((e) => {
                const key = entryKey(e);
                const v = versionOf(e);
                const expanded = open.has(key);
                return (
                  <li key={key} className="flex flex-col border-t border-separator first:border-t-0">
                    <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                      {check(key, t.selectModel(e.name))}
                      {picture(v.bitmap, v.backup)}
                      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{e.name}</span>
                          {e.file && <span className="font-mono text-xs text-muted">{e.file}</span>}
                          {labels(v.labels)}
                        </span>
                        <span className="text-sm text-muted">
                          {[v.semver && `EdgeTX ${v.semver}`, backupLabel(e.versions[0]!.backup)].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      {e.card && (
                        <Chip size="sm" variant="soft" color={STATUS_COLOR[e.card]}>
                          {t.cardStates[e.card]}
                        </Chip>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={expanded}
                        aria-controls={`versions-${key}`}
                        onPress={() => {
                          const next = new Set(open);
                          if (expanded) next.delete(key);
                          else next.add(key);
                          setOpen(next);
                        }}
                      >
                        {t.versionCount(e.versions.length)} {expanded ? '▴' : '▾'}
                      </Button>
                    </div>
                    {expanded && (
                      <RadioGroup
                        id={`versions-${key}`}
                        aria-label={t.versionsOf(e.name)}
                        value={String(chosen[key] ?? 0)}
                        onChange={(val) => setChosen({ ...chosen, [key]: Number(val) })}
                        className="flex flex-col gap-0 bg-surface-secondary/50 px-5 pb-3"
                      >
                        {e.versions.map((x, i) => (
                          <div key={x.backup} className="flex flex-col gap-2 border-t border-separator py-2.5 pl-8">
                            <div className="flex flex-wrap items-center gap-3">
                              <Radio value={String(i)} aria-label={t.pickVersion(backupLabel(x.backup))}>
                                <Radio.Content>
                                  <Radio.Control>
                                    <Radio.Indicator />
                                  </Radio.Control>
                                  <Label className="font-mono text-sm">{backupLabel(x.backup)}</Label>
                                </Radio.Content>
                              </Radio>
                              {x.since !== x.backup && <span className="text-sm text-muted">{t.sinceDate(backupLabel(x.since))}</span>}
                              {x.semver && <span className="text-sm text-muted">EdgeTX {x.semver}</span>}
                              {e.cardVersion === i && (
                                <Chip size="sm" variant="soft" color="success">
                                  {t.thisOnCard}
                                </Chip>
                              )}
                              <span className="flex-1" />
                              {(e.versions.length > 1 || cardDiffers(e, i)) && (
                                <Button size="sm" variant="ghost" onPress={() => setComparing(comparing?.key === key && comparing.version === i ? undefined : { key, version: i })}>
                                  {t.compare}
                                </Button>
                              )}
                            </div>
                            {comparing?.key === key && comparing.version === i && (
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="text-muted">{t.compareWith}</span>
                                {cardDiffers(e, i) && (
                                  <Button size="sm" variant="outline" onPress={() => compare(e, i, 'card')}>
                                    {t.theCard}
                                  </Button>
                                )}
                                {e.versions.map(
                                  (y, j) =>
                                    j !== i && (
                                      <Button key={y.backup} size="sm" variant="outline" onPress={() => compare(e, i, j)}>
                                        {backupLabel(y.backup)}
                                      </Button>
                                    ),
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </RadioGroup>
                    )}
                  </li>
                );
              })}
              {view.onlyOnCard.map((m) => (
                <li key={`c:${m.file}`} className="flex flex-wrap items-center gap-3 border-t border-separator px-5 py-3 first:border-t-0">
                  {check(`c:${m.file}`, t.selectModel(m.name))}
                  <span className="size-11 shrink-0 rounded-lg bg-surface-secondary" aria-hidden="true" />
                  <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{m.name}</span>
                      <span className="font-mono text-xs text-muted">{m.file}</span>
                      {labels(m.labels)}
                    </span>
                    {m.semver && <span className="text-sm text-muted">EdgeTX {m.semver}</span>}
                  </div>
                  <Chip size="sm" variant="soft" color="accent">
                    {t.onlyOnCard}
                  </Chip>
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      )}

      {count > 0 && (
        <div className="sticky bottom-0 -mx-7 -mb-7 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-7 py-4 backdrop-blur">
          <span className="text-sm text-muted">{t.selectedCount(count)}</span>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" isDisabled={!canExport} onPress={exportAll}>
              {t.exportModels}
            </Button>
            <Button variant="outline" isDisabled={!canDelete || !!state.busy} onPress={remove}>
              {t.deleteFromCard}
            </Button>
            <Button isDisabled={!canCopy || !!state.busy} onPress={copy}>
              {t.copyTo(radio?.name ?? '')}
            </Button>
          </div>
        </div>
      )}

      {diff && <ModelDiff title={diff.title} subtitle={diff.subtitle} groups={diff.groups} onClose={() => setDiff(undefined)} />}
    </div>
  );
}
