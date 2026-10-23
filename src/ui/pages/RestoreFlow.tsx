import { Alert, Button, Checkbox, Chip, Label, ProgressBar, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { ProgressEvent, RadioView, RestoreAction, RestorePlanView, RestoreResultView } from '../../server/api.ts';
import { errorText, post } from '../api.ts';
import { Stepper } from '../components/Stepper.tsx';
import { backupLabel } from '../format.ts';
import { COLORS, TILES } from '../planColors.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'plan' | 'running' | 'done' | 'error';

const ACTIONS: RestoreAction[] = ['add', 'replace', 'delete'];

// Files grouped by their top-level folder on the card; files at the top level under "/".
function byFolder(files: RestorePlanView['files']): [string, RestorePlanView['files']][] {
  const groups = new Map<string, RestorePlanView['files']>();
  for (const f of files) {
    const folder = f.path.includes('/') ? `${f.path.split('/')[0]}/` : '/';
    groups.set(folder, [...(groups.get(folder) ?? []), f]);
  }
  return [...groups];
}

export function RestoreFlow({ radio, name, progress, onBack }: { radio: RadioView; name: string; progress?: ProgressEvent; onBack: () => void }) {
  const { t } = usePrefs();
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<RestorePlanView>();
  const [result, setResult] = useState<RestoreResultView>();
  const [error, setError] = useState<unknown>();
  const [backupFirst, setBackupFirst] = useState(true);

  useEffect(() => {
    post<RestorePlanView>('/api/restore/plan', { volume: radio.volume, board: radio.board, name }).then(
      (p) => {
        setPlan(p);
        setPhase('plan');
      },
      (e: unknown) => {
        setError(e);
        setPhase('error');
      },
    );
  }, [radio.volume, radio.board, name]);

  const start = async () => {
    setPhase('running');
    try {
      setResult(await post<RestoreResultView>('/api/restore/run', { volume: radio.volume, board: radio.board, name, backupFirst }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };

  const step = phase === 'running' ? (progress?.step === 'write' || !backupFirst ? 2 : 1) : phase === 'done' ? 3 : 0;
  const c = plan?.counts;
  const nothing = c && c.add + c.replace + c.delete === 0;
  const otherFirmware = plan?.backupFirmware && plan.cardFirmware && plan.backupFirmware !== plan.cardFirmware;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-bold">{radio.name}</span>
          <span className="font-mono text-xs text-muted">
            {radio.board} · EdgeTX {radio.firmware}
          </span>
        </div>
        <Button variant="ghost" size="sm" isDisabled={phase === 'running'} onPress={onBack}>
          {t.backToBackups}
        </Button>
      </div>

      <Stepper current={step} steps={t.restoreSteps} label={t.restoreStepsLabel} skipped={backupFirst ? [] : [1]} />

      {phase === 'loading' && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner size="sm" /> {t.reading}
        </div>
      )}

      {phase === 'error' && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.restoreFailed}</Alert.Title>
            <Alert.Description>{errorText(t, error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {phase === 'plan' && plan && c && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-2xl font-bold tracking-tight">{t.restoreTitle(backupLabel(name))}</h1>
            <p className="m-0 text-muted">{t.restoreText}</p>
          </div>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            {ACTIONS.map((a) => (
              <div key={a} className={`flex flex-col rounded-2xl px-4 py-3.5 ${TILES[a]}`}>
                <span className="text-[26px] font-bold">{c[a]}</span>
                <span className="text-sm">{t.restoreActions[a]}</span>
              </div>
            ))}
          </div>

          {otherFirmware && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.restoreFirmware}</Alert.Title>
                <Alert.Description>{t.restoreFirmwareText(plan.backupFirmware!, plan.cardFirmware!)}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {nothing ? (
            <p className="m-0 text-muted">{t.restoreNothing}</p>
          ) : (
            <section aria-labelledby="files" className="flex flex-col gap-3.5">
              <h2 id="files" className="m-0 text-base font-semibold">
                {t.files}
              </h2>
              {byFolder(plan.files).map(([folder, files]) => (
                <details key={folder} open={files.length <= 20} className="overflow-hidden rounded-2xl border border-border">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 bg-surface-secondary px-4 py-3">
                    <span className="flex-auto font-mono font-semibold">{folder}</span>
                    {ACTIONS.map((a) => {
                      const count = files.filter((f) => f.action === a).length;
                      return (
                        count > 0 && (
                          <Chip key={a} size="sm" variant="soft" color={COLORS[a]}>
                            {count} {t.restoreActions[a]}
                          </Chip>
                        )
                      );
                    })}
                  </summary>
                  <ul className="m-0 list-none p-0">
                    {files.map((f) => (
                      <li key={f.path} className="flex flex-wrap items-center gap-3 border-t border-separator px-4 py-2.5">
                        <Chip size="sm" variant="soft" color={COLORS[f.action]} className="w-[76px] justify-center">
                          {t.restoreActions[f.action]}
                        </Chip>
                        <code className="min-w-0 flex-[1_1_280px] font-mono text-[12.5px] break-all">{f.path}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
              {plan.unchanged > 0 && <p className="m-0 text-sm text-muted">{t.restoreUnchanged(plan.unchanged)}</p>}
            </section>
          )}

          <div className="sticky bottom-0 -mx-7 -mb-7 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-7 py-4 backdrop-blur">
            <div className="flex flex-col gap-1">
              <Checkbox isSelected={backupFirst} onChange={setBackupFirst}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>{t.backUpFirst}</Label>
                </Checkbox.Content>
              </Checkbox>
              <span className="text-sm text-muted">
                {backupFirst ? (
                  <>
                    {t.nextBackup} <code className="font-mono text-foreground">{plan.backupDir}</code>
                  </>
                ) : (
                  t.noBackupWarning
                )}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onPress={onBack}>
                {t.back}
              </Button>
              <Button isDisabled={!!nothing} onPress={start}>
                {t.restore}
              </Button>
            </div>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-3">
          <ProgressBar aria-label={t.restoreSteps[step]} value={progress?.done ?? 0} maxValue={progress?.total ?? 100}>
            <Label>{step === 1 ? t.backingUpCard : t.restoring}</Label>
            <ProgressBar.Output />
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <code className="truncate font-mono text-xs text-muted">{progress?.text}</code>
        </div>
      )}

      {phase === 'done' && result && (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.restored}</Alert.Title>
            <Alert.Description>{t.restoredText(result.written, result.deleted, result.backup && backupLabel(result.backup))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {phase === 'done' && (
        <div>
          <Button onPress={onBack}>{t.backToBackups}</Button>
        </div>
      )}
    </div>
  );
}
