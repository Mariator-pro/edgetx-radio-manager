import { Chip, Label, ListBox, Select } from '@heroui/react';
import type { RadioChoiceView } from '../../server/api.ts';
import type { Texts } from '../texts.ts';
import { choiceName } from '../radioChoice.ts';
import { usePrefs } from '../usePrefs.ts';

// Green dot for a connected radio, an empty ring for the others.
export function ConnectedDot({ on }: { on: boolean }) {
  return on ? (
    <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full bg-success" />
  ) : (
    <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full border border-muted" />
  );
}

// What stands under the name: the type and the start of the ID, or for old backups why they have no radio.
function choiceDetail(t: Texts, c: RadioChoiceView): string {
  if (c.unknown) return `${c.type} · ${t.originUnknownHint}`;
  return [c.name ? c.type : undefined, c.idShort].filter(Boolean).join(' · ');
}

// The "Radio" choice of the backups and models pages: one entry per SD card, connected ones first.
export function RadioChoice({ choices, value, onChange }: { choices: RadioChoiceView[]; value: string; onChange: (key: string) => void }) {
  const { t } = usePrefs();
  const current = choices.find((c) => c.key === value);
  return (
    <Select
      variant="secondary"
      aria-label={t.modelsOf}
      className="w-64"
      selectedKey={value || null}
      onSelectionChange={(k) => k !== null && onChange(String(k))}
    >
      <Label>{t.modelsOf}</Label>
      <Select.Trigger>
        <Select.Value>
          {() =>
            current && (
              <span className="flex min-w-0 items-center gap-2">
                {!current.unknown && <ConnectedDot on={!!current.volume} />}
                <span className="truncate">{choiceName(t, current)}</span>
              </span>
            )
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="field-list">
        <ListBox>
          {choices.map((c) => (
            <ListBox.Item key={c.key} id={c.key} textValue={`${choiceName(t, c)} ${choiceDetail(t, c)}`}>
              <span className="flex min-w-0 flex-1 items-start gap-2">
                <span className="mt-1.5">{c.unknown ? <span className="inline-block size-2" /> : <ConnectedDot on={!!c.volume} />}</span>
                <span className="flex min-w-0 flex-col">
                  <span className={c.unknown ? 'text-muted' : 'font-semibold'}>
                    {choiceName(t, c)}
                    {c.test && (
                      <Chip size="sm" variant="soft" className="ml-2 align-middle">
                        {t.testBadge}
                      </Chip>
                    )}
                  </span>
                  <span className="text-xs text-muted">{choiceDetail(t, c)}</span>
                </span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
