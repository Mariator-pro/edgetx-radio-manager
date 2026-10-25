import { Alert, CloseButton, Spinner } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { DownloadResultView, RadioView } from '../server/api.ts';
import { errorText, post, useServer } from './api.ts';
import { Sidebar, type Page } from './components/Sidebar.tsx';
import { BackupsPage } from './pages/BackupsPage.tsx';
import { FlashFlow } from './pages/FlashFlow.tsx';
import { ModelsFlow } from './pages/ModelsFlow.tsx';
import { ModelsPage, type ModelsRequest } from './pages/ModelsPage.tsx';
import { PackagesPage } from './pages/PackagesPage.tsx';
import { RadioPage } from './pages/RadioPage.tsx';
import { RestoreFlow } from './pages/RestoreFlow.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';
import { UpdateFlow } from './pages/UpdateFlow.tsx';
import type { Texts } from './texts.ts';
import { usePrefs } from './usePrefs.ts';

type Notice = { status: 'success' | 'danger' | 'default'; title: string; text?: string };

// One line per kind of error; a missing connection or the rate limit hit every source, so no names there.
function downloadNotice(results: DownloadResultView[], t: Texts): Notice {
  const fresh = results.filter((r) => r.status === 'new').map((r) => `${r.source} ${r.tag}`);
  const groups = new Map<string, Set<string>>();
  for (const r of results.filter((x) => x.status === 'error')) {
    const error = r.error ?? { message: r.message ?? '' };
    const text = errorText(t, error);
    const names = groups.get(text) ?? new Set<string>();
    if (error.code !== 'rateLimit' && error.code !== 'noConnection') names.add(r.source);
    groups.set(text, names);
  }
  if (groups.size > 0) {
    const text = [...groups].map(([msg, names]) => (names.size > 0 ? `${msg} (${[...names].join(', ')})` : msg)).join(' ');
    const anyOk = results.some((r) => r.status !== 'error');
    return { status: 'danger', title: anyOk ? t.someFailed : t.checkFailed, text };
  }
  return fresh.length > 0 ? { status: 'success', title: t.downloaded, text: fresh.join(', ') } : { status: 'default', title: t.allCurrent };
}

export function App() {
  const { state, progress, connected } = useServer();
  const { t } = usePrefs();
  const [page, setPage] = useState<Page>('sources');
  const [volume, setVolume] = useState<string>();
  // The radio leaves USB storage mode for flashing, so the flash page keeps its own radio.
  const [flashing, setFlashing] = useState<{ board: string; name: string }>();
  // The restore page keeps its radio too, so it can show the error when the card is pulled;
  // while the radio is connected it shows the live one.
  const [restoring, setRestoring] = useState<{ radio: RadioView; name: string }>();
  const [modelsRequest, setModelsRequest] = useState<ModelsRequest>();
  const [notice, setNotice] = useState<Notice>();
  const known = useRef<Set<string>>(new Set());

  // A newly connected radio opens its page; a removed one falls back to the overview.
  useEffect(() => {
    if (!state) return;
    const volumes = state.radios.map((r) => r.volume);
    const added = volumes.find((v) => !known.current.has(v));
    known.current = new Set(volumes);
    if (added) {
      setVolume(added);
      setPage('radio');
    } else if (volume && !volumes.includes(volume)) {
      setVolume(volumes[0]);
      if (page === 'radio' || page === 'update') setPage(volumes.length > 0 ? 'radio' : 'sources');
    }
  }, [state, volume, page]);

  const run = (fn: () => Promise<unknown>) => {
    fn().catch((e: unknown) => setNotice({ status: 'danger', title: t.failed, text: errorText(t, e) }));
  };

  const radio = state?.radios.find((r) => r.volume === volume);
  const showRadio = (page === 'radio' || page === 'update') && radio;

  return (
    <div className="flex min-h-screen flex-wrap">
      <Sidebar
        state={state}
        progress={progress}
        page={page}
        volume={volume}
        onNavigate={(p, v) => {
          setPage(p);
          if (v) setVolume(v);
        }}
        onDownload={() => run(async () => setNotice(downloadNotice(await post<DownloadResultView[]>('/api/download'), t)))}
      />
      <main className="box-border flex min-w-0 flex-[999_1_640px] flex-col gap-6 p-7">
        {!connected && (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t.noServer}</Alert.Title>
              <Alert.Description>{t.startServer}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {notice && (
          <Alert status={notice.status}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{notice.title}</Alert.Title>
              {notice.text && <Alert.Description>{notice.text}</Alert.Description>}
            </Alert.Content>
            <CloseButton aria-label={t.close} onPress={() => setNotice(undefined)} />
          </Alert>
        )}
        {!state ? (
          <Spinner />
        ) : page === 'flash' && flashing ? (
          <FlashFlow
            board={flashing.board}
            name={flashing.name}
            progress={progress}
            onBack={() => setPage(radio ? 'radio' : 'sources')}
          />
        ) : page === 'restore' && restoring ? (
          <RestoreFlow
            key={`${restoring.radio.volume}|${restoring.name}`}
            radio={state.radios.find((r) => r.volume === restoring.radio.volume) ?? restoring.radio}
            name={restoring.name}
            progress={progress}
            onBack={() => setPage('backups')}
          />
        ) : page === 'modelsFlow' && modelsRequest ? (
          <ModelsFlow
            key={JSON.stringify(modelsRequest)}
            request={modelsRequest}
            radio={state.radios.find((r) => r.volume === modelsRequest.radio.volume) ?? modelsRequest.radio}
            progress={progress}
            onBack={() => setPage('models')}
          />
        ) : page === 'models' ? (
          <ModelsPage
            state={state}
            run={run}
            onStart={(r) => {
              setModelsRequest(r);
              setPage('modelsFlow');
            }}
          />
        ) : showRadio && page === 'update' ? (
          <UpdateFlow key={radio.volume} radio={radio} progress={progress} onBack={() => setPage('radio')} />
        ) : showRadio ? (
          <RadioPage
            radio={radio}
            busy={state.busy}
            keep={state.backupsToKeep}
            run={run}
            onPlan={() => setPage('update')}
            onSources={() => setPage('sources')}
            onFlash={() => {
              setFlashing({ board: radio.board!, name: radio.name });
              setPage('flash');
            }}
          />
        ) : page === 'packages' ? (
          <PackagesPage run={run} refreshKey={`${state.lastCheck}|${state.busy}`} />
        ) : page === 'backups' ? (
          <BackupsPage
            run={run}
            keep={state.backupsToKeep}
            refreshKey={state.radios.map((r) => r.lastBackup).join()}
            radios={state.radios}
            busy={state.busy}
            onRestore={(r, name) => {
              setRestoring({ radio: r, name });
              setPage('restore');
            }}
          />
        ) : (
          <SourcesPage state={state} run={run} board={radio?.board} />
        )}
      </main>
    </div>
  );
}
