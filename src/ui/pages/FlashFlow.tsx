import { Alert, Button, Checkbox, Label, ListBox, ProgressBar, Select, Spinner, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FirmwareCatalogView, FirmwareFileView, FirmwareView, FlashResultView, ProgressEvent } from '../../server/api.ts';
import { errorText, get, post, postFile } from '../api.ts';
import { CheckIcon } from '../components/icons.tsx';
import { bytes, isNewer } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Phase = 'loading' | 'ready' | 'running' | 'done' | 'error';

// How long the app waits for the radio after "Start flashing" (waitFor in the core).
const WAIT_MS = 5 * 60_000;
const minSec = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

export function FlashFlow({ board, name, progress, onBack, onPhase }: { board: string; name: string; progress?: ProgressEvent; onBack: () => void; onPhase: (p: Phase) => void }) {
  const { t } = usePrefs();
  const [fw, setFw] = useState<FirmwareView>();
  const [tag, setTag] = useState<string>();
  const [phase, setPhase] = useState<Phase>('loading');
  useEffect(() => onPhase(phase), [phase, onPhase]);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<FlashResultView>();
  // an own firmware file instead of a downloaded version, and the confirmation for one without identification
  const [file, setFile] = useState<FirmwareFileView>();
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  // where the firmware comes from: a downloaded EdgeTX version or an own file
  const [mode, setMode] = useState<'release' | 'file'>('release');
  // time left while the app waits for the radio, counted down once a second
  const [left, setLeft] = useState(WAIT_MS);
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
      setResult(await post<FlashResultView>('/api/firmware/flash', mode === 'file' ? { board, file: true, force } : { board, tag }));
      setPhase('done');
    } catch (e) {
      setError(e);
      setPhase('ready');
    }
  };

  const waiting = phase === 'running' && progress?.op === 'flash' && progress.step === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    const begin = Date.now();
    const timer = setInterval(() => setLeft(Math.max(0, WAIT_MS - (Date.now() - begin))), 1000);
    return () => {
      clearInterval(timer);
      setLeft(WAIT_MS);
    };
  }, [waiting]);

  // a chosen file counts only while "Own file" is selected; it stays chosen when switching back and forth
  const own = mode === 'file' ? file : undefined;
  const method = own?.method ?? fw?.method;
  const blocked = method === 'dfu' && fw?.dfuUtil === false;
  const isOlder = (v: string) => !!fw?.installed && isNewer(fw.installed, v);
  const isCandidate = (v: string) => !!fw?.prereleases.includes(v) || !!remote.find((r) => r.tag === v)?.prerelease;
  const version = mode === 'file' ? own?.version : tag;
  const names: Record<string, string> = { ...Object.fromEntries(remote.filter((r) => r.name).map((r) => [r.tag, r.name!])), ...fw?.names };
  const label = (v: string) => names[v] ?? v;
  const notes = (v: string) =>
    [isCandidate(v) && t.releaseCandidate, isOlder(v) && t.downgrade].filter(Boolean).join(', ');
  // downloaded and not yet downloaded versions together, newest first
  const versions = fw ? [...fw.versions, ...remote.map((r) => r.tag).filter((v) => !fw.versions.includes(v))].sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0)) : [];
  const ready = mode === 'file' ? !!file && (!!file.board || force) : !!tag;
  const writing = phase === 'running' && progress?.op === 'flash' && progress.step === 'flash';

  return (
    <div className="flex flex-col gap-6 [&>*:not(:first-child)]:max-w-3xl">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted">{t.flashFirmware}</span>
        <h1 className="m-0 text-3xl font-bold tracking-tight">{name}</h1>
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
          <ToggleButtonGroup
            aria-label={t.firmwareSource}
            selectionMode="single"
            disallowEmptySelection
            isDisabled={phase === 'running' || busy}
            selectedKeys={new Set([mode])}
            onSelectionChange={(keys) => {
              const m = [...keys][0];
              if (m) setMode(String(m) as 'release' | 'file');
            }}
          >
            <ToggleButton id="release">{t.fromVersion}</ToggleButton>
            <ToggleButton id="file">{t.fromOwnFile}</ToggleButton>
          </ToggleButtonGroup>

          {mode === 'file' ? (
            <section aria-labelledby="own-file" className="flex flex-col gap-3 rounded-2xl border border-border p-5">
              <h2 id="own-file" className="m-0 text-base font-semibold">
                {t.ownFile}
              </h2>
              <div className="flex flex-wrap items-center justify-between gap-3">
                {file ? (
                  <span className="flex flex-col">
                    <span className="font-mono text-sm">{file.name}</span>
                    <span className="text-sm text-muted">
                      {file.version ? t.fileFor(file.version, name) : t.fileUnknown} · {bytes(file.size)}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-muted">{t.ownFileHint(fw.method === 'uf2' ? '.uf2' : fw.method === 'dfu' ? '.bin' : '.uf2 / .bin')}</span>
                )}
                <span className="flex items-center gap-2">
                  {busy && <Spinner size="sm" aria-label={t.checkingFile} />}
                  <Button variant="outline" isDisabled={phase === 'running' || busy} onPress={() => picker.current?.click()}>
                    {file ? t.otherFile : t.chooseFile}
                  </Button>
                </span>
              </div>
              <input
                ref={picker}
                type="file"
                accept={fw.method === 'uf2' ? '.uf2' : fw.method === 'dfu' ? '.bin' : '.uf2,.bin'}
                hidden
                aria-label={t.ownFile}
                onChange={(e) => void chooseFile(e.target.files?.[0])}
              />
              {file && !file.board && (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.fileUnknown}</Alert.Title>
                    <Alert.Description>{t.fileUnknownText(file.name)}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
              {file && !file.board && (
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
          ) : (
            <div className="flex flex-col gap-4">
              {versions.length === 0 ? (
                <p className="m-0 text-muted">{t.noFirmware}</p>
              ) : (
                <div className="flex flex-wrap items-end gap-6">
                  <Select
                    variant="secondary"
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
                    <Select.Popover className="field-list" placement="bottom start">
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
              <div className="flex items-center gap-3">
                <Switch isSelected={fw.includePrereleases} isDisabled={phase === 'running' || busy} onChange={(on) => void toggleCandidates(on)}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Label>{t.releaseCandidates}</Label>
                  </Switch.Content>
                </Switch>
                {busy && <Spinner size="sm" />}
              </div>
            </div>
          )}

          {mode === 'release' && tag && isCandidate(tag) && (
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

          {/* start first, then the steps; while it runs, the status and "Cancel" sit below the steps.
              No back button, the sidebar leads back. */}
          {phase !== 'running' && (
            <div className="flex gap-2">
              <Button isDisabled={!ready || blocked || busy} onPress={start}>
                {t.startFlashing}
              </Button>
            </div>
          )}

          {method && (
            <section aria-labelledby="steps" className="flex flex-col gap-3 rounded-2xl border border-border p-5">
              <h2 id="steps" className="m-0 text-base font-semibold">
                {method === 'uf2' ? t.startBootloader : t.startDfu}
              </h2>
              <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
                {t.flashSteps[method].map((step, i) => {
                  // the app can't see the steps done by hand; once the radio shows up (as a drive or in DFU mode),
                  // everything up to that step is done
                  const connect = method === 'uf2' ? 2 : 1;
                  const checked = writing && i <= connect;
                  return (
                    <li key={step} className="flex items-start gap-3">
                      <span
                        className={`mt-0.5 inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                          checked ? 'bg-success-soft text-success-soft-foreground' : 'bg-surface-secondary text-muted'
                        }`}
                      >
                        {checked ? <CheckIcon size={13} /> : i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  );
                })}
              </ol>
              {phase === 'running' && !writing && (
                <div className="flex flex-wrap items-center gap-3 border-t border-separator pt-3 text-sm">
                  <Spinner size="sm" />
                  <span className="flex-1 tabular-nums" aria-live="polite">
                    {waiting
                      ? `${method === 'uf2' ? t.waitingUf2 : t.waitingDfu} ${t.timeLeft(minSec(left))}`
                      : progress?.op === 'flash' && progress.step === 'download'
                        ? t.downloadingVersion(label(progress.file ?? ''))
                        : t.starting}
                  </span>
                  <Button size="sm" variant="tertiary" onPress={() => void post('/api/cancel')}>
                    {t.cancel}
                  </Button>
                </div>
              )}
              {writing && (
                <ProgressBar aria-label={t.writingFirmware} value={progress?.done ?? 0} maxValue={100}>
                  <Label>{t.writingFile(progress?.file ?? '')}</Label>
                  <ProgressBar.Output />
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
              )}
              {phase !== 'running' && <p className="m-0 text-sm text-muted">{t.flashHint}</p>}
            </section>
          )}
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
