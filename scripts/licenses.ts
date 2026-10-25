// Writes dist/THIRD_PARTY_LICENSES.txt: license texts and notices of every package the app ships.
// Packages come from the build and from the runtime dependencies, which electron-builder copies into the app:
// - dist/ui-files.json: modules Vite bundles into the page, written by bundledFiles() below
// - dist/desktop-meta.json: esbuild metafile of the Electron main process
// - packages the own CSS files @import (Tailwind inlines them, Vite never sees them)
// - "dependencies" in package.json, with their own dependencies
// The same file is used in every app; each input is optional.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

interface Pkg {
  name: string;
  version: string;
  productName?: string;
  license?: string | { type: string };
  licenses?: { type: string }[];
  author?: string | { name: string };
  repository?: string | { url: string };
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// Vite plugin: lists every module bundled into the page, so the license list names exactly the packages the app ships.
export function bundledFiles() {
  return {
    name: 'bundled-files',
    apply: 'build' as const,
    generateBundle(this: { getModuleIds(): IterableIterator<string> }) {
      const files = [...this.getModuleIds()].map((id) => id.replace(/^\0/, '').split('?')[0]!);
      writeFileSync(join(dist, 'ui-files.json'), JSON.stringify(files));
    },
  };
}

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;

// ".../node_modules/@scope/name/dist/x.js" -> ".../node_modules/@scope/name"
function packageDir(file: string): string | undefined {
  const path = file.replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return `${path.slice(0, at)}/node_modules/${name}`;
}

// Node's lookup: node_modules/<name> next to the package, then in each folder above up to the project root
function resolvePackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dir === dirname(dir)) return undefined;
  }
}

function runtimeDependencies(dir: string, found: Set<string>): void {
  const pkg = readPkg(dir);
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const dep = resolvePackage(name, dir);
    if (dep === undefined || found.has(dep)) continue;
    found.add(dep);
    runtimeDependencies(dep, found);
  }
}

// License a license file starts with, to catch a package.json that says something else
const kinds: [string, RegExp][] = [
  ['Apache-2.0', /Apache License,?\s+Version 2\.0/i],
  ['MIT', /Permission is hereby granted, free of charge/i],
  ['ISC', /Permission to use, copy, modify, and\/or distribute this software for any purpose/i],
  ['BSD', /Redistribution and use in source and binary forms/i],
  ['BlueOak-1.0.0', /Blue Oak Model License/i],
  ['0BSD', /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\.\s+THE SOFTWARE/i],
];

// Standard texts for packages that name MIT or ISC but ship no license file
const standardTexts: Record<string, (holder: string) => string> = {
  MIT: (holder) =>
    [
      'MIT License',
      '',
      `Copyright (c) ${holder}`,
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    ].join('\n'),
  ISC: (holder) =>
    [
      'ISC License',
      '',
      `Copyright (c) ${holder}`,
      '',
      'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
    ].join('\n'),
};

// "git+https://github.com/a/b.git", "git@github.com:a/b", "github:a/b" or "a/b" -> "https://github.com/a/b"
const webLink = (url: string) =>
  url
    .replace(/^git\+/, '')
    .replace(/^(ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$2/')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, '')
    .replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
    .replace(/\.git$/, '');

function kindOf(text: string): string | undefined {
  // earliest match wins; on a tie the later, more specific entry (0BSD starts with the wording of ISC)
  const hits = kinds.map(([kind, re], order) => ({ kind, order, at: text.search(re) })).filter((h) => h.at >= 0);
  return hits.sort((a, b) => a.at - b.at || b.order - a.order)[0]?.kind;
}

function main(): void {
  const app = readPkg(root);
  const readJson = <T>(name: string): T | undefined =>
    existsSync(join(dist, name)) ? (JSON.parse(readFileSync(join(dist, name), 'utf8')) as T) : undefined;
  const uiFiles = readJson<string[]>('ui-files.json') ?? [];
  const desktopFiles = Object.keys(readJson<{ inputs: object }>('desktop-meta.json')?.inputs ?? {});
  const cssImports = uiFiles
    .filter((f) => f.endsWith('.css') && !f.includes('/node_modules/'))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@import\s+["']([^."'][^"']*)["']/g)].map((m) => join(root, 'node_modules', m[1]!, 'x')));
  const files = [...uiFiles, ...cssImports, ...desktopFiles.map((f) => resolve(root, f))];
  const dirs = new Set(files.map(packageDir).filter((d) => d !== undefined).map((d) => resolve(d)));
  runtimeDependencies(root, dirs);

  const entries = [...dirs].map((dir) => {
    const pkg = readPkg(dir);
    const license =
      typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'unknown');
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const names = readdirSync(dir)
      .filter((n) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(n))
      .sort();
    const texts = names.map((n) => readFileSync(join(dir, n), 'utf8').trim());
    const licenseTexts = texts.filter((_, i) => !/^notice/i.test(names[i]!));
    const found = licenseTexts.map(kindOf).filter((k) => k !== undefined);
    const conflicts = [...new Set(found)].filter((k) => !license.toUpperCase().includes(k.toUpperCase()));
    const author = typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '') : pkg.author?.name;
    const standard = licenseTexts.length === 0 ? standardTexts[license] : undefined;
    return {
      id: `${pkg.name} ${pkg.version}`,
      license: conflicts.length > 0 ? `${license} in package.json, but the license file is ${conflicts.join(' and ')}` : license,
      link: repo ? webLink(repo) : pkg.homepage,
      texts:
        texts.length > 0
          ? texts
          : standard
            ? [`The package names ${license} but contains no license file; the standard ${license} text follows.`, standard(author ?? `the authors of ${pkg.name}`)]
            : [`The package contains no license file; it is distributed under ${license}.`],
      missing: licenseTexts.length === 0,
      conflict: conflicts.length > 0,
    };
  });
  // one entry per name and version, even when installed twice
  const unique = [...new Map(entries.map((e) => [e.id, e])).values()].sort((a, b) => a.id.localeCompare(b.id));

  const electron = 'electron' in { ...app.dependencies, ...app.devDependencies };
  const out = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    `${app.productName ?? app.name} contains the following ${unique.length} open source packages.`,
    ...(electron
      ? [
          'Electron and Chromium come with their own license files, LICENSE.electron.txt and LICENSES.chromium.html:',
          'on macOS next to this file, on Windows and Linux in the app folder, one level above this file.',
        ]
      : []),
    ...unique.flatMap((e) => [
      '',
      '='.repeat(80),
      e.id,
      `License: ${e.license}`,
      ...(e.link ? [`Source: ${e.link}`] : []),
      '='.repeat(80),
      '',
      ...e.texts.flatMap((t) => [t, '']),
    ]),
  ];
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `${out.join('\n').trimEnd()}\n`);
  const list = (label: string, items: typeof unique) => (items.length ? `, ${label}: ${items.map((e) => e.id).join(', ')}` : '');
  console.log(
    `THIRD_PARTY_LICENSES.txt: ${unique.length} packages` +
      list('without license file', unique.filter((e) => e.missing)) +
      list('license file differs from package.json', unique.filter((e) => e.conflict)),
  );
}

if (process.argv[1] === import.meta.filename) main();
