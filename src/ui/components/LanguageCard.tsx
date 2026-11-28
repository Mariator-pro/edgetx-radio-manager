import { Card, ListBox, Select } from '@heroui/react';
import { LANGUAGES, type Lang } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';

// Language of the interface, as a card in the settings.
export function LanguageCard() {
  const { t, lang, setLang } = usePrefs();
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.language}</Card.Title>
        <Card.Description>{t.languageText}</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Select
          variant="secondary"
          aria-label={t.language}
          className="w-80 max-w-full"
          selectedKey={lang}
          onSelectionChange={(k) => k !== null && setLang(String(k) as Lang)}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="field-list">
            <ListBox>
              {LANGUAGES.map((l) => (
                <ListBox.Item key={l.id} id={l.id} textValue={l.name}>
                  {l.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </Card.Footer>
    </Card>
  );
}
