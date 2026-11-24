import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useState } from 'react';
import { post } from '../api.ts';
import { usePrefs } from '../usePrefs.ts';

const MAX = 40; // the server's limit, MAX_CARD_NAME in card.ts

// Name and pilot of a connected radio, both kept on its SD card.
export function EditRadio({
  volume,
  name,
  pilot,
  run,
  onClose,
}: {
  volume: string;
  name?: string;
  pilot?: string;
  run: (fn: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const { t } = usePrefs();
  const [n, setN] = useState(name ?? '');
  const [pl, setPl] = useState(pilot ?? '');
  const save = () =>
    run(async () => {
      await post('/api/radio/name', { volume, name: n, pilot: pl });
      onClose();
    });
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Modal.Header>
              <Modal.Heading>{t.editRadioTitle}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <TextField value={n} onChange={setN}>
                <Label>{t.radioNameLabel}</Label>
                <Input variant="secondary" placeholder={t.namePlaceholder} maxLength={MAX} autoFocus />
              </TextField>
              <TextField value={pl} onChange={setPl}>
                <Label>{t.pilot}</Label>
                <Input variant="secondary" placeholder={t.pilotPlaceholder} maxLength={MAX} />
              </TextField>
              <p className="m-0 text-sm text-muted">{t.identityHint}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={onClose}>
                {t.cancel}
              </Button>
              <Button type="submit">{t.save}</Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
