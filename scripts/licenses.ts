// Writes dist/THIRD_PARTY_LICENSES.txt: license texts and notices of every package bundled into the app.
// Inputs come from the build: dist/ui-files.json (Vite) and dist/desktop-meta.json (esbuild metafile).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

interface Pkg {
  name: string;
  version: string;
  license?: string | { type: string };
  licenses?: { type: string }[];
  repository?: string | { url: string };
  homepage?: string;
}

// ".../node_modules/@scope/name/dist/x.js" -> ".../node_modules/@scope/name"
function packageDir(file: string): string | undefined {
  const path = file.replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return `${path.slice(0, at)}/node_modules/${name}`;
}

const uiFiles = JSON.parse(readFileSync(join(dist, 'ui-files.json'), 'utf8')) as string[];
const desktopFiles = Object.keys((JSON.parse(readFileSync(join(dist, 'desktop-meta.json'), 'utf8')) as { inputs: object }).inputs);
// Tailwind inlines CSS imports itself, so packages like "tailwindcss" never show up as modules.
const cssImports = uiFiles
  .filter((f) => f.endsWith('.css') && !f.includes('/node_modules/'))
  .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@import\s+["']([^."'][^"']*)["']/g)].map((m) => join(root, 'node_modules', m[1]!, 'x')));
const files = [...uiFiles, ...cssImports, ...desktopFiles.map((f) => resolve(root, f))];
const dirs = new Set(files.map(packageDir).filter((d) => d !== undefined));

const entries = [...dirs].map((dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;
  const license =
    typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'unknown');
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const texts = readdirSync(dir)
    .filter((n) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(n))
    .sort()
    .map((n) => readFileSync(join(dir, n), 'utf8').trim());
  return { id: `${pkg.name} ${pkg.version}`, license, link: repo ?? pkg.homepage, texts };
});
// one entry per name and version, even when installed twice
const unique = [...new Map(entries.map((e) => [e.id, e])).values()].sort((a, b) => a.id.localeCompare(b.id));

const missing = unique.filter((e) => e.texts.length === 0);
const out = [
  'THIRD-PARTY SOFTWARE NOTICES',
  '',
  `EdgeTX Radio Manager contains the following ${unique.length} open source packages.`,
  'Electron and Chromium come with their own notices: LICENSE.electron.txt and LICENSES.chromium.html next to this file.',
  ...unique.flatMap((e) => [
    '',
    '='.repeat(80),
    e.id,
    `License: ${e.license}`,
    ...(e.link ? [`Source: ${e.link}`] : []),
    '='.repeat(80),
    '',
    ...(e.texts.length > 0 ? e.texts.flatMap((t) => [t, '']) : [`The package contains no license file; it is distributed under ${e.license}.`, '']),
  ]),
];
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `${out.join('\n').trimEnd()}\n`);
console.log(`THIRD_PARTY_LICENSES.txt: ${unique.length} packages${missing.length ? `, without license file: ${missing.map((e) => e.id).join(', ')}` : ''}`);
