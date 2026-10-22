import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { soundPackPattern } from './download.ts';
import { localVersions, versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import { radioTypesIn } from './radios.ts';
import type { Source, SourceKind } from './settings.ts';
import { readZip } from './zip.ts';

const run = promisify(execFile);

export type Origin = 'release' | 'local';

export interface PkgFile {
  data: Buffer;
  sha: string;
  time: number; // release date, or the file's change time for a local checkout
}

// What one package puts on the card, paths relative to the card root with "/".
export interface PackageContent {
  name: string;
  origin: Origin;
  version: string;
  files: Map<string, PkgFile>;
}

// Radio-specific choice of zips: SD content by the release's sdcard.json, sound packs by language and voice.
export interface RadioContext {
  board?: string;
  voices?: string[];
}

// Top-level folders of an EdgeTX SD card, used to find the card root inside a zip.
export const CARD_DIRS = new Set(['SCRIPTS', 'WIDGETS', 'SOUNDS', 'IMAGES', 'THEMES', 'TEMPLATES', 'MODELS', 'RADIO', 'SCREENSHOTS', 'LOGS']);

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// Runtime data, models and radio settings are never written by an update.
export function isExcluded(path: string, kind: SourceKind): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === 'config.lua' || base === '.DS_Store' || base.startsWith('._')) return true;
  if (path === 'SCRIPTS/GPSHOMER/flights.lua') return true;
  if (path.startsWith('MODELS/') || path.startsWith('RADIO/')) return !(kind === 'sdcard' && /^readme/i.test(base));
  return false;
}

// Where the card root sits in a zip: at the top (EdgeTX zips), below sdDir, or below the
// "<repo>-<sha>/" folder of a GitHub source archive.
export function sdPrefix(names: string[], sdDir?: string): string | undefined {
  const sub = sdDir ? `${sdDir.replace(/\/+$/, '')}/` : '';
  const tops = new Set(names.filter((n) => n.includes('/')).map((n) => n.slice(0, n.indexOf('/'))));
  let best: string | undefined;
  let bestCount = 0;
  for (const prefix of [sub, ...[...tops].map((t) => `${t}/${sub}`)]) {
    const count = names.filter((n) => n.startsWith(prefix) && CARD_DIRS.has(n.slice(prefix.length).split('/')[0]!)).length;
    if (count > bestCount) [best, bestCount] = [prefix, count];
  }
  return best;
}

function addFiles(into: Map<string, PkgFile>, entries: Map<string, Buffer>, prefix: string, kind: SourceKind, time: number) {
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) continue;
    const path = name.slice(prefix.length);
    if (path === '' || isExcluded(path, kind)) continue;
    into.set(path, { data, sha: sha256(data), time });
  }
}

async function zipsFor(dir: string, source: Source, ctx: RadioContext): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.zip'));
  switch (source.kind) {
    case 'sdcard': {
      const type = (await radioTypesIn(dir)).find((r) => r.board === ctx.board);
      return type ? names.filter((n) => n === `${type.sdPackage}.zip`) : [];
    }
    case 'sounds':
      return names.filter((n) => (ctx.voices ?? []).some((v) => soundPackPattern(v).test(n)));
    case 'project':
      return names;
    case 'firmware':
      return [];
  }
}

// Newest downloaded release of a source (or the given tag); undefined when it isn't downloaded.
export async function releaseContent(p: Paths, source: Source, ctx: RadioContext, tag?: string): Promise<PackageContent | undefined> {
  const versions = await localVersions(p, source.name);
  const newest = tag ? versions.find((v) => v.tag === tag) : versions[0];
  if (!newest) return undefined;
  const dir = versionDir(p, source.name, newest.tag);
  const files = new Map<string, PkgFile>();
  const time = Date.parse(newest.published);
  for (const zip of await zipsFor(dir, source, ctx)) {
    const entries = await readZip(join(dir, zip));
    const prefix = sdPrefix([...entries.keys()], source.sdDir);
    if (prefix !== undefined) addFiles(files, entries, prefix, source.kind, time);
  }
  return { name: source.name, origin: 'release', version: newest.tag, files };
}

function git(dir: string) {
  return async (...args: string[]) => (await run('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
}

const sdSub = (source: Source) => (source.sdDir ? `${source.sdDir.replace(/\/+$/, '')}/` : '');

// "local <hash>", with "*" when the SD folder has uncommitted changes.
export async function localVersion(source: Source): Promise<string | undefined> {
  if (!source.localDir) return undefined;
  const g = git(source.localDir);
  try {
    const hash = (await g('rev-parse', '--short', 'HEAD')).trim();
    const dirty = (await g('status', '--porcelain', '--', sdSub(source) || '.')).trim() !== '';
    return `local ${hash}${dirty ? '*' : ''}`;
  } catch {
    return undefined;
  }
}

// Committed files of a local checkout as they are in the working tree.
export async function localContent(source: Source): Promise<PackageContent | undefined> {
  const dir = source.localDir;
  if (!dir) return undefined;
  const sub = sdSub(source);
  const tracked = (await git(dir)('ls-files', '-z', '--', sub || '.')).split('\0').filter(Boolean);
  const version = await localVersion(source);
  const files = new Map<string, PkgFile>();
  for (const rel of tracked) {
    const path = rel.slice(sub.length);
    if (isExcluded(path, source.kind)) continue;
    const full = join(dir, rel);
    const st = await stat(full).catch(() => undefined);
    if (!st?.isFile()) continue; // deleted in the working tree
    const data = await readFile(full);
    files.set(path, { data, sha: sha256(data), time: st.mtimeMs });
  }
  return { name: source.name, origin: 'local', version: version ?? 'local', files };
}

export function loadContent(p: Paths, source: Source, origin: Origin, ctx: RadioContext): Promise<PackageContent | undefined> {
  return origin === 'local' ? localContent(source) : releaseContent(p, source, ctx);
}
