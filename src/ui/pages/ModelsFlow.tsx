import { Alert, Button, Card, Checkbox, Chip, Label, ProgressBar, Spinner, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { CopyItemView, ModelsPlanView, ModelsResultView, ProgressEvent, RadioView } from '../../server/api.ts';
import { errorText, post } from '../api.ts';
import { Stepper } from '../components/Stepper.tsx';
import { backupLabel } from '../format.ts';
import type { Texts } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';
import type { ModelsRequest } from './ModelsPage.tsx';

type Phase = 'loading' | 'plan' | 'running' | 'done' | 'error';

// Everything about one model the user should know before it is written.
function notes(t: Texts, i: CopyItemView): { text: string; warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [];
  if (i.image) out.push({ text: i.image.action === 'add' ? t.fileNew(i.image.path) : t.fileReplaced(i.image.path), warn: false });
  if (i.checklist) out.push({ text: i.checklist.action === 'add' ? t.fileNew(i.checklist.path) : t.fileReplaced(i.checklist.path), warn: false });
  for (const f of i.missing) out.push({ text: `${t.notCopied(f.path)}${f.pkg ? `, ${t.turnOnPackage(f.pkg)}` : ''}`, warn: false });
  if (i.controls.length > 0) out.push({ text: t.notOnRadio(i.controls.join(', ')), warn: true });
  if (i.module) out.push({ text: t.otherModule(i.module.model, i.module.radio ?? t.noModule), warn: true });
  if (i.screen) out.push({ text: t.otherScreen(i.screen.model, i.screen.radio), warn: true });
  if (i.newer) out.push({ text: t.newerModel(i.newer.model, i.newer.radio), warn: false });
  if (i.receiver) out.push({ text: t.receiverUsed(i.receiver.id, i.receiver.models.join(', ')), warn: false });
  return out;
}

export function ModelsFlow({ request, radio, progress, onBack }: { request: ModelsRequest; radio: RadioView; progress?: ProgressEvent; onBack: () => void }) {
  const { t } = usePrefs();
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<ModelsPlanView>();
  const [modes, setModes] = useState<('replace' | 'add' | undefined)[]>(request.copy.map(() => undefined));
  const [planned, setPlanned] = useState<typeof modes>(); // the choices the shown plan was made for
  const [anyway, setAnyway] = useState(false);
  const [backupFirst, setBackupFirst] = useState(true);
  const [result, setResult] = useState<ModelsResultView>();
  const [error, setError] = useState<unknown>();
  const copying = request.copy.length > 0;

  const body = useCallback(
    () => ({
      volume: radio.volume,
      copy: request.copy.map((c, n) => ({ ref: c.ref, ...(modes[n] ? { mode: modes[n] } : {}) })),
      delete: request.delete.map((d) => d.file),
    }),
    [radio.volume, request, modes],
  );

  useEffect(() => {
    // a quick second toggle must not be overwritten by the answer to the first
    let stale = false;
    post<ModelsPlanView>('/api/models/plan', body()).then(
      (p) => {
        if (stale) return;
        setPlan(p);
        setPlanned(modes);
        setPhase('plan');
      },
      (e: unknown) => {
        if (stale) return;
        setError(e);
        setPhase('error');
      },
    );
    return () => {
      stale = true;
    };
  }, [body, modes]);

  const start = async () => {
    setPhase('running');
    try {
      setResult(await post<ModelsResultView>('/api/models/run', { ...body(), backupFirst, force: anyway }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };

  const step = phase === 'running' ? (progress?.step === 'write' || !backupFirst ? 2 : 1) : phase === 'done' ? 3 : 0;
  const n = copying ? request.copy.length : request.delete.length;

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
          {t.backToModels}
        </Button>
      </div>

      <Stepper current={step} steps={t.modelSteps} label={t.modelStepsLabel} skipped={backupFirst ? [] : [1]} />

      {phase === 'loading' && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner size="sm" /> {t.readingModels}
        </div>
      )}

      {phase === 'error' && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.modelsFailed}</Alert.Title>
            <Alert.Description>{errorText(t, error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {phase === 'plan' && plan && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-2xl font-bold tracking-tight">{copying ? t.copyTitle(n, radio.name) : t.deleteTitle(n, radio.name)}</h1>
            <p className="m-0 text-muted">{copying ? t.copyText : t.deleteText}</p>
          </div>

          <div className="flex flex-col gap-3">
            {plan.copy.map((i, k) => (
              <Card key={k}>
                <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <Card.Title>{i.name}</Card.Title>
                    <Card.Description>
                      {request.copy[k]?.source} · {i.mode === 'replace' ? t.replacesFile(i.target) : t.newAsFile(i.target)}
                    </Card.Description>
                  </div>
                  {i.canReplace && (
                    <ToggleButtonGroup
                      aria-label={t.howToCopy(i.name)}
                      selectionMode="single"
                      disallowEmptySelection
                      size="sm"
                      selectedKeys={new Set([i.mode])}
                      onSelectionChange={(keys) => {
                        const v = [...keys][0] as 'replace' | 'add' | undefined;
                        if (v) setModes(modes.map((m, j) => (j === k ? v : m)));
                      }}
                    >
                      <ToggleButton id="replace">{t.replaceModel}</ToggleButton>
                      <ToggleButton id="add">{t.addAsNew}</ToggleButton>
                    </ToggleButtonGroup>
                  )}
                </Card.Header>
                {notes(t, i).length > 0 && (
                  <Card.Content>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                      {notes(t, i).map((x) => (
                        <li key={x.text} className={x.warn ? 'text-warning' : 'text-muted'}>
                          {x.text}
                        </li>
                      ))}
                    </ul>
                  </Card.Content>
                )}
              </Card>
            ))}
            {plan.delete.map((d) => (
              <Card key={d.file}>
                <Card.Header>
                  <Card.Title>{d.name}</Card.Title>
                  <Card.Description className="font-mono">{t.movesToDeleted(d.moves.map((f) => `MODELS/${f}`).join(', '))}</Card.Description>
                </Card.Header>
                {d.active && (
                  <Card.Content>
                    <Chip size="sm" variant="soft" color="warning">
                      {t.activeModel}
                    </Chip>
                  </Card.Content>
                )}
              </Card>
            ))}
          </div>

          {plan.confirm && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t.copyAnywayText}</Alert.Description>
                <Checkbox variant="secondary" isSelected={anyway} onChange={setAnyway} className="mt-2">
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Label>{t.copyAnyway}</Label>
                  </Checkbox.Content>
                </Checkbox>
              </Alert.Content>
            </Alert>
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
                {t.nextBackup} <code className="font-mono text-foreground">{plan.backupDir}</code>
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onPress={onBack}>
                {t.back}
              </Button>
              <Button isDisabled={(plan.confirm && !anyway) || planned !== modes} onPress={start}>
                {copying ? t.copyModels : t.deleteModels}
              </Button>
            </div>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-3">
          <ProgressBar aria-label={t.modelSteps[step]} value={progress?.done ?? 0} maxValue={progress?.total ?? 100}>
            <Label>{step === 1 ? t.backingUpCard : t.writingModels}</Label>
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
            <Alert.Title>{copying ? t.modelsCopied : t.modelsDeleted}</Alert.Title>
            <Alert.Description>{t.modelsDoneText(result.written + result.moved, result.backup && backupLabel(result.backup))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {phase === 'done' && (
        <div>
          <Button onPress={onBack}>{t.backToModels}</Button>
        </div>
      )}
    </div>
  );
}
