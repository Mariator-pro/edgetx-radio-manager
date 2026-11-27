import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCardId, writeList, type InstalledList, type ListedFile, type RadioCard } from './card.ts';
import { loadContent, sha256, type Origin } from './content.ts';
import { learnUntil } from './download.ts';
import { AppError } from './errors.ts';
import type { FetchFn } from './github.ts';
import { knownVersions, type KnownFile } from './known.ts';
import type { Paths } from './paths.ts';
import { updateSources } from './selection.ts';
import { isBuiltIn, radioKey, voiceLanguage, type Settings, type Source } from './settings.ts';

// Reading the SD card: which version of each package it holds, and which of its files are missing or changed.
// A card without the app's list gets one, as if the app had put the packages there; a card with a list has its
// files checked against it, reading only those whose size or change time differs from the last check.

export interface PackageState {
  name: string;
  missing: string[]; // files of the version not on the card
  changed: string[]; // files of the version that differ on the card
}

interface CardCheck {
  cardId: string;
  list: InstalledList;
  states: PackageState[];
  written: boolean; // the list on the card was written
}

interface Candidate {
  version: string;
  origin: Origin;
  files: Map<string, KnownFile>;
  voices?: string[];
}

type Match = Candidate & { off: number }; // off: files missing or changed on the card

// Checksums of card files by size and change time, so a file is read once per run of the app.
const cardShas = new Map<string, string>();

async function cardFile(volume: string, path: string): Promise<{ size: number; mtime: number } | undefined> {
  const st = await stat(join(volume, path)).catch(() => undefined);
  return st?.isFile() ? { size: st.size, mtime: st.mtimeMs } : undefined;
}

async function cardSha(volume: string, path: string, st: { size: number; mtime: number }): Promise<string> {
  const key = `${join(volume, path)}|${st.size}|${st.mtime}`;
  let sha = cardShas.get(key);
  if (!sha) cardShas.set(key, (sha = sha256(await readFile(join(volume, path)))));
  return sha;
}

// A card file is the package's file: same size first, read only then.
async function isSame(volume: string, path: string, f: KnownFile, st: { size: number; mtime: number }): Promise<boolean> {
  return st.size === f.size && (await cardSha(volume, path, st)) === f.sha;
}

// How many files of a candidate are on the card, and how many unchanged.
async function score(volume: string, files: Map<string, KnownFile>): Promise<{ present: number; same: number }> {
  let present = 0;
  let same = 0;
  for (const [path, f] of files) {
    const st = await cardFile(volume, path);
    if (!st) continue;
    present++;
    if (await isSame(volume, path, f, st)) same++;
  }
  return { present, same };
}

// Most unchanged files wins, then fewest files missing or changed (an older version the card holds exactly beats a
// newer one with one more file), then the earlier candidate (the chosen origin, then the newest). A candidate counts
// only when more than half of its own files are on the card: files another package also has (a project bundling
// another's core) don't count there, unless the candidate has no others.
type Rank = { same: number; off: number };
const better = (a: Rank, b: Rank | undefined) => !b || a.same > b.same || (a.same === b.same && a.off < b.off);

async function best(volume: string, candidates: Candidate[], shared: Set<string> = new Set()): Promise<Match | undefined> {
  let top: (Rank & { c: Candidate }) | undefined;
  for (const c of candidates) {
    if (c.files.size === 0) continue;
    const own = new Map([...c.files].filter(([path]) => !shared.has(path)));
    const counted = own.size > 0 ? own : c.files;
    if ((await score(volume, counted)).present * 2 <= counted.size) continue;
    const { same } = await score(volume, c.files);
    const rank = { same, off: c.files.size - same };
    if (better(rank, top)) top = { ...rank, c };
  }
  return top && { ...top.c, off: top.off };
}

async function projectCandidates(p: Paths, source: Source, prefer: Origin): Promise<Candidate[]> {
  const list: Candidate[] = (await knownVersions(p, source)).map((v) => ({ version: v.tag, origin: 'release', files: v.variants.get('') ?? new Map() }));
  for (const origin of ['main', 'local'] as const) {
    const c = await loadContent(p, source, origin, {}).catch(() => undefined);
    if (c) list.push({ version: c.version, origin, files: new Map([...c.files].map(([path, f]) => [path, { sha: f.sha, size: f.data.length }])) });
  }
  return list.sort((a, b) => Number(b.origin === prefer) - Number(a.origin === prefer)); // stable: newest release first
}

