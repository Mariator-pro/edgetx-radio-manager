import { Alert, CloseButton, Spinner } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { DownloadResultView } from '../server/api.ts';
import { errorText, post, useServer } from './api.ts';
import { Sidebar, type Page } from './components/Sidebar.tsx';
import { BackupsPage } from './pages/BackupsPage.tsx';
import { FlashFlow } from './pages/FlashFlow.tsx';
import { PackagesPage } from './pages/PackagesPage.tsx';
import { RadioPage } from './pages/RadioPage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';
import { UpdateFlow } from './pages/UpdateFlow.tsx';
import type { Texts } from './texts.ts';
import { usePrefs } from './usePrefs.ts';

type Notice = { status: 'success' | 'danger' | 'default'; title: string; text?: string };

function downloadNotice(results: DownloadResultView[], t: Texts): Notice {
  const fresh = results.filter((r) => r.status === 'new').map((r) => `${r.source} ${r.tag}`);
  const failed = results.filter((r) => r.status === 'error').map((r) => `${r.source}: ${errorText(t, r.error ?? { message: r.message ?? '' })}`);
  if (failed.length > 0) return { status: 'danger', title: t.someFailed, text: failed.join('; ') };
  return fresh.length > 0 ? { status: 'success', title: t.downloaded, text: fresh.join(', ') } : { status: 'default', title: t.allCurrent };
}

export function App() {
  const { state, progress, connected } = useServer();
  const { t } = usePrefs();
  const [page, setPage] = useState<Page>('sources');
  const [volume, setVolume] = useState<string>();
  // The radio leaves USB storage mode for flashing, so the flash page keeps its own radio.
  const [flashing, setFlashing] = useState<{ board: string; name: string }>();
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
        ) : showRadio && page === 'update' ? (
          <UpdateFlow key={radio.volume} radio={radio} progress={progress} onBack={() => setPage('radio')} />
        ) : showRadio ? (
          <RadioPage
            radio={radio}
            busy={state.busy}
            keep={state.backupsToKeep}
            run={run}
            onPlan={() => setPage('update')}
            onFlash={() => {
              setFlashing({ board: radio.board!, name: radio.name });
              setPage('flash');
            }}
          />
        ) : page === 'packages' ? (
          <PackagesPage run={run} refreshKey={`${state.lastCheck}|${state.busy}`} />
        ) : page === 'backups' ? (
          <BackupsPage run={run} keep={state.backupsToKeep} refreshKey={state.radios.map((r) => r.lastBackup).join()} />
        ) : (
          <SourcesPage state={state} run={run} board={radio?.board} />
        )}
      </main>
    </div>
  );
}
