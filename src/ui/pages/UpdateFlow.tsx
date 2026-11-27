import { Alert, Button, Chip, Label, Modal, ProgressBar, Radio, RadioGroup, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { Action, ConflictFileView, PlanFileView, PlanView, ProgressEvent, RadioView, UpdateResultView } from '../../server/api.ts';
import { ApiError, errorText, post } from '../api.ts';
import { WarningIcon } from '../components/icons.tsx';
import { Stepper } from '../components/Stepper.tsx';
import { backupLabel, isLastWrite } from '../format.ts';
import { COLORS, tileClass } from '../planColors.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'plan' | 'running' | 'done' | 'error';
type Resolution = 'keep' | 'apply';
type FileAction = Exclude<Action, 'unchanged'>;

const LINE_CLASS = { same: '', add: 'bg-success-soft text-success-soft-foreground', del: 'bg-danger-soft text-danger-soft-foreground' } as const;

// The file on the card against the one the update would write, line by line.
function ConflictDiff({ volume, f, onClose }: { volume: string; f: PlanFileView; onClose: () => void }) {
  const { t } = usePrefs();
  const [view, setView] = useState<ConflictFileView>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    post<ConflictFileView>('/api/update/conflict', { volume, path: f.path }).then(setView, setError);
  }, [volume, f.path]);
  const changed = view?.lines?.some((l) => l.kind === 'add' || l.kind === 'del');
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.close} />
          <Modal.Header className="flex flex-col items-start gap-1">
            <Modal.Heading>{t.diffTitle(f.path.split('/').pop() ?? f.path)}</Modal.Heading>
            <span className="text-sm text-muted">{view ? t.conflictSides(f.pkg, view.version) : f.path}</span>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {error !== undefined ? (
              <p className="m-0 text-danger">{errorText(t, error)}</p>
            ) : !view ? (
              <Spinner size="sm" />
            ) : view.binary ? (
              <p className="m-0 text-muted">{t.conflictBinary}</p>
            ) : view.tooLarge ? (
              <p className="m-0 text-muted">{t.conflictTooLarge}</p>
            ) : !changed ? (
              // the comparison ignores Windows line ends and a missing last line break
              <p className="m-0 text-muted">{t.onlyLineEnds}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Chip size="sm" variant="soft" color="danger">{t.onCardOnly}</Chip>
                  <Chip size="sm" variant="soft" color="success">{t.newOnly}</Chip>
                </div>
                <pre className="m-0 overflow-x-auto rounded-2xl border border-border py-2 font-mono text-[12.5px] leading-5">
                  {view.lines!.map((l, i) =>
                    l.kind === 'skip' ? (
                      <div key={i} className="px-4 py-0.5 font-sans text-xs text-muted">{t.unchangedLines(l.n)}</div>
                    ) : (
                      <div key={i} className={`px-4 whitespace-pre-wrap ${LINE_CLASS[l.kind]}`}>
                        <span aria-hidden className="inline-block w-4 select-none">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                        <span className="sr-only">{l.kind === 'add' ? t.newOnly : l.kind === 'del' ? t.onCardOnly : ''}</span>
                        {l.text || ' '}
                      </div>
                    ),
                  )}
                </pre>
              </>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function FileRow({ f }: { f: PlanFileView }) {
  const { t } = usePrefs();
  const action = f.action as Exclude<Action, 'unchanged'>;
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-separator px-4 py-2.5">
      <Chip size="sm" variant="soft" color={COLORS[action]} className="w-[76px] justify-center">
        {t.actions[action]}
      </Chip>
      <code className="min-w-0 flex-[1_1_280px] font-mono text-[12.5px] break-all">{f.path}</code>
      {f.others && <span className="text-xs text-muted">{t.alsoIn(f.others.join(', '))}</span>}
    </li>
  );
}

function Conflict({ volume, f, value, onChange }: { volume: string; f: PlanFileView; value: Resolution; onChange: (r: Resolution) => void }) {
  const { t } = usePrefs();
  const [diff, setDiff] = useState(false);
  const deleting = f.reason === 'removed-modified';
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-warning bg-warning-soft/40 px-5 py-4">
      <div className="flex items-center gap-2.5 text-warning-soft-foreground">
        <WarningIcon size={20} />
        <h3 className="m-0 text-[15px] font-semibold">{t.conflict(f.path.split('/').pop() ?? f.path)}</h3>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="font-mono text-[13px] break-all">{f.path}</code>
        <Button size="sm" variant="ghost" onPress={() => setDiff(true)}>
          {t.showDifferences}
        </Button>
      </div>
      {diff && <ConflictDiff volume={volume} f={f} onClose={() => setDiff(false)} />}
      <p className="m-0 text-sm text-warning-soft-foreground">
        {t.reasons[f.reason!](f.pkg)}
      </p>
      <RadioGroup
        variant="secondary"
        aria-label={t.whatToDo(f.path)}
        value={value}
        onChange={(v) => onChange(v as Resolution)}
        orientation="horizontal"
        className="gap-2.5"
      >
        {(
          [
            ['keep', t.keepFile],
            ['apply', deleting ? t.deleteIt : t.overwrite],
          ] as const
        ).map(([id, label]) => (
          <Radio key={id} value={id} className="group min-w-56 flex-1">
            <Radio.Content className="min-h-12 w-full rounded-xl border border-border bg-surface px-4 group-data-selected:border-2 group-data-selected:border-accent group-data-selected:px-[15px]">
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <Label>{label}</Label>
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>
      <p className="m-0 text-sm text-muted">{t.keptByDefault}</p>
    </section>
  );
}

export function UpdateFlow({ radio, progress, onBack, onPhase }: { radio: RadioView; progress?: ProgressEvent; onBack: () => void; onPhase: (p: Phase) => void }) {
  const { t } = usePrefs();
  const [phase, setPhase] = useState<Phase>('loading');
  useEffect(() => onPhase(phase), [phase, onPhase]);
  const [plan, setPlan] = useState<PlanView>();
  const [result, setResult] = useState<UpdateResultView>();
  const [error, setError] = useState<unknown>();
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [cancelling, setCancelling] = useState(false);
  // a tile pressed in the plan: only files with that action in the list below
  const [filter, setFilter] = useState<FileAction>();

  useEffect(() => {
    post<PlanView>('/api/update/plan', { volume: radio.volume }).then(
      (p) => {
        setPlan(p);
        setPhase('plan');
      },
      (e: unknown) => {
        setError(e);
        setPhase('error');
      },
    );
  }, [radio.volume]);

  const start = async () => {
    setPhase('running');
    try {
      setResult(await post<UpdateResultView>('/api/update/run', { volume: radio.volume, resolutions }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };

  const step = phase === 'running' ? (progress?.step === 'write' ? 3 : 2) : phase === 'done' ? 4 : 1;
  // after the last file the list and the cleanup are written, which takes a moment on the radio's slow USB
  const finishing = phase === 'running' && isLastWrite(progress);
  const c = plan?.counts;
  const nothing = c && c.add + c.replace + c.delete + c.conflict === 0;
  const cancelled = error instanceof ApiError && error.info.code === 'updateCancelled';

  return (
    <div className="flex flex-1 flex-col gap-7">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-bold">{radio.label}</span>
        <span className="font-mono text-xs text-muted">
          {radio.board} · EdgeTX {radio.firmware} · {radio.sounds.join(', ')}
        </span>
      </div>

      <Stepper current={step} steps={t.steps} label={t.stepsLabel} />

      {phase === 'loading' && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner size="sm" /> {t.reading}
        </div>
      )}

      {phase === 'error' && (
        <Alert status={cancelled ? 'warning' : 'danger'}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{cancelled ? t.updateCancelled : t.updateFailed}</Alert.Title>
            <Alert.Description>{errorText(t, error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {phase === 'plan' && plan && c && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-2xl font-bold tracking-tight">{t.reviewTitle}</h1>
            <p className="m-0 text-muted">{t.reviewText}</p>
          </div>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            {(['add', 'replace', 'delete', 'conflict'] as const).map((a) => (
              <button
                key={a}
                type="button"
                disabled={c[a] === 0}
                aria-pressed={filter === a}
                aria-label={t.filterFiles(c[a], t.actions[a])}
                onClick={() => setFilter(filter === a ? undefined : a)}
                className={`flex flex-col rounded-2xl px-4 py-3.5 text-left ${tileClass(a, c[a])} ${c[a] > 0 ? 'cursor-pointer hover:brightness-95' : ''} ${
                  filter === a ? 'outline-2 outline-offset-2 outline-accent' : ''
                } ${a === 'conflict' && c[a] > 0 ? 'ring-2 ring-warning ring-inset' : ''} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
              >
                <span className="text-[26px] font-bold">{c[a]}</span>
                <span className="text-sm">{t.actions[a]}</span>
              </button>
            ))}
          </div>

          {plan.missing.length > 0 && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.notAvailable}</Alert.Title>
                <Alert.Description>{t.notAvailableText(plan.missing.join(', '))}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {plan.conflicts.length > 1 && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onPress={() => setResolutions({})}>
                {t.keepAll}
              </Button>
              <Button
                variant="outline"
                isDisabled={!plan.conflicts.some((f) => f.reason !== 'removed-modified')}
                onPress={() =>
                  setResolutions((prev) => ({
                    ...prev,
                    ...Object.fromEntries(plan.conflicts.filter((f) => f.reason !== 'removed-modified').map((f) => [f.path, 'apply' as const])),
                  }))
                }
              >
                {t.overwriteAll}
              </Button>
            </div>
          )}

          {plan.conflicts.map((f) => (
            <Conflict
              key={f.path}
              volume={radio.volume}
              f={f}
              value={resolutions[f.path] ?? 'keep'}
              onChange={(r) => setResolutions((prev) => ({ ...prev, [f.path]: r }))}
            />
          ))}

          {nothing ? (
            <p className="m-0 text-muted">{t.nothing}</p>
          ) : (
            <section aria-labelledby="files" className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 id="files" className="m-0 text-base font-semibold">
                  {filter ? t.filesOnly(t.actions[filter]) : t.files}
                </h2>
                {filter && (
                  <Button size="sm" variant="ghost" onPress={() => setFilter(undefined)}>
                    {t.showAllFiles}
                  </Button>
                )}
              </div>
              {plan.groups.map((g) => ({ ...g, files: filter ? g.files.filter((f) => f.action === filter) : g.files })).filter((g) => g.files.length > 0).map((g) => (
                <details
                  key={`${g.name}-${filter ?? ''}`}
                  open={!!filter || g.files.length <= 20 || g.files.some((f) => f.action === 'conflict')}
                  className="overflow-hidden rounded-2xl border border-border"
                >
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 bg-surface-secondary px-4 py-3">
                    <span className="flex-auto">
                      <span className="font-semibold">{g.name}</span>{' '}
                      <span className="font-mono text-xs text-muted">
                        {g.from && g.to && g.from !== g.to ? `${g.from} → ${g.to}` : (g.to ?? g.from)}
                      </span>
                    </span>
                    {(['add', 'replace', 'delete', 'conflict'] as const).map((a) => {
                      const count = g.files.filter((f) => f.action === a).length;
                      return (
                        count > 0 && (
                          <Chip key={a} size="sm" variant="soft" color={COLORS[a]}>
                            {count} {t.actions[a]}
                          </Chip>
                        )
                      );
                    })}
                  </summary>
                  <ul className="m-0 list-none p-0">
                    {g.files.map((f) => (
                      <FileRow key={f.path} f={f} />
                    ))}
                  </ul>
                </details>
              ))}
              {plan.luac > 0 && (
                <p className="m-0 text-sm text-muted">{t.luac(plan.luac)}</p>
              )}
            </section>
          )}

          <div className="page-bar sticky bottom-0 -mb-7 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background py-4">
            <div className="flex gap-2">
              <Button variant="outline" onPress={onBack}>
                {t.back}
              </Button>
              <Button isDisabled={!!nothing} onPress={start}>
                {t.backUpAndUpdate}
              </Button>
            </div>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-3">
          <ProgressBar
            aria-label={step === 2 ? t.steps[2] : t.steps[3]}
            value={progress?.done ?? 0}
            maxValue={progress?.total ?? 100}
            isIndeterminate={finishing}
          >
            <Label>{finishing ? t.finishing : step === 2 ? t.backingUpCard : t.writingCard}</Label>
            {!finishing && <ProgressBar.Output />}
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <code className="truncate font-mono text-xs text-muted">{finishing ? '' : progress?.text}</code>
          <div>
            <Button
              variant="tertiary"
              isDisabled={cancelling || finishing}
              onPress={() => {
                setCancelling(true);
                void post('/api/cancel');
              }}
            >
              {t.cancel}
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.updated}</Alert.Title>
            <Alert.Description>{t.updatedText(result.written, result.deleted, result.kept, backupLabel(result.backup, t.locale))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {(phase === 'done' || phase === 'error') && (
        <div>
          <Button onPress={onBack}>{t.backToRadio}</Button>
        </div>
      )}
    </div>
  );
}
