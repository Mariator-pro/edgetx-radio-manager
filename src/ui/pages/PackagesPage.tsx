import { Button, Card, Chip, Spinner } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { PackageView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { bytes, date } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

export function PackagesPage({ run, refreshKey }: { run: Run; refreshKey: unknown }) {
  const { t } = usePrefs();
  const [packages, setPackages] = useState<PackageView[]>();
  const load = useCallback(() => get<PackageView[]>('/api/packages').then(setPackages, () => {}), []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!packages) return <Spinner />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t.packages}</h1>
        <p className="m-0 text-muted">{t.packagesText}</p>
      </div>
      {packages.map((p) => (
        <Card key={p.name}>
          <Card.Header>
            <Card.Title>{p.name}</Card.Title>
          </Card.Header>
          <Card.Content className="p-0">
            {p.versions.length === 0 ? (
              <p className="m-0 px-5 pb-4 text-sm text-muted">{t.nothingDownloaded}</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {p.versions.map((v) => (
                  <li key={v.tag} className="flex flex-wrap items-center gap-3 border-t border-separator px-5 py-3">
                    <span className="w-24 font-mono text-sm">{v.tag}</span>
                    <span className="w-28 text-sm text-muted">{date(v.published, t.locale)}</span>
                    <span className="w-20 text-sm text-muted">{bytes(v.bytes)}</span>
                    <span className="flex flex-1 flex-wrap gap-1.5">
                      {v.installedOn.map((b) => (
                        <Chip key={b} size="sm" variant="soft" color="accent">
                          {t.onRadio(b)}
                        </Chip>
                      ))}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={v.installedOn.length > 0}
                      onPress={() => {
                        if (confirm(t.deletePackage(p.name, v.tag))) run(async () => {
                          await post('/api/packages/delete', { name: p.name, tag: v.tag });
                          await load();
                        });
                      }}
                    >
                      {t.delete}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}
