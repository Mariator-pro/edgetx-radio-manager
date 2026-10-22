import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { soundPackPattern } from './download.ts';
import { localVersions, mainDir, mainInfo, mainVersion, versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import type { RadioCard } from './card.ts';
import { radioTypesIn } from './radios.ts';
import type { Source, SourceKind } from './settings.ts';
import { readZip } from './zip.ts';

const run = promisify(execFile);

export type Origin = 'release' | 'main' | 'local';

export interface PkgFile {
  data: Buffer;
  sha: string;
  time: number; // release or commit date, or the file's change time for a local checkout
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
  if (source.file) {
    const data = await readFile(join(dir, source.file.asset)).catch(() => undefined);
    if (data) files.set(source.file.card, { data, sha: sha256(data), time });
    return { name: source.name, origin: 'release', version: newest.tag, files };
  }
  for (const zip of await zipsFor(dir, source, ctx)) {
    const entries = await readZip(join(dir, zip));
    const prefix = sdPrefix([...entries.keys()], source.sdDir);
    if (prefix !== undefined) addFiles(files, entries, prefix, source.kind, time);
  }
  return { name: source.name, origin: 'release', version: newest.tag, files };
}

// The downloaded newest main commit of a project; undefined when it isn't downloaded.
export async function mainContent(p: Paths, source: Source): Promise<PackageContent | undefined> {
  const info = await mainInfo(p, source.name);
  if (!info) return undefined;
  const dir = mainDir(p, source.name);
  const files = new Map<string, PkgFile>();
  if (source.file) {
    const data = await readFile(join(dir, source.file.asset)).catch(() => undefined);
    if (data) files.set(source.file.card, { data, sha: sha256(data), time: Date.parse(info.date) });
    return { name: source.name, origin: 'main', version: mainVersion(info), files };
  }
  for (const zip of (await readdir(dir)).filter((n) => n.endsWith('.zip'))) {
    const entries = await readZip(join(dir, zip));
    const prefix = sdPrefix([...entries.keys()], source.sdDir);
    if (prefix !== undefined) addFiles(files, entries, prefix, source.kind, Date.parse(info.date));
  }
  return { name: source.name, origin: 'main', version: mainVersion(info), files };
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
  if (origin === 'local') return localContent(source);
  return origin === 'main' ? mainContent(p, source) : releaseContent(p, source, ctx);
}

// Card paths and checksums of downloaded versions, and checksums of card files by size and change time,
// so detecting versions on every state update doesn't read packages and card again.
const versionShas = new Map<string, { version: string; shas: Map<string, string> } | undefined>();
const cardShas = new Map<string, string>();

async function cardSha(volume: string, path: string): Promise<string | undefined> {
  const full = join(volume, path);
  const st = await stat(full).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  const key = `${full}|${st.size}|${st.mtimeMs}`;
  let sha = cardShas.get(key);
  if (!sha) {
    sha = sha256(await readFile(full));
    cardShas.set(key, sha);
  }
  return sha;
}

type Candidate = { origin: Origin; key: string; load: () => Promise<PackageContent | undefined> };

// Every downloaded version of a project: releases newest first, then main, then the local checkout.
async function candidates(p: Paths, source: Source): Promise<Candidate[]> {
  const list: Candidate[] = [];
  for (const v of await localVersions(p, source.name)) {
    list.push({ origin: 'release', key: v.tag, load: () => releaseContent(p, source, {}, v.tag) });
  }
  const main = await mainInfo(p, source.name);
  if (main) list.push({ origin: 'main', key: mainVersion(main), load: () => mainContent(p, source) });
  const local = await localVersion(source);
  if (local) list.push({ origin: 'local', key: local, load: () => localContent(source) });
  return list;
}

async function shasOf(p: Paths, source: Source, c: Candidate): Promise<{ version: string; shas: Map<string, string> } | undefined> {
  const key = `${p.packages}|${source.name}|${c.key}`;
  if (!versionShas.has(key)) {
    const content = await c.load().catch(() => undefined);
    versionShas.set(key, content && { version: content.version, shas: new Map([...content.files].map(([path, f]) => [path, f.sha])) });
  }
  return versionShas.get(key);
}

// How many files of a version are on the card, and how many of them unchanged.
async function onCardCount(volume: string, shas: Map<string, string>): Promise<{ present: number; same: number }> {
  let present = 0;
  let same = 0;
  for (const [path, sha] of shas) {
    const onDisk = await cardSha(volume, path);
    if (onDisk) present++;
    if (onDisk === sha) same++;
  }
  return { present, same };
}

export interface Detected {
  onCard: boolean; // most files of some downloaded version are on the card
  version?: string; // the version whose files are all there unchanged
  origin?: Origin;
  files?: Map<string, string>; // its card paths and checksums
}

// A project the tool didn't put on the card (copied by hand): the downloaded version whose files are all
// there unchanged, the chosen origin tried first.
export async function detectVersion(p: Paths, source: Source, volume: string, prefer: Origin): Promise<Detected> {
  const list = (await candidates(p, source)).sort((a, b) => Number(b.origin === prefer) - Number(a.origin === prefer)); // stable: newest release first
  let onCard = false;
  for (const c of list) {
    const v = await shasOf(p, source, c);
    if (!v || v.shas.size === 0) continue;
    const { present, same } = await onCardCount(volume, v.shas);
    if (same === v.shas.size) return { onCard: true, version: v.version, origin: c.origin, files: v.shas };
    if (present * 2 > v.shas.size) onCard = true;
  }
  return { onCard };
}

// True when the card already holds exactly the chosen version of a project: all its files unchanged, and no
// file the tool wrote for it earlier that an update would delete (e.g. "local abc1234" against "main abc1234").
export async function sameOnCard(p: Paths, source: Source, card: RadioCard, origin: Origin): Promise<boolean> {
  const c = (await candidates(p, source)).find((x) => x.origin === origin);
  const v = c && (await shasOf(p, source, c));
  if (!v || v.shas.size === 0) return false;
  const listed = Object.entries(card.installed?.files ?? {}).filter(([, f]) => f.written === source.name);
  if (listed.some(([path]) => !v.shas.has(path))) return false;
  return (await onCardCount(card.volume, v.shas)).same === v.shas.size;
}
