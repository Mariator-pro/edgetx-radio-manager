import { describe, expect, it } from 'vitest';
import { isOwnPage, isWebLink } from '../src/desktop/links.ts';

describe('isWebLink', () => {
  it('lets web pages open in the browser', () => {
    for (const url of ['https://github.com/EdgeTX/edgetx', 'http://10.0.0.1/', 'HTTPS://example.com/']) {
      expect(isWebLink(url)).toBe(true);
    }
  });

  it('keeps every other scheme from the system', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'file://attacker.example/share/run.exe',
      'smb://attacker.example/share',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:someone@example.com',
      '',
      'not a url',
    ]) {
      expect(isWebLink(url)).toBe(false);
    }
  });
});

describe('isOwnPage', () => {
  const own = 'http://localhost:51234';

  it('stays on the own page', () => {
    for (const url of ['http://localhost:51234/', 'http://localhost:51234/backups?x=1#top']) expect(isOwnPage(url, own)).toBe(true);
  });

  it('leaves for other sites, even those that start like the own page', () => {
    for (const url of [
      'http://localhost:51234@evil.example/',
      'http://localhost:5123/',
      'http://127.0.0.1:51234/',
      'https://localhost:51234/',
      'https://github.com/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isOwnPage(url, own)).toBe(false);
    }
  });
});
