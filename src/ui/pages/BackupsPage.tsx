import { Button, Card, Input, Spinner, Switch, TextField } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { BackupItemView, BackupView, PackageChangeView, RadioView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { backupLabel, bytes } from '../format.ts';
import type { Texts } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';
import { type Ask, Confirm } from '../components/Confirm.tsx';
import { RadioChoice } from '../components/RadioChoice.tsx';
import { choiceName, preselect } from '../radioChoice.ts';

type Run = (fn: () => Promise<unknown>) => void;

const MAX_NOTE = 200; // the server's limit, MAX_NOTE in settings.ts

function changeText(t: Texts, c: PackageChangeView): string {
  if (!c.from) return t.changeNew(c.name, c.to ?? '');
  if (!c.to) return t.changeRemoved(c.name, c.from);
  return `${c.name} ${c.from} → ${c.to}`;
}

// "EdgeTX 2.12.3 · Before update: edgetx-sdcard v2.12.3 → v2.12.5"; older backups have no reason.
function details(t: Texts, i: BackupItemView): string {
  const reason =
    i.reason === 'manual'
      ? t.madeByHand
      : i.reason === 'update'
        ? `${t.beforeUpdate}${i.changes?.length ? `: ${i.changes.map((c) => changeText(t, c)).join(', ')}` : ''}`
        : i.reason === 'restore' && i.restoredFrom
          ? t.beforeRestore(backupLabel(i.restoredFrom))
          : i.reason === 'models'
            ? t.beforeModels(i.models?.join(', ') ?? '')
            : i.reason === 'deleteModels'
              ? t.beforeDeleteModels(i.models?.join(', ') ?? '')
              : undefined;
  return [i.firmware && `EdgeTX ${i.firmware}`, reason].filter(Boolean).join(' · ');
}

export function BackupsPage({
  run,
  keep,
  refreshKey,
  radios,
  selected,
  busy,
  onRestore,
}: {
  run: Run;
  keep: number;
  refreshKey: unknown;
  radios: RadioView[];
  selected?: RadioView; // the radio chosen in the sidebar
  busy?: string;
  onRestore: (radio: RadioView, name: string) => void;
}) {
  const { t } = usePrefs();
  const [backups, setBackups] = useState<BackupView[]>();
  const [editing, setEditing] = useState<{ board: string; name: string; text: string }>();
  const [ask, setAsk] = useState<Ask>();
  // a radio chosen here, and the radio chosen in the sidebar then: another one there shows its own backups again
  const [chosen, setChosen] = useState<{ key: string; volume?: string }>();
  const load = useCallback(() => get<BackupView[]>('/api/backups').then(setBackups, () => {}), []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const volume = selected?.volume;

  if (!backups) return <Spinner />;
  const own = chosen?.volume === volume ? chosen?.key : undefined;
  const key = own && backups.some((b) => b.key === own) ? own : preselect(backups, volume);
  const shown = backups.filter((b) => b.key === key);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1.5">
          <h1 className="m-0 text-3xl font-bold tracking-tight">{t.backups}</h1>
          <p className="m-0 text-muted">{t.backupsText(keep)}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {backups.length > 0 && <RadioChoice choices={backups} value={key} onChange={(k) => setChosen({ key: k, volume })} />}
          <Button variant="outline" onPress={() => run(() => post('/api/backups/open', {}))}>
            {t.openFolder}
          </Button>
        </div>
      </div>
      {(backups.length === 0 || shown[0]?.items.length === 0) && <p className="m-0 text-muted">{t.noBackups}</p>}
      {shown.filter((b) => b.items.length > 0).map((b) => {
        const radio = b.unknown ? b.type : choiceName(t, b); // how the delete question names it
        // A backup goes back only onto a connected radio of its own type: the one chosen, else the only one connected.
        const ofType = radios.filter((r) => r.board === b.board);
        const target = selected?.board === b.board ? selected : ofType.length === 1 ? ofType[0] : undefined;
        return (
          <Card key={b.key}>
            <Card.Header>
              <Card.Title>{choiceName(t, b)}</Card.Title>
              <Card.Description>
                {[b.name || b.unknown ? b.type : undefined, t.backupCount(b.items.length)].filter(Boolean).join(' · ')}
                {target && ofType.length > 1 && <span> · {t.restoreOnto(target.label)}</span>}
                {!target && <span id={`needs-${b.board}`}> · {ofType.length > 1 ? t.restoreChooseRadio : t.restoreNeedsRadio(b.type)}</span>}
              </Card.Description>
            </Card.Header>
            <Card.Content className="p-0">
              <ul className="m-0 list-none p-0">
                {b.items.map((i) => {
                  const line = details(t, i);
                  const edit = editing?.board === b.board && editing.name === i.name ? editing : undefined;
                  const saveNote = () =>
                    run(async () => {
                      await post('/api/backups/note', { board: b.board, name: i.name, note: edit?.text ?? '' });
                      setEditing(undefined);
                      await load();
                    });
                  return (
                    <li key={i.name} className="flex flex-col gap-1.5 border-t border-separator px-5 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="w-44 font-mono text-sm">{backupLabel(i.name)}</span>
                        <span className="w-20 text-sm text-muted">{bytes(i.bytes)}</span>
                        <Switch
                          size="sm"
                          isSelected={i.kept}
                          onChange={(keepIt) =>
                            run(async () => {
                              await post('/api/backups/keep', { board: b.board, name: i.name, keep: keepIt });
                              await load();
                            })
                          }
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span className="text-sm">{t.keep}</span>
                          </Switch.Content>
                        </Switch>
                        <span className="flex-1" />
                        <Button size="sm" variant="ghost" onPress={() => run(() => post('/api/backups/open', { board: b.board, name: i.name }))}>
                          {t.show}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => setEditing({ board: b.board, name: i.name, text: i.note ?? '' })}
                        >
                          {i.note ? t.editNote : t.note}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={!target || !!busy}
                          aria-describedby={target ? undefined : `needs-${b.board}`}
                          onPress={() => target && onRestore(target, i.name)}
                        >
                          {t.restore}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-soft"
                          isDisabled={i.kept}
                          onPress={() =>
                            setAsk({
                              title: t.deleteBackup(backupLabel(i.name), radio),
                              text: t.deleteBackupText,
                              confirm: t.delete,
                              then: () =>
                                run(async () => {
                                  await post('/api/backups/delete', { board: b.board, name: i.name });
                                  await load();
                                }),
                            })
                          }
                        >
                          {t.delete}
                        </Button>
                      </div>
                      {line && <p className="m-0 text-sm text-muted">{line}</p>}
                      {edit ? (
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveNote();
                          }}
                        >
                          <TextField
                            aria-label={t.noteFor(backupLabel(i.name))}
                            className="min-w-64 flex-1"
                            value={edit.text}
                            onChange={(text) => setEditing({ ...edit, text })}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setEditing(undefined);
                            }}
                          >
                            <Input variant="secondary" placeholder={t.notePlaceholder} maxLength={MAX_NOTE} autoFocus />
                          </TextField>
                          <Button size="sm" type="submit">
                            {t.save}
                          </Button>
                          <Button size="sm" variant="tertiary" onPress={() => setEditing(undefined)}>
                            {t.cancel}
                          </Button>
                        </form>
                      ) : (
                        i.note && <p className="m-0 text-sm">{i.note}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card.Content>
          </Card>
        );
      })}
      {ask && <Confirm ask={ask} onClose={() => setAsk(undefined)} />}
    </div>
  );
}
