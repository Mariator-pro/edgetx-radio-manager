import { AlertDialog, Button } from '@heroui/react';
import { usePrefs } from '../usePrefs.ts';

export type Ask = { title: string; text: string; confirm: string; then: () => void };

// A question before something that can't be undone; the buttons answer it.
export function Confirm({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const { t } = usePrefs();
  return (
    <AlertDialog.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>{ask.title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="m-0">{ask.text}</p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t.cancel}
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                onClose();
                ask.then();
              }}
            >
              {ask.confirm}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
