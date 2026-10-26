import { Alert, Button, Checkbox, Label, ListBox, ProgressBar, Select, Spinner, Switch } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FirmwareCatalogView, FirmwareFileView, FirmwareView, FlashResultView, ProgressEvent } from '../../server/api.ts';
import { errorText, get, post, postFile } from '../api.ts';
import { bytes, isNewer } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'ready' | 'running' | 'done' | 'error';

export function FlashFlow({ board, name, progress, onBack }: { board: string; name: string; progress?: ProgressEvent; onBack: () => void }) {
  const { t } = usePrefs();
  const [fw, setFw] = useState<FirmwareView>();
  const [tag, setTag] = useState<string>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<FlashResultView>();
  // an own firmware file instead of a downloaded version, and the confirmation for one without identification
  const [file, setFile] = useState<FirmwareFileView>();
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // compatible releases on GitHub that are not downloaded; empty when offline
  const [remote, setRemote] = useState<FirmwareCatalogView['versions']>([]);

  const loadCatalog = useCallback(
    () =>
      get<FirmwareCatalogView>(`/api/firmware/catalog?board=${board}`).then(
        (c) => setRemote(c.versions),
        () => setRemote([]),
      ),
    [board],
  );

  // Preselects the newest finished release, also when release candidates are listed.
  const show = (v: FirmwareView) => {
    setFw(v);
    setTag((old) => (old && v.versions.includes(old) ? old : (v.versions.find((x) => !v.prereleases.includes(x)) ?? v.versions[0])));
  };

  useEffect(() => {
    get<FirmwareView>(`/api/firmware?board=${board}`).then(
      (v) => {
        show(v);
        setPhase('ready');
        void loadCatalog();
      },
      (e: unknown) => {
        setError(e);
        setPhase('error');
      },
    );
  }, [board, loadCatalog]);

  const toggleCandidates = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      show(await post<FirmwareView>('/api/firmware/prereleases', { board, on }));
      await loadCatalog();
    } catch (e) {
      setError(e);
      show(await get<FirmwareView>(`/api/firmware?board=${board}`));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setBusy(true);
    setError(undefined);
    setFile(undefined);
    setForce(false);
    try {
      setFile(await postFile<FirmwareFileView>(`/api/firmware/file?board=${board}&name=${encodeURIComponent(chosen.name)}`, chosen));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const start = async () => {
    setPhase('running');
    setError(undefined);
    try {
      setResult(await post<FlashResultView>('/api/firmware/flash', file ? { board, file: true, force } : { board, tag }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('ready');
    }
  };

  const method = file?.method ?? fw?.method;
  const blocked = method === 'dfu' && fw?.dfuUtil === false;
  const isOlder = (v: string) => !!fw?.installed && isNewer(fw.installed, v);
  const isCandidate = (v: string) => !!fw?.prereleases.includes(v) || !!remote.find((r) => r.tag === v)?.prerelease;
  const version = file ? file.version : tag;
  const names: Record<string, string> = { ...Object.fromEntries(remote.filter((r) => r.name).map((r) => [r.tag, r.name!])), ...fw?.names };
  const label = (v: string) => names[v] ?? v;
  const notes = (v: string) =>
    [isCandidate(v) && t.releaseCandidate, isOlder(v) && t.downgrade].filter(Boolean).join(', ');
  // downloaded and not yet downloaded versions together, newest first
  const versions = fw ? [...fw.versions, ...remote.map((r) => r.tag).filter((v) => !fw.versions.includes(v))].sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0)) : [];
  const ready = file ? !!file.board || force : !!tag;
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
          {file ? (
            <section aria-labelledby="own-file" className="flex flex-col gap-3 rounded-2xl border border-border p-5">
              <h2 id="own-file" className="m-0 text-base font-semibold">
                {t.ownFile}
              </h2>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="font-mono text-sm">{file.name}</span>
                  <span className="text-sm text-muted">
                    {file.version ? t.fileFor(file.version, name) : t.fileUnknown} · {bytes(file.size)}
                  </span>
                </span>
                <Button variant="ghost" isDisabled={phase === 'running'} onPress={() => setFile(undefined)}>
                  {t.useDownloaded}
                </Button>
              </div>
              {!file.board && (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.fileUnknown}</Alert.Title>
                    <Alert.Description>{t.fileUnknownText(file.name)}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
              {!file.board && (
                <Checkbox isSelected={force} isDisabled={phase === 'running'} onChange={setForce}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Label>{t.flashAnyway}</Label>
                  </Checkbox.Content>
                </Checkbox>
              )}
            </section>
          ) : versions.length === 0 ? (
            <p className="m-0 text-muted">{t.noFirmware}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-6">
              <Select
                className="min-w-96"
                selectedKey={tag ?? null}
                isDisabled={phase === 'running' || busy}
                onSelectionChange={(k) => k !== null && setTag(String(k))}
              >
                <Label>{t.edgetxVersion}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover placement="bottom start">
                  <ListBox>
                    {versions.map((v) => (
                      <ListBox.Item key={v} id={v} textValue={label(v)}>
                        {label(v)}
                        {notes(v) && <span className="text-muted">· {notes(v)}</span>}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <span className="pb-2 text-sm text-muted">{t.installed(fw.installed ?? t.unknown)}</span>
            </div>
          )}

          {!file && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Switch isSelected={fw.includePrereleases} isDisabled={phase === 'running' || busy} onChange={(on) => void toggleCandidates(on)}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t.releaseCandidates}</Label>
                </Switch.Content>
              </Switch>
              <span className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" isDisabled={phase === 'running' || busy} onPress={() => picker.current?.click()}>
                  {t.chooseFile}
                </Button>
                <span className="text-sm text-muted">{t.ownFileHint(fw.method === 'uf2' ? '.uf2' : fw.method === 'dfu' ? '.bin' : '.uf2 / .bin')}</span>
              </span>
              <input
                ref={picker}
                type="file"
                accept={fw.method === 'uf2' ? '.uf2' : fw.method === 'dfu' ? '.bin' : '.uf2,.bin'}
                hidden
                aria-label={t.ownFile}
                onChange={(e) => void chooseFile(e.target.files?.[0])}
              />
              {busy && <Spinner size="sm" aria-label={t.checkingFile} />}
            </div>
          )}

          {!file && tag && isCandidate(tag) && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.releaseCandidateTitle(tag)}</Alert.Title>
                <Alert.Description>{t.releaseCandidateText}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {version && isOlder(version) && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t.downgradeTitle(version)}</Alert.Title>
                <Alert.Description>{t.downgradeText}</Alert.Description>
              </Alert.Content>
            </Alert>
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

          {method && (
            <section aria-labelledby="steps" className="flex flex-col gap-3 rounded-2xl border border-border p-5">
              <h2 id="steps" className="m-0 text-base font-semibold">
                {method === 'uf2' ? t.startBootloader : t.startDfu}
              </h2>
              <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
                {t.flashSteps[method].map((step) => (
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
                  <span>
                    {progress?.op !== 'flash'
                      ? t.starting
                      : progress.step === 'download'
                        ? t.downloadingVersion(label(progress.file ?? ''))
                        : progress.step === 'flash'
                          ? t.writingFile(progress.file ?? '')
                          : method === 'uf2'
                          ? t.waitingUf2
                          : t.waitingDfu}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {phase === 'running' ? (
              <Button variant="outline" isDisabled={writing} onPress={() => void post('/api/cancel')}>
                {t.cancel}
              </Button>
            ) : (
              <Button isDisabled={!ready || blocked || busy} onPress={start}>
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
              <Alert.Description>{result.version ? t.flashedText(result.file, result.version) : t.flashedFileText(result.file)}</Alert.Description>
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
