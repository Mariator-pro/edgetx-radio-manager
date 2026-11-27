// Reads THIRD_PARTY_LICENSES.txt as the build writes it: an intro, then per package a block between two
// lines of 80 "=" with "name version", "License: …" and maybe "Source: …", followed by its license texts.

export interface LicensePackage {
  id: string; // name and version
  license: string;
  source?: string;
  paragraphs: string[][]; // the text for reading: paragraphs, each with its lines (list items stay apart)
}

export interface LicenseList {
  intro: string[];
  packages: LicensePackage[];
}

const RULE = '='.repeat(80);
// a line that starts a list item, a numbered point or a copyright notice keeps its own line
const ITEM = /^([-*•]|\(?[0-9a-z]{1,3}[.)]\s|copyright\b|©)/i;
const COPYRIGHT = /^(copyright\b|©)/i;
// a line of dashes or the like between parts of a license
export const isRule = (p: string[]) => p.length === 1 && /^[-=_*~]{3,}$/.test(p[0]!);

// License files break their lines by hand at about 80 characters. For reading in a narrow window the lines of a
// paragraph are joined again; the words stay exactly as they are.
export function paragraphs(text: string): string[][] {
  const out: string[][] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines: string[] = [];
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const prev = lines[lines.length - 1];
      // a copyright notice ends at its line unless it clearly goes on (a comma, a lower-case word)
      const afterCopyright = prev !== undefined && COPYRIGHT.test(prev) && !prev.endsWith(',') && /^[A-Z]/.test(line);
      if (prev === undefined || ITEM.test(line) || afterCopyright) lines.push(line);
      else lines[lines.length - 1] = `${prev} ${line}`;
    }
    if (lines.length > 0) out.push(lines);
  }
  return out;
}

export function parseLicenses(file: string): LicenseList {
  const lines = file.replace(/\r\n/g, '\n').split('\n');
  const intro: string[] = [];
  const packages: LicensePackage[] = [];
  let i = 0;
  while (i < lines.length && lines[i] !== RULE) {
    if (lines[i]!.trim()) intro.push(lines[i]!.trim());
    i++;
  }
  while (i < lines.length) {
    const end = lines.indexOf(RULE, i + 1);
    if (end < 0) break;
    const head = lines.slice(i + 1, end);
    const next = lines.indexOf(RULE, end + 1);
    const body = lines.slice(end + 1, next < 0 ? lines.length : next).join('\n');
    const field = (name: string) => head.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
    const source = field('Source');
    packages.push({ id: head[0] ?? '', license: field('License') ?? '', ...(source ? { source } : {}), paragraphs: paragraphs(body) });
    i = next < 0 ? lines.length : next;
  }
  return { intro, packages };
}
