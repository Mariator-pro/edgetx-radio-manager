import { Accordion, Button, Card, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { LicensesView } from '../../server/api.ts';
import { get } from '../api.ts';
import { errorText } from '../errors.ts';
import { isRule, parseLicenses, type LicenseList } from '../licenseText.ts';
import { usePrefs } from '../usePrefs.ts';

const REPO = 'https://github.com/Mariator-pro/edgetx-radio-manager';
const linkClass = 'text-sm font-medium text-accent no-underline hover:underline';

// Name, version, the app's own license and the licenses of the open source packages inside it.
export function AboutCard() {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.about}</Card.Title>
        <Card.Description>
          EdgeTX Radio Manager · {t.version(__APP_VERSION__)}
          <br />
          {t.license} {t.thirdParty}
        </Card.Description>
      </Card.Header>
      <Card.Footer className="flex flex-wrap items-center gap-4">
        <Button variant="outline" onPress={() => setOpen(true)}>
          {t.showLicenses}
        </Button>
        <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={linkClass}>
          {t.mitLicense}
        </a>
        <a href={REPO} target="_blank" rel="noreferrer" className={linkClass}>
          {t.sourceCode}
        </a>
      </Card.Footer>
      {open && <LicensesDialog onClose={() => setOpen(false)} />}
    </Card>
  );
}

function LicensesDialog({ onClose }: { onClose: () => void }) {
  const { t } = usePrefs();
  const [list, setList] = useState<LicenseList>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    get<LicensesView>('/api/licenses').then(
      (v) => setList(parseLicenses(v.text)),
      (e: unknown) => setError(errorText(t, e)),
    );
  }, [t]);
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{t.licensesTitle}</Modal.Heading>
            {list && <p className="m-0 text-sm leading-relaxed text-muted">{t.licensesIntro(list.packages.length)}</p>}
          </Modal.Header>
          <Modal.Body>
            {list ? (
              <Accordion>
                {list.packages.map((pkg) => (
                  <Accordion.Item key={pkg.id} id={pkg.id}>
                    <Accordion.Heading>
                      <Accordion.Trigger className="gap-3">
                        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{pkg.id}</span>
                        <span className="shrink-0 text-xs text-muted">{pkg.license}</span>
                        <Accordion.Indicator />
                      </Accordion.Trigger>
                    </Accordion.Heading>
                    <Accordion.Panel>
                      <Accordion.Body className="flex flex-col gap-3 text-sm leading-relaxed">
                        {pkg.source && (
                          <a href={pkg.source} target="_blank" rel="noreferrer" className={`${linkClass} break-all`}>
                            {pkg.source}
                          </a>
                        )}
                        {pkg.paragraphs.map((para, i) =>
                          isRule(para) ? (
                            <hr key={i} className="m-0 w-full border-separator" />
                          ) : (
                            <p key={i} className="m-0 break-words">
                              {para.map((line, j) => (
                                <span key={j} className="block">
                                  {line}
                                </span>
                              ))}
                            </p>
                          ),
                        )}
                      </Accordion.Body>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            ) : (
              <p className="m-0 text-sm text-muted">{error ?? t.licensesLoading}</p>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
