import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export const LIST_FILE = join('.radio-manager', 'installed.json');

export interface ListedFile {
  sha256: string;
  from: string[]; // every package that delivers this path
  written: string; // the package whose version is on the card
}

export interface InstalledList {
  tool: number;
  updated: string;
  packages: Record<string, { version: string; origin: 'release' | 'main' | 'local'; voices?: string[] }>; // voices: sound packs only
  files: Record<string, ListedFile>;
}

export interface RadioCard {
  volume: string;
  board?: string;
  firmware?: string;
  language?: string;
  sdcardVersion?: string; // edgetx.sdcard.version, written by EdgeTX's SD content
  soundLanguages?: string[]; // folders under SOUNDS/ with EdgeTX's SYSTEM sounds
  installed?: InstalledList;
}

export interface RadioYml {
  board?: string;
  firmware?: string;
  language?: string;
}

export function parseRadioYml(text: string): RadioYml {
  const y: unknown = parse(text);
  if (typeof y !== 'object' || y === null) return {};
  const o = y as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
  return { board: str(o.board), firmware: str(o.semver), language: str(o.ttsLanguage) };
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

async function readText(p: string): Promise<string | undefined> {
  return readFile(p, 'utf8').catch(() => undefined);
}

// An EdgeTX SD card has RADIO/ and MODELS/ at its root; anything else is not a radio.
export async function readCard(volume: string): Promise<RadioCard | undefined> {
  if (!(await isDir(join(volume, 'RADIO'))) || !(await isDir(join(volume, 'MODELS')))) return undefined;
  const card: RadioCard = { volume };
  const yml = await readText(join(volume, 'RADIO', 'radio.yml'));
  if (yml !== undefined) {
    try {
      Object.assign(card, parseRadioYml(yml));
    } catch {
      // unreadable radio.yml: treated like a missing one, the type is asked for
    }
  }
  const sounds = await readdir(join(volume, 'SOUNDS'), { withFileTypes: true }).catch(() => []);
  const langs: string[] = [];
  for (const d of sounds) if (d.isDirectory() && (await isDir(join(volume, 'SOUNDS', d.name, 'SYSTEM')))) langs.push(d.name);
  if (langs.length > 0) card.soundLanguages = langs.sort();
  const sd = (await readText(join(volume, 'edgetx.sdcard.version')))?.trim();
  if (sd) card.sdcardVersion = sd;
  const list = await readText(join(volume, LIST_FILE));
  if (list !== undefined) {
    try {
      card.installed = JSON.parse(list) as InstalledList;
    } catch {
      // broken list: treated as none, nothing gets deleted on update
    }
  }
  return card;
}

// Installed version of a package: from the tool's list; SD content also from edgetx.sdcard.version
// on cards the tool hasn't updated yet.
export function installedVersion(card: RadioCard, name: string, kind: string): string | undefined {
  const listed = card.installed?.packages[name]?.version;
  if (listed || kind !== 'sdcard' || !card.sdcardVersion) return listed;
  return card.sdcardVersion.startsWith('v') ? card.sdcardVersion : `v${card.sdcardVersion}`;
}

export async function findCards(volumes: string[]): Promise<RadioCard[]> {
  const cards = await Promise.all(volumes.map(readCard));
  return cards.filter((c): c is RadioCard => c !== undefined);
}
