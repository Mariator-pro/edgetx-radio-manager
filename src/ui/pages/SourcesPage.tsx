import { Button, Card, Chip, Input, Label, TextField } from '@heroui/react';
import { useState } from 'react';
import type { SourceCheckView, StateView } from '../../server/api.ts';
import { errorText, post } from '../api.ts';
import { date } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

function AddSource({ state, run, board }: { state: StateView; run: Run; board?: string }) {
  const { t } = usePrefs();
  const [repo, setRepo] = useState('');
  const [check, setCheck] = useState<SourceCheckView>();
  const [error, setError] = useState<unknown>();
  const checking = state.busy === 'source';

  const doCheck = async () => {
    setError(undefined);
    setCheck(undefined);
    try {
      setCheck(await post<SourceCheckView>('/api/sources/check', { repo }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.addSource}</Card.Title>
        <Card.Description>{t.addSourceText}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void doCheck();
          }}
        >
          <TextField className="min-w-64 flex-1" value={repo} onChange={setRepo} isRequired>
            <Label>{t.githubRepo}</Label>
            <Input placeholder={t.repoPlaceholder} />
          </TextField>
          <Button type="submit" isDisabled={!repo.includes('/') || !!state.busy}>
            {checking ? t.checkingRepo : t.check}
          </Button>
        </form>
        {error !== undefined && (
          <p role="alert" className="m-0 text-sm text-danger">
            {errorText(t, error)}
          </p>
        )}
        {check && (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-secondary p-4">
            <p className="m-0">
              {t.checkResult(check.name, check.tag, check.files)}{' '}
              <code className="font-mono">{check.sdDir ? `${check.sdDir}/` : t.zipRoot}</code>
            </p>
            <ul className="m-0 list-none p-0 font-mono text-xs text-muted">
              {check.sample.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                onPress={() =>
                  run(async () => {
                    await post('/api/sources/add', { ...check, board });
                    setCheck(undefined);
                    setRepo('');
                  })
                }
              >
                {t.add}
              </Button>
              <Button variant="outline" onPress={() => setCheck(undefined)}>
                {t.cancel}
              </Button>
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

export function SourcesPage({ state, run, board }: { state: StateView; run: Run; board?: string }) {
  const { t } = usePrefs();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-3xl font-bold tracking-tight">{t.sources}</h1>
      <Card>
        <Card.Content className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="px-5 py-2.5 font-medium">{t.colSource}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{t.colKind}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{t.colNewest}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{t.colMain}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{t.colLocal}</th>
                <th scope="col" className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {state.sources.map((s) => (
                <tr key={s.name} className="border-t border-separator">
                  <td className="px-5 py-3">
                    <div className="font-medium">{s.name}</div>
                    <a className="text-xs" href={`https://github.com/${s.repo}`} target="_blank" rel="noreferrer">
                      {s.repo}
                    </a>
                  </td>
                  <td className="px-2 py-3">
                    <Chip size="sm" variant="soft">
                      {t.kinds[s.kind]}
                    </Chip>
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">{s.newest ? `${s.newest.tag} · ${date(s.newest.published, t.locale)}` : t.none}</td>
                  <td className="px-2 py-3 font-mono text-xs">{s.main ?? '–'}</td>
                  <td className="px-2 py-3 font-mono text-xs" title={s.localDir}>
                    {s.local ?? '–'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {s.kind === 'project' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={!!state.busy}
                        onPress={() => {
                          if (confirm(t.removeConfirm(s.name))) {
                            run(() => post('/api/sources/remove', { name: s.name }));
                          }
                        }}
                      >
                        {t.remove}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card.Content>
      </Card>
      <AddSource state={state} run={run} board={board} />
    </div>
  );
}
