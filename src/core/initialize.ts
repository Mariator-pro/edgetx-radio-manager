import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCardId, writeList, type InstalledList, type ListedFile, type RadioCard } from './card.ts';
import { loadContent, sha256, type Origin } from './content.ts';
import { AppError } from './errors.ts';
import { knownVersions, type KnownFile } from './known.ts';
import type { Paths } from './paths.ts';
import { updateSources } from './selection.ts';
import { radioKey, voiceLanguage, type Settings, type Source } from './settings.ts';

// Reading the SD card: which version of each package it holds, and which of its files are missing or changed.
// A card without the app's list gets one, as if the app had put the packages there; a card with a list has its
// files checked against it, reading only those whose size or change time differs from the last check.

export interface PackageState {
  name: string;
  missing: string[]; // files of the version not on the card
  changed: string[]; // files of the version that differ on the card
}

export interface CardCheck {
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
// only when more than half of its files are on the card.
type Rank = { same: number; off: number };
const better = (a: Rank, b: Rank | undefined) => !b || a.same > b.same || (a.same === b.same && a.off < b.off);

async function best(volume: string, candidates: Candidate[]): Promise<Candidate | undefined> {
  let top: (Rank & { c: Candidate }) | undefined;
  for (const c of candidates) {
    if (c.files.size === 0) continue;
    const { present, same } = await score(volume, c.files);
    if (present * 2 <= c.files.size) continue;
    const rank = { same, off: c.files.size - same };
    if (better(rank, top)) top = { ...rank, c };
  }
  return top?.c;
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
async function detectSounds(p: Paths, source: Source, card: RadioCard): Promise<Candidate | undefined> {
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
  return top?.c;
}

async function detect(p: Paths, source: Source, card: RadioCard, board: string, prefer: Origin): Promise<Candidate | undefined> {
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
      return best(card.volume, await projectCandidates(p, source, prefer));
    case 'firmware':
      return undefined;
  }
}

// Projects first, they are small; the sounds, the largest, last.
const ORDER = { project: 0, sdcard: 1, sounds: 2, firmware: 3 };

export async function checkCard(
  p: Paths,
  s: Settings,
  card: RadioCard,
  board: string,
  onPackage: (name: string, list: InstalledList) => void = () => {},
  signal?: AbortSignal,
): Promise<CardCheck> {
  const list: InstalledList = card.installed
    ? { ...card.installed, packages: { ...card.installed.packages }, files: Object.fromEntries(Object.entries(card.installed.files).map(([k, f]) => [k, { ...f }])) }
    : { tool: 1, updated: new Date().toISOString(), packages: {}, files: {} };
  let changed = !card.installed;
  const sources = updateSources(s).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const choices = s.radios[radioKey(board, card.cardId)]?.sources ?? {};
  for (const src of sources) {
    if (signal?.aborted) throw new AppError('cancelled');
    // a package the list doesn't know: put there another way, or never on this card
    if (!list.packages[src.name]) {
      const found = await detect(p, src, card, board, choices[src.name]?.origin ?? 'release');
      if (found) {
        list.packages[src.name] = { version: found.version, origin: found.origin, ...(found.voices ? { voices: found.voices } : {}) };
        for (const [path, f] of found.files) {
          const have = list.files[path];
          if (have) have.from = [...new Set([...have.from, src.name])];
          else list.files[path] = { sha256: f.sha, from: [src.name], written: src.name, size: f.size };
        }
        changed = true;
      }
    }
    for (const [path, f] of Object.entries(list.files)) {
      if (f.written !== src.name) continue;
      if (await recheck(card.volume, path, f)) changed = true;
    }
    onPackage(src.name, list);
  }
  if (changed) await writeList(card.volume, list);
  const cardId = await ensureCardId(card.volume);
  return { cardId, list, states: packageStates(list), written: changed };
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
export function packageStates(list: InstalledList): PackageState[] {
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
