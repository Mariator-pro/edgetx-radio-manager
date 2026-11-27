import { Chip, Modal, Spinner } from '@heroui/react';
import type { DiffEntry, DiffGroupView } from '../../server/api.ts';
import { usePrefs } from '../usePrefs.ts';

const KIND_COLOR = { added: 'success', removed: 'danger', changed: 'warning' } as const;

export function ModelDiff({ title, subtitle, groups, onClose }: { title: string; subtitle: string; groups?: DiffGroupView[]; onClose: () => void }) {
  const { t } = usePrefs();
  const name = (e: DiffEntry) => e.name ?? `${t.diffTerms[e.term!]}${e.n ? ` ${e.n}` : ''}`;
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.close} />
          <Modal.Header className="flex flex-col items-start gap-1">
            <Modal.Heading>{title}</Modal.Heading>
            <span className="text-sm text-muted">{subtitle}</span>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {!groups ? (
              <Spinner size="sm" />
            ) : groups.length === 0 ? (
              <p className="m-0 text-muted">{t.diffNone}</p>
            ) : (
              <>
                <div className="overflow-hidden rounded-2xl border border-border">
                  {groups.map((g, i) => (
                    <div key={g.area} className={`flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-2.5 ${i > 0 ? 'border-t border-separator' : ''}`}>
                      <span className="flex-[0_0_170px] font-semibold">{t.diffAreas[g.area]}</span>
                      <span className="flex min-w-0 flex-[1_1_240px] flex-wrap gap-1.5">
                        {g.entries.map((e, j) => (
                          <Chip key={j} size="sm" variant="soft" color={KIND_COLOR[e.kind]} aria-label={`${t.diffKinds[e.kind]}: ${name(e)}`}>
                            <span className={e.kind === 'removed' ? 'line-through' : undefined}>{name(e)}</span>
                          </Chip>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  {(['added', 'removed', 'changed'] as const).map((k) => (
                    <Chip key={k} size="sm" variant="soft" color={KIND_COLOR[k]}>
                      {t.diffKinds[k]}
                    </Chip>
                  ))}
                </div>
              </>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
