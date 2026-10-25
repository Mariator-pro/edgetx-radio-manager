import { Modal, Spinner } from '@heroui/react';
import type { DiffGroupView } from '../../server/api.ts';
import { usePrefs } from '../usePrefs.ts';

// The entries name the keys of the model file and stay English in every language; only the headings are translated.
function change(e: DiffGroupView['entries'][number]): string {
  if (e.from === undefined) return `added: ${e.to ?? ''}`;
  if (e.to === undefined) return `removed (was ${e.from})`;
  return `${e.from} → ${e.to}`;
}

export function ModelDiff({ title, subtitle, groups, onClose }: { title: string; subtitle: string; groups?: DiffGroupView[]; onClose: () => void }) {
  const { t } = usePrefs();
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
              groups.map((g) => (
                <details key={g.area} open className="shrink-0 overflow-hidden rounded-2xl border border-border">
                  <summary className="flex cursor-pointer items-center gap-2 bg-surface-secondary px-4 py-2.5 font-semibold">
                    <span className="flex-1">{t.diffAreas[g.area]}</span>
                    <span className="text-sm font-normal text-muted">{g.entries.length}</span>
                  </summary>
                  <ul className="m-0 list-none p-0" lang="en">
                    {g.entries.map((e, i) => (
                      <li key={i} className="flex flex-wrap gap-x-3 border-t border-separator px-4 py-2">
                        <code className="min-w-0 flex-[1_1_240px] font-mono text-[12.5px] break-all">{e.path}</code>
                        <span className="min-w-0 flex-[1_1_200px] font-mono text-[12.5px] break-all text-muted">{change(e)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
