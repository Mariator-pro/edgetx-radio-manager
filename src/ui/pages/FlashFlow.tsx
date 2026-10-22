import { Alert, Button, Label, ListBox, ProgressBar, Select, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { FirmwareView, FlashResultView, ProgressEvent } from '../../server/api.ts';
import { errorText, get, post } from '../api.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'ready' | 'running' | 'done' | 'error';

export function FlashFlow({ board, name, progress, onBack }: { board: string; name: string; progress?: ProgressEvent; onBack: () => void }) {
  const { t } = usePrefs();
  const [fw, setFw] = useState<FirmwareView>();
  const [tag, setTag] = useState<string>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<FlashResultView>();

  useEffect(() => {
    get<FirmwareView>(`/api/firmware?board=${board}`).then(
      (v) => {
        setFw(v);
        setTag(v.versions[0]);
        setPhase('ready');
      },
      (e: unknown) => {
        setError(e);
        setPhase('error');
      },
    );
  }, [board]);

  const start = async () => {
    setPhase('running');
    setError(undefined);
    try {
      setResult(await post<FlashResultView>('/api/firmware/flash', { board, tag }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('ready');
    }
  };

  const blocked = fw?.method === 'dfu' && fw.dfuUtil === false;
  const writing = phase === 'running' && progress?.op === 'flash' && progress.step === 'flash';

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t.flashFirmware}</span>
          <h1 className="m-0 text-3xl font-bold tracking-tight">{name}</h1>
        </div>
        <Button variant="ghost" isDisabled={phase === 'running'} onPress={onBack}>
          {t.back}
        </Button>
      </div>

      {phase === 'loading' && <Spinner />}

      {error !== undefined && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.flashFailed}</Alert.Title>
            <Alert.Description>{errorText(t, error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {fw && phase !== 'done' && (
        <>
          {fw.versions.length === 0 ? (
            <p className="m-0 text-muted">{t.noFirmware}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-6">
              <Select
                className="min-w-48"
                selectedKey={tag ?? null}
                isDisabled={phase === 'running'}
                onSelectionChange={(k) => k !== null && setTag(String(k))}
              >
                <Label>{t.edgetxVersion}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {fw.versions.map((v) => (
                      <ListBox.Item key={v} id={v} textValue={v}>
                        {v}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <span className="pb-2 text-sm text-muted">{t.installed(fw.installed ?? t.unknown)}</span>
            </div>
          )}

          {blocked && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.dfuMissing}</Alert.Title>
                <Alert.Description>{t.dfuMissingText(name)}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {fw.method && (
            <section aria-labelledby="steps" className="flex flex-col gap-3 rounded-2xl border border-border p-5">
              <h2 id="steps" className="m-0 text-base font-semibold">
                {fw.method === 'uf2' ? t.startBootloader : t.startDfu}
              </h2>
              <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
                {t.flashSteps[fw.method].map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="m-0 text-sm text-muted">{t.flashHint}</p>
            </section>
          )}

          {phase === 'running' && (
            <div className="flex flex-col gap-3">
              {writing && progress?.done !== undefined ? (
                <ProgressBar aria-label={t.writingFirmware} value={progress.done} maxValue={100}>
                  <Label>{t.writingFile(progress.file ?? '')}</Label>
                  <ProgressBar.Output />
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
              ) : (
                <div className="flex items-center gap-3">
                  <Spinner size="sm" />
                  <span>{progress?.op === 'flash' ? (fw.method === 'uf2' ? t.waitingUf2 : t.waitingDfu) : t.starting}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {phase === 'running' ? (
              <Button variant="outline" isDisabled={writing} onPress={() => void post('/api/firmware/cancel')}>
                {t.cancel}
              </Button>
            ) : (
              <Button isDisabled={!tag || blocked} onPress={start}>
                {t.startFlashing}
              </Button>
            )}
          </div>
        </>
      )}

      {phase === 'done' && result && (
        <>
          <Alert status="success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t.flashed}</Alert.Title>
              <Alert.Description>{t.flashedText(result.file, tag ?? '')}</Alert.Description>
            </Alert.Content>
          </Alert>
          <div>
            <Button onPress={onBack}>{t.done}</Button>
          </div>
        </>
      )}
    </div>
  );
}
