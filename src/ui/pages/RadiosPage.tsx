import { AlertDialog, Button, Card, Checkbox, Chip, Link, Spinner } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { KnownRadioView } from '../../server/api.ts';
import { get, post } from '../api.ts';
import { EditRadio } from '../components/EditRadio.tsx';
import { ConnectedDot } from '../components/RadioChoice.tsx';
import { ago, dateTime, useNow } from '../dates.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

const radioTitle = (r: KnownRadioView) => r.name ?? r.type;

// Asks before forgetting a radio; its backups go only when ticked.
function ForgetRadio({ radio, run, onDone, onClose }: { radio: KnownRadioView; run: Run; onDone: () => void; onClose: () => void }) {
  const { t } = usePrefs();
  const [withBackups, setWithBackups] = useState(false);
  return (
    <AlertDialog.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>{t.forgetTitle(radioTitle(radio))}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="flex flex-col gap-3">
            <p className="m-0">{t.forgetText}</p>
            {radio.backups > 0 && (
              <Checkbox variant="secondary" isSelected={withBackups} onChange={setWithBackups}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span>{t.forgetBackups(radio.backups, radio.kept)}</span>
                </Checkbox.Content>
              </Checkbox>
            )}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t.cancel}
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                onClose();
                run(async () => {
                  await post('/api/radios/forget', { key: radio.key, backups: withBackups });
                  onDone();
                });
              }}
            >
              {t.forget}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-sm">{children}</dd>
    </>
  );
}

// Every radio the app knows, one card each, connected ones first.
export function RadiosPage({ run, refreshKey, busy, onBackups }: { run: Run; refreshKey: unknown; busy?: string; onBackups: (key: string) => void }) {
  const { t } = usePrefs();
  const now = useNow();
  const [radios, setRadios] = useState<KnownRadioView[]>();
  const [editing, setEditing] = useState<KnownRadioView>();
  const [forgetting, setForgetting] = useState<KnownRadioView>();
  const load = useCallback(() => get<KnownRadioView[]>('/api/radios').then(setRadios, () => {}), []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!radios) return <Spinner />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-1.5">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t.radios}</h1>
        <p className="m-0 text-muted">{t.radiosText}</p>
      </div>
      {radios.length === 0 && <p className="m-0 text-muted">{t.noRadiosYet}</p>}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
        {radios.map((r) => (
          <Card key={r.key}>
            <Card.Header>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {r.volume && <ConnectedDot on />}
                <Card.Title>{radioTitle(r)}</Card.Title>
                {r.name && <span className="text-sm text-muted">{r.type}</span>}
                {r.test && (
                  <Chip size="sm" variant="soft">
                    {t.testBadge}
                  </Chip>
                )}
                {r.volume && (
                  <Chip size="sm" variant="soft" color="success">
                    {t.connectedNow}
                  </Chip>
                )}
              </div>
            </Card.Header>
            <Card.Content>
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                {r.pilot && <Row label={t.pilot}>{r.pilot}</Row>}
                <Row label={t.radioId}>{r.idShort ? <span className="font-mono">{r.idShort}</span> : t.noIdYet}</Row>
                {r.firmware && <Row label={t.radioFirmware}>{r.firmware}</Row>}
                {!r.volume && <Row label={t.lastConnected}>{r.seen ? <span title={dateTime(r.seen, t.locale)}>{ago(r.seen, t.locale, now)}</span> : t.unknownTime}</Row>}
                <Row label={t.radioBackups}>
                  {r.backups}
                  {r.backups > 0 && (
                    <Link className="ml-2 cursor-pointer text-sm" aria-label={t.showBackupsOf(radioTitle(r))} onPress={() => onBackups(r.key)}>
                      {t.show}
                    </Link>
                  )}
                </Row>
                {r.packages.length > 0 && (
                  <>
                    <dt className="col-span-2 mt-1.5 border-t border-separator pt-3 text-sm text-muted">{t.radioPackages}</dt>
                    <dd className="col-span-2 m-0 min-w-0 text-sm">
                      <ul className="m-0 flex max-w-sm list-none flex-col gap-1 p-0">
                        {r.packages.map((pk) => (
                          <li key={pk.name} className="flex justify-between gap-4">
                            <span className="min-w-0 wrap-anywhere">{pk.name}</span>
                            <span className="whitespace-nowrap text-muted tabular-nums">{pk.version}</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-2">
              {r.volume && (
                <Button size="sm" variant="outline" isDisabled={!!busy} onPress={() => setEditing(r)}>
                  {t.editRadio}
                </Button>
              )}
              {r.volume ? (
                <Button size="sm" variant="danger-soft" isDisabled>
                  {t.forget}
                </Button>
              ) : (
                <Button size="sm" variant="danger-soft" isDisabled={!!busy} onPress={() => setForgetting(r)}>
                  {t.forget}
                </Button>
              )}
            </Card.Footer>
          </Card>
        ))}
      </div>
      {editing?.volume && (
        <EditRadio
          volume={editing.volume}
          name={editing.name}
          pilot={editing.pilot}
          run={run}
          onClose={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
      {forgetting && <ForgetRadio radio={forgetting} run={run} onDone={() => void load()} onClose={() => setForgetting(undefined)} />}
    </div>
  );
}
