import { Button, Card } from '@heroui/react';
import { post } from '../api.ts';
import { AboutCard } from '../components/About.tsx';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

export function SettingsPage({ run }: { run: Run }) {
  const { t } = usePrefs();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-3xl font-bold tracking-tight">{t.settings}</h1>
      <Card>
        <Card.Header>
          <Card.Title>{t.dataFolder}</Card.Title>
          <Card.Description>{t.dataFolderText}</Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" onPress={() => run(() => post('/api/open-folder'))}>
            {t.openFolder}
          </Button>
        </Card.Footer>
      </Card>
      <AboutCard />
    </div>
  );
}
