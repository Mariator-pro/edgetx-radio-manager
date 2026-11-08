import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { dropAppleDouble } from './appledouble.ts';
import { isCardPath, isSafeKey, printable } from './paths.ts';

export const LIST_FILE = join('.radio-manager', 'installed.json');
export const ID_FILE = join('.radio-manager', 'radio.json');
export const ID_PATH = '.radio-manager/radio.json'; // as card paths are written in lists and plans
export const MAX_CARD_NAME = 40;

// Which SD card this is: its id, and the name given to it in the app.
export interface CardIdentity {
  cardId?: string;
  cardName?: string;
}

export interface ListedFile {
  sha256: string;
  from: string[]; // every package that delivers this path
  written: string; // the package whose version is on the card
  size?: number; // of the package's file
  // the card's file when last checked: by size and change time the app sees it unchanged without reading it again;
  // same: it was the package's file then. None: missing on the card, or not checked yet.
  seen?: { size: number; mtime: number; same: boolean };
}

export interface InstalledList {
  tool: number;
  updated: string;
  packages: Record<string, { version: string; origin: 'release' | 'main' | 'local'; voices?: string[] }>; // voices: sound packs only
  files: Record<string, ListedFile>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The list in the shape the tool writes it; anything else counts as no list.
function isList(v: unknown): v is InstalledList {
  return (
    isObject(v) &&
    isObject(v.packages) &&
    isObject(v.files) &&
    Object.values(v.packages).every((p) => isObject(p) && typeof p.version === 'string') &&
    Object.keys(v.files).every(isCardPath) &&
    Object.values(v.files).every((f) => isObject(f) && typeof f.sha256 === 'string' && Array.isArray(f.from) && typeof f.written === 'string')
  );
}

export interface RadioCard extends CardIdentity {
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
  const str = (v: unknown) => (v === undefined || v === null || printable(String(v)) === '' ? undefined : printable(String(v)));
  // board and language become folder names (backups, SOUNDS/<language>) and keys in the settings:
  // a card's file must not lead elsewhere
  const name = (v: unknown) => {
    const s = str(v);
    return s !== undefined && isSafeKey(s) ? s : undefined;
  };
  return { board: name(o.board), firmware: str(o.semver), language: name(o.ttsLanguage) };
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
  Object.assign(card, await readIdentity(volume));
  const sd = (await readText(join(volume, 'edgetx.sdcard.version')))?.trim();
  if (sd) card.sdcardVersion = sd;
  const list = await readText(join(volume, LIST_FILE));
  if (list !== undefined) {
    try {
      const parsed: unknown = JSON.parse(list);
      if (isList(parsed)) card.installed = parsed;
    } catch {
      // broken list: treated as none, nothing gets deleted on update
    }
  }
  return card;
}

// Writes the list in one go: a card pulled out midway keeps the old one.
export async function writeList(root: string, list: InstalledList): Promise<void> {
  const path = join(root, LIST_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(list, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
  await dropAppleDouble(path);
  await dropAppleDouble(dirname(path));
}

const cleanName = (name: string) => printable(name).trim().slice(0, MAX_CARD_NAME);

// Id and name of a card or of a backup folder; none when it has no radio.json yet or an unreadable one.
export async function readIdentity(root: string): Promise<CardIdentity> {
  try {
    const o = JSON.parse(await readFile(join(root, ID_FILE), 'utf8')) as { id?: unknown; name?: unknown };
    const name = typeof o.name === 'string' ? cleanName(o.name) : '';
    return { ...(typeof o.id === 'string' && /^[\w-]{8,64}$/.test(o.id) ? { cardId: o.id } : {}), ...(name ? { cardName: name } : {}) };
  } catch {
    return {};
  }
}

async function writeIdentity(root: string, id: string, name?: string): Promise<void> {
  const path = join(root, ID_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ id, ...(name ? { name } : {}) }, null, 1)}\n`);
  await dropAppleDouble(path);
  await dropAppleDouble(dirname(path));
}

// The card's own id, written once; it tells two radios of the same type apart.
export async function ensureCardId(root: string): Promise<string> {
  const have = await readIdentity(root);
  if (have.cardId) return have.cardId;
  const id = randomUUID();
  await writeIdentity(root, id, have.cardName);
  return id;
}

// Gives the card a name, or takes it away with an empty one.
export async function setCardName(root: string, name: string): Promise<void> {
  await writeIdentity(root, await ensureCardId(root), cleanName(name) || undefined);
}

// Whether a write failed because the card went away (cable pulled, radio off). Right after a pull the drive's
// folder can still be there for a moment, so the system's device errors count too, and a file on the card that
// is suddenly missing.
export async function cardGone(volume: string, e: unknown): Promise<boolean> {
  const err = e as { code?: string; path?: string; dest?: string } | undefined;
  if (err?.code && ['ENXIO', 'EIO', 'ENODEV'].includes(err.code)) return true;
  const onCard = (p?: string) => !!p && p.startsWith(volume);
  if (err?.code === 'ENOENT' && (onCard(err.path) || onCard(err.dest))) return true;
  return !(await stat(volume).catch(() => undefined));
}

// How the app calls a radio: its name, else its type. Two radios of one type tell apart once they have names.
export function cardLabel(type: string, card: CardIdentity): string {
  return card.cardName ?? type;
}

export async function findCards(volumes: string[]): Promise<RadioCard[]> {
  const cards = await Promise.all(volumes.map(readCard));
  return cards.filter((c): c is RadioCard => c !== undefined);
}
