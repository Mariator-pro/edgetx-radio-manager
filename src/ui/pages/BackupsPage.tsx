import { Button, Card, Spinner, Switch } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { BackupView, RadioView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { backupLabel, bytes } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

export function BackupsPage({
  run,
  keep,
  refreshKey,
  radios,
  busy,
  onRestore,
}: {
  run: Run;
  keep: number;
  refreshKey: unknown;
  radios: RadioView[];
  busy?: string;
  onRestore: (radio: RadioView, name: string) => void;
}) {
  const { t } = usePrefs();
  const [backups, setBackups] = useState<BackupView[]>();
  const load = useCallback(() => get<BackupView[]>('/api/backups').then(setBackups, () => {}), []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!backups) return <Spinner />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-3xl font-bold tracking-tight">{t.backups}</h1>
          <p className="m-0 text-muted">{t.backupsText(keep)}</p>
        </div>
        <Button variant="outline" onPress={() => run(() => post('/api/backups/open', {}))}>
          {t.openFolder}
        </Button>
      </div>
      {backups.length === 0 && <p className="m-0 text-muted">{t.noBackups}</p>}
      {backups.map((b) => {
        // A backup goes back only onto a connected radio of its own type.
        const target = radios.find((r) => r.board === b.board);
        return (
          <Card key={b.board}>
            <Card.Header>
              <Card.Title>{b.radio}</Card.Title>
              <Card.Description>
                {t.backupCount(b.items.length)}
                {!target && <span id={`needs-${b.board}`}> · {t.restoreNeedsRadio(b.radio)}</span>}
              </Card.Description>
            </Card.Header>
            <Card.Content className="p-0">
              <ul className="m-0 list-none p-0">
                {b.items.map((i) => (
                  <li key={i.name} className="flex flex-wrap items-center gap-3 border-t border-separator px-5 py-3">
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
                      variant="outline"
                      isDisabled={!target || !!busy}
                      aria-describedby={target ? undefined : `needs-${b.board}`}
                      onPress={() => target && onRestore(target, i.name)}
                    >
                      {t.restore}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={i.kept}
                      onPress={() => {
                        if (confirm(t.deleteBackup(backupLabel(i.name), b.radio))) {
                          run(async () => {
                            await post('/api/backups/delete', { board: b.board, name: i.name });
                            await load();
                          });
                        }
                      }}
                    >
                      {t.delete}
                    </Button>
                  </li>
                ))}
              </ul>
            </Card.Content>
          </Card>
        );
      })}
    </div>
  );
}