// Sound packs: for each version the best voice of every language on the card; the version with most unchanged files.
async function detectSounds(p: Paths, source: Source, card: RadioCard): Promise<Match | undefined> {
  const langs = card.soundLanguages ?? [];
  let top: (Rank & { c: Candidate }) | undefined;
  for (const v of await knownVersions(p, source)) {
    const files = new Map<string, KnownFile>();
    const voices: string[] = [];
    const rank: Rank = { same: 0, off: 0 };
    for (const lang of langs) {
      let pick: (Rank & { voice: string; files: Map<string, KnownFile> }) | undefined;
      for (const [voice, vf] of v.variants) {
        if (voiceLanguage(voice) !== lang || vf.size === 0) continue;
        const sc = await score(card.volume, vf);
        const r = { same: sc.same, off: vf.size - sc.same };
        if (sc.present * 2 > vf.size && better(r, pick)) pick = { ...r, voice, files: vf };
      }
      if (!pick) continue;
      voices.push(pick.voice);
      rank.same += pick.same;
      rank.off += pick.off;
      for (const [path, f] of pick.files) files.set(path, f);
    }
    if (voices.length > 0 && better(rank, top)) top = { ...rank, c: { version: v.tag, origin: 'release', files, voices: voices.sort() } };
  }
  return top && { ...top.c, off: top.off };
}

