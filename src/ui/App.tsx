import { Alert, Button, CloseButton, Spinner } from '@heroui/react';
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

// The guided flows, the server operation each one runs and the page it starts from.
type Flow = 'update' | 'restore' | 'modelsFlow' | 'flash';
const FLOWS: Record<Flow, { op: string; home: Page }> = {
  update: { op: 'update', home: 'radio' },
  restore: { op: 'restore', home: 'backups' },
  modelsFlow: { op: 'models', home: 'models' },
  flash: { op: 'flash', home: 'radio' },
};
const isFlow = (p: Page): p is Flow => p in FLOWS;

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
  // A flow left while its operation runs stays open in the background, so its progress and
  // result can be shown again; starts counts the flows started, so a new one starts afresh.
  const [kept, setKept] = useState<Flow>();
  const [starts, setStarts] = useState(0);
  // The update page keeps its radio, so it stays open when another radio is shown.
  const [updating, setUpdating] = useState<RadioView>();
  // The radio leaves USB storage mode for flashing, so the flash page keeps its own radio.
  const [flashing, setFlashing] = useState<{ board: string; name: string }>();
  // The restore page keeps its radio too, so it can show the error when the card is pulled;
  // while the radio is connected it shows the live one.
  const [restoring, setRestoring] = useState<{ radio: RadioView; name: string }>();
  const [modelsRequest, setModelsRequest] = useState<ModelsRequest>();
  const [notice, setNotice] = useState<Notice>();
  const known = useRef<Set<string>>(new Set());

  const go = (next: Page) => {
    if (next === page) return;
    if (isFlow(page) && state?.busy === FLOWS[page].op) setKept(page);
    else if (next === kept) setKept(undefined);
    setPage(next);
  };
  const start = (flow: Flow) => {
    setKept(undefined);
    setStarts((n) => n + 1);
    setPage(flow);
  };

  // A newly connected radio opens its page; a removed one falls back to the overview.
  useEffect(() => {
    if (!state) return;
    const volumes = state.radios.map((r) => r.volume);
    const added = volumes.find((v) => !known.current.has(v));
    known.current = new Set(volumes);
    if (added) {
      setVolume(added);
      go('radio');
    } else if (volume && !volumes.includes(volume)) {
      setVolume(volumes[0]);
      // a running update stays and shows its error
      if (page === 'radio' || (page === 'update' && state.busy !== 'update')) go(volumes.length > 0 ? 'radio' : 'sources');
    }
    // go is new on every render; kept, the one value it reads besides these, changes only with page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, volume, page]);

  const run = (fn: () => Promise<unknown>) => {
    fn().catch((e: unknown) => setNotice({ status: 'danger', title: t.failed, text: errorText(t, e) }));
  };

  const radio = state?.radios.find((r) => r.volume === volume);
  const shownFlow = isFlow(page) ? page : kept;

  const flow = (f: Flow) => {
    if (!state) return undefined;
    if (f === 'flash' && flashing)
      return <FlashFlow board={flashing.board} name={flashing.name} progress={progress} onBack={() => go(radio ? 'radio' : 'sources')} />;
    if (f === 'restore' && restoring)
      return (
        <RestoreFlow
          radio={state.radios.find((r) => r.volume === restoring.radio.volume) ?? restoring.radio}
          name={restoring.name}
          progress={progress}
          onBack={() => go('backups')}
        />
      );
    if (f === 'modelsFlow' && modelsRequest)
      return (
        <ModelsFlow
          request={modelsRequest}
          radio={state.radios.find((r) => r.volume === modelsRequest.radio.volume) ?? modelsRequest.radio}
          progress={progress}
          onBack={() => go('models')}
        />
      );
    if (f === 'update' && updating) {
      const live = state.radios.find((r) => r.volume === updating.volume);
      // the card was pulled: back to the radio list, unless the update still runs
      if (!live && state.busy !== 'update') return undefined;
      return (
        <UpdateFlow
          radio={live ?? updating}
          progress={progress}
          onBack={() => {
            setVolume(updating.volume);
            go('radio');
          }}
        />
      );
    }
    return undefined;
  };
  const flowView = shownFlow && flow(shownFlow);

  return (
    <div className="flex min-h-screen flex-wrap">
      <Sidebar
        state={state}
        progress={progress}
        page={page}
        volume={volume}
        onNavigate={(p, v) => {
          // the page a flow in the background started from leads back to it
          const back = kept && FLOWS[kept].home === p && (kept !== 'update' || v === updating?.volume);
          go(back ? kept : p);
          if (v) setVolume(v);
        }}
        onDownload={() => run(async () => setNotice(downloadNotice(await post<DownloadResultView[]>('/api/download'), t)))}
        onAppUpdate={() => run(() => post('/api/app-update'))}
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
        {kept && page !== kept && flowView && (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{state?.busy === FLOWS[kept].op ? t.flowRunning[kept] : t.flowEnded[kept]}</Alert.Title>
            </Alert.Content>
            <Button size="sm" variant="outline" onPress={() => go(kept)}>
              {t.showFlow}
            </Button>
          </Alert>
        )}
        {flowView && (
          <div key={`${shownFlow}|${starts}`} className={page === shownFlow ? 'contents' : 'hidden'}>
            {flowView}
          </div>
        )}
        {!state ? (
          <Spinner />
        ) : isFlow(page) && flowView ? null : page === 'models' ? (
          <ModelsPage
            state={state}
            run={run}
            onStart={(r) => {
              setModelsRequest(r);
              start('modelsFlow');
            }}
          />
        ) : (page === 'radio' || page === 'update') && radio ? (
          <RadioPage
            radio={radio}
            busy={state.busy}
            keep={state.backupsToKeep}
            run={run}
            onPlan={() => {
              setUpdating(radio);
              start('update');
            }}
            onSources={() => go('sources')}
            onFlash={() => {
              setFlashing({ board: radio.board!, name: radio.name });
              start('flash');
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
              start('restore');
            }}
          />
        ) : (
          <SourcesPage state={state} run={run} board={radio?.board} />
        )}
      </main>
    </div>
  );
}
