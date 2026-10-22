import { Alert, Button, Chip, Label, ProgressBar, Radio, RadioGroup, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { Action, PlanFileView, PlanView, ProgressEvent, RadioView, UpdateResultView } from '../../server/api.ts';
import { errorText, post } from '../api.ts';
import { CheckIcon, WarningIcon } from '../components/icons.tsx';
import { backupLabel } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'plan' | 'running' | 'done' | 'error';
type Resolution = 'keep' | 'apply';

const COLORS: Record<Exclude<Action, 'unchanged'>, 'success' | 'accent' | 'danger' | 'warning'> = {
  add: 'success',
  replace: 'accent',
  delete: 'danger',
  conflict: 'warning',
};

// Full class names, so Tailwind finds them.
const TILES: Record<Exclude<Action, 'unchanged'>, string> = {
  add: 'bg-success-soft text-success-soft-foreground',
  replace: 'bg-accent-soft text-accent-soft-foreground',
  delete: 'bg-danger-soft text-danger-soft-foreground',
  conflict: 'bg-warning-soft text-warning-soft-foreground',
};

function Stepper({ current }: { current: number }) {
  const { t } = usePrefs();
  return (
    <ol aria-label={t.stepsLabel} className="m-0 grid list-none grid-cols-4 gap-2 p-0">
      {t.steps.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={label} aria-current={now ? 'step' : undefined} className="flex flex-col gap-2">
            <span className={`h-1 rounded-full ${done || now ? 'bg-accent' : 'bg-border'}`} aria-hidden="true" />
            <span className={`flex items-center gap-2 text-sm ${now ? 'font-semibold' : ''} ${done || now ? '' : 'text-muted'}`}>
              <span
                className={`inline-flex size-[22px] items-center justify-center rounded-full text-xs font-semibold ${
                  done || now ? 'bg-accent text-accent-foreground' : 'bg-surface-secondary text-muted'
                }`}
              >
                {done ? <CheckIcon size={13} /> : i + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
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

function Conflict({ f, value, onChange }: { f: PlanFileView; value: Resolution; onChange: (r: Resolution) => void }) {
  const { t } = usePrefs();
  const deleting = f.reason === 'removed-modified';
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-warning bg-warning-soft/40 px-5 py-4">
      <div className="flex items-center gap-2.5 text-warning-soft-foreground">
        <WarningIcon size={20} />
        <h3 className="m-0 text-[15px] font-semibold">{t.conflict(f.path.split('/').pop() ?? f.path)}</h3>
      </div>
      <code className="font-mono text-[13px]">{f.path}</code>
      <p className="m-0 text-sm text-warning-soft-foreground">
        {t.reasons[f.reason!]} {t.from(f.pkg)}
      </p>
      <RadioGroup
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

export function UpdateFlow({ radio, progress, onBack }: { radio: RadioView; progress?: ProgressEvent; onBack: () => void }) {
  const { t } = usePrefs();
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<PlanView>();
  const [result, setResult] = useState<UpdateResultView>();
  const [error, setError] = useState<unknown>();
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});

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
  const c = plan?.counts;
  const nothing = c && c.add + c.replace + c.delete + c.conflict === 0;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-bold">{radio.name}</span>
          <span className="font-mono text-xs text-muted">
            {radio.board} · EdgeTX {radio.firmware} · {radio.sounds.join(', ')}
          </span>
        </div>
        <Button variant="ghost" size="sm" isDisabled={phase === 'running'} onPress={onBack}>
          {t.changeSources}
        </Button>
      </div>

      <Stepper current={step} />

      {phase === 'loading' && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner size="sm" /> {t.reading}
        </div>
      )}

      {phase === 'error' && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.updateFailed}</Alert.Title>
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
              <div
                key={a}
                className={`flex flex-col rounded-2xl px-4 py-3.5 ${TILES[a]} ${a === 'conflict' && c[a] > 0 ? 'ring-2 ring-warning ring-inset' : ''}`}
              >
                <span className="text-[26px] font-bold">{c[a]}</span>
                <span className="text-sm">{t.actions[a]}</span>
              </div>
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
              f={f}
              value={resolutions[f.path] ?? 'keep'}
              onChange={(r) => setResolutions((prev) => ({ ...prev, [f.path]: r }))}
            />
          ))}

          {nothing ? (
            <p className="m-0 text-muted">{t.nothing}</p>
          ) : (
            <section aria-labelledby="files" className="flex flex-col gap-3.5">
              <h2 id="files" className="m-0 text-base font-semibold">
                {t.files}
              </h2>
              {plan.groups.map((g) => (
                <details
                  key={g.name}
                  open={g.files.length <= 20 || g.files.some((f) => f.action === 'conflict')}
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

          <div className="sticky bottom-0 -mx-7 -mb-7 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-7 py-4 backdrop-blur">
            <span className="text-sm text-muted">
              {t.nextBackup} <code className="font-mono text-foreground">{plan.backupDir}</code>
            </span>
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
          >
            <Label>{step === 2 ? t.backingUpCard : t.writingCard}</Label>
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
            <Alert.Title>{t.updated}</Alert.Title>
            <Alert.Description>{t.updatedText(result.written, result.deleted, result.kept, backupLabel(result.backup))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {phase === 'done' && (
        <div>
          <Button onPress={onBack}>{t.backToRadio}</Button>
        </div>
      )}
    </div>
  );
}