// Paths that more than one project has, in any of its versions.
async function sharedPaths(p: Paths, projects: Source[]): Promise<Set<string>> {
  const seen = new Map<string, number>();
  for (const src of projects) {
    const paths = new Set((await projectCandidates(p, src, 'release')).flatMap((c) => [...c.files.keys()]));
    for (const path of paths) seen.set(path, (seen.get(path) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([path]) => path));
}

async function detect(
  p: Paths,
  source: Source,
  card: RadioCard,
  board: string,
  prefer: Origin,
  shared: () => Promise<Set<string>>,
): Promise<Match | undefined> {
  switch (source.kind) {
    case 'sounds':
      return detectSounds(p, source, card);
    case 'sdcard': {
      const candidates = (await knownVersions(p, source)).flatMap((v) => {
        const variant = v.boards?.[board];
        const files = variant ? v.variants.get(variant) : undefined;
        return files ? [{ version: v.tag, origin: 'release' as const, files }] : [];
      });
      return best(card.volume, candidates);
    }
    case 'project':
      return best(card.volume, await projectCandidates(p, source, prefer), await shared());
    case 'firmware':
      return undefined;
  }
}

// Projects first, they are small; the sounds, the largest, last.
const ORDER = { project: 0, sdcard: 1, sounds: 2, firmware: 3 };

interface CheckOptions {
  onPackage?: (name: string, list: InstalledList, states: PackageState[]) => void;
  // everything is read except these packages, whose older versions are searched on GitHub now
  onSearch?: (names: string[], list: InstalledList, cardId: string) => Promise<void>;
  signal?: AbortSignal;
  fetchFn?: FetchFn; // without it no search
}

export async function checkCard(
  p: Paths,
  s: Settings,
  card: RadioCard,
  board: string,
  { onPackage = () => {}, onSearch, signal, fetchFn }: CheckOptions = {},
): Promise<CardCheck> {
  const list: InstalledList = card.installed
    ? { ...card.installed, packages: { ...card.installed.packages }, files: Object.fromEntries(Object.entries(card.installed.files).map(([k, f]) => [k, { ...f }])) }
    : { tool: 1, updated: new Date().toISOString(), packages: {}, files: {} };
  let changed = !card.installed;
  const sources = updateSources(s).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const choices = s.radios[radioKey(board, card.cardId)]?.sources ?? {};
  // what the last check found unchanged isn't read again
  for (const [path, f] of Object.entries(list.files)) {
    if (f.seen?.same) cardShas.set(`${join(card.volume, path)}|${f.seen.size}|${f.seen.mtime}`, f.sha256);
  }
  const searches: { src: Source; fresh: boolean }[] = []; // fresh: not in the list before
  let shared: Promise<Set<string>> | undefined;
  const sharedOnce = () => (shared ??= sharedPaths(p, sources.filter((x) => x.kind === 'project')));
  for (const src of sources) {
    if (signal?.aborted) throw new AppError('cancelled');
    if (src.kind === 'project' && list.packages[src.name] && (await ownFilesGone(card.volume, list, src.name))) {
      dropPackage(list, src.name);
      changed = true;
    }
    const detected = () => detect(p, src, card, board, choices[src.name]?.origin ?? 'release', sharedOnce);
    const recheckOwn = async () => {
      for (const [path, f] of Object.entries(list.files)) if (f.written === src.name && (await recheck(card.volume, path, f))) changed = true;
    };
    const listed = list.packages[src.name];
    await recheckOwn();
    let found: Match | undefined;
    // a package the list doesn't know (put there another way, or never on this card), or one changed since: it may be
    // another version, put there another way
    if (!listed || !isClean(list, src.name)) {
      found = await detected();
      if (found && (!listed || fitsBetter(found, listed))) {
        assign(list, src.name, found, !!listed);
        changed = true;
        await recheckOwn();
      }
    }
    if (fetchFn && src.kind === 'project' && !isBuiltIn(src) && found?.off !== 0) {
      const search = listed ? !isClean(list, src.name) : !!found || (await hasOwnFile(p, src, card.volume, await sharedOnce()));
      if (search) {
        searches.push({ src, fresh: !listed });
        continue;
      }
    }
    onPackage(src.name, list, packageStates(list));
  }
  const cardId = searches.length > 0 ? await ensureCardId(card.volume) : undefined;
  if (cardId) await onSearch?.(searches.map((x) => x.src.name), list, cardId);
  for (const { src, fresh } of searches) {
    const prefer = choices[src.name]?.origin ?? 'release';
    let found: Match | undefined;
    await learnUntil(
      p,
      s,
      src,
      async () => {
        found = await detect(p, src, card, board, prefer, sharedOnce);
        return found?.off === 0;
      },
      fetchFn!,
      signal,
    );
    if (signal?.aborted) throw new AppError('cancelled');
    const listed = list.packages[src.name];
    if (found && (fresh ? found.version !== listed?.version || found.origin !== listed.origin : listed && fitsBetter(found, listed))) {
      assign(list, src.name, found, !fresh);
      for (const [path, f] of Object.entries(list.files)) if (f.written === src.name) await recheck(card.volume, path, f);
      changed = true;
    }
    onPackage(src.name, list, packageStates(list));
  }
  if (signal?.aborted) throw new AppError('cancelled');
  if (changed) await writeList(card.volume, list);
  return { cardId: cardId ?? (await ensureCardId(card.volume)), list, states: packageStates(list), written: changed };
}

const isClean = (list: InstalledList, name: string) => Object.values(list.files).every((f) => f.written !== name || f.seen?.same);

// The card holds a version completely, unlike what the list says. Other voices are no other version.
const fitsBetter = (found: Match, listed: InstalledList['packages'][string]) =>
  found.off === 0 && (found.voices ?? []).join() === [...(listed.voices ?? [])].sort().join();

// Puts a package into the list, in place of the version it has there. keep: files only that version had stay listed
// while unchanged on the card, so the next update deletes them.
function assign(list: InstalledList, name: string, found: Candidate, keep: boolean): void {
  const wrote = new Set(Object.entries(list.files).filter(([, f]) => f.written === name).map(([path]) => path));
  const left = keep ? Object.entries(list.files).filter(([path, f]) => wrote.has(path) && f.seen?.same && !found.files.has(path)) : [];
  dropPackage(list, name);
  for (const [path, f] of left) list.files[path] ??= { ...f, from: [name], written: name };
  list.packages[name] = { version: found.version, origin: found.origin, ...(found.voices ? { voices: found.voices } : {}) };
  for (const [path, f] of found.files) {
    const others = list.files[path]?.from ?? [];
    if (others.length > 0 && !wrote.has(path)) list.files[path]!.from = [...others, name];
    else list.files[path] = { sha256: f.sha, from: [...others, name], written: name, size: f.size };
  }
}

// A file only this project has, in any known version, is on the card.
async function hasOwnFile(p: Paths, source: Source, volume: string, shared: Set<string>): Promise<boolean> {
  const paths = new Set((await projectCandidates(p, source, 'release')).flatMap((c) => [...c.files.keys()]));
  for (const path of paths) if (!shared.has(path) && (await cardFile(volume, path))) return true;
  return false;
}

// A listed project sharing files with another package, none of its own files (listed for no other package) on
// the card: taken for installed because the other one bundles its core.
async function ownFilesGone(volume: string, list: InstalledList, name: string): Promise<boolean> {
  const files = Object.entries(list.files).filter(([, f]) => f.from.includes(name));
  const own = files.filter(([, f]) => f.from.length === 1);
  if (own.length === 0 || own.length === files.length) return false;
  for (const [path] of own) if (await cardFile(volume, path)) return false;
  return true;
}

function dropPackage(list: InstalledList, name: string): void {
  delete list.packages[name];
  for (const [path, f] of Object.entries(list.files)) {
    if (!f.from.includes(name)) continue;
    f.from = f.from.filter((x) => x !== name);
    if (f.from.length === 0) delete list.files[path];
    else if (f.written === name) f.written = f.from[0]!;
  }
}

// Brings one listed file's last check up to date; true when it changed.
async function recheck(volume: string, path: string, f: ListedFile): Promise<boolean> {
  const st = await cardFile(volume, path);
  if (!st) {
    if (!f.seen) return false;
    delete f.seen;
    return true;
  }
  if (f.seen && f.seen.size === st.size && f.seen.mtime === st.mtime) return false;
  const same = (f.size === undefined || f.size === st.size) && (await cardSha(volume, path, st)) === f.sha256;
  f.seen = { size: st.size, mtime: st.mtime, same };
  return true;
}

// Per package the files missing or changed on the card, as the last check found them.
function packageStates(list: InstalledList): PackageState[] {
  const states = new Map<string, PackageState>();
  for (const name of Object.keys(list.packages)) states.set(name, { name, missing: [], changed: [] });
  for (const [path, f] of Object.entries(list.files)) {
    const st = states.get(f.written);
    if (!st) continue;
    if (!f.seen) st.missing.push(path);
    else if (!f.seen.same) st.changed.push(path);
  }
  return [...states.values()];
}
