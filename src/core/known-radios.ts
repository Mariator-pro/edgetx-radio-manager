import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteBackup, listBackups } from './backup.ts';
import { ID_FILE, isTestId, readIdentity, shortId, type CardIdentity } from './card.ts';
import { AppError } from './errors.ts';
import { isSafeKey, type Paths } from './paths.ts';
import { radioName, radioTypes, type RadioType } from './radios.ts';
import { forgetBackups, radioKey, type Settings } from './settings.ts';

// A radio the app knows: an SD card with an entry in the settings, with backups, or connected now.
export interface KnownRadio {
  key: string; // "<board>/<card id>", or "<board>" for a card read before cards had ids
  board: string;
  type: string; // maker and model, e.g. "RadioMaster TX15"
  cardId?: string;
  name?: string;
  pilot?: string;
  seen?: string; // ISO time last connected
  firmware?: string;
  installed: Record<string, string>; // package -> version when last connected
  backups: string[]; // backup folders with this card's id, newest first
  kept: string[]; // of those, the ones marked to keep
  volume?: string; // the drive it is connected at now
  inSettings: boolean; // false: only its backups are left, it was forgotten or never connected to this app
  test: boolean;
}

// A connected card as the radio list needs it.
export type ConnectedCard = CardIdentity & { board?: string; volume: string };

const isCardId = (id: string) => /^[\w-]{8,64}$/.test(id);

// Id, name and pilot of the card a backup is from, read again only when its radio.json changes.
const identities = new Map<string, CardIdentity>();
export async function backupIdentity(p: Paths, board: string, name: string): Promise<CardIdentity> {
  const dir = join(p.backups, board, name);
  const key = `${dir}|${(await stat(join(dir, ID_FILE)).catch(() => undefined))?.mtimeMs ?? 'none'}`;
  if (!identities.has(key)) identities.set(key, await readIdentity(dir));
  return identities.get(key)!;
}

// The radio types that have a backup folder.
export async function backupBoards(p: Paths): Promise<string[]> {
  const dirs = await readdir(p.backups, { withFileTypes: true }).catch(() => []);
  return dirs.filter((e) => e.isDirectory() && isSafeKey(e.name)).map((e) => e.name).sort();
}

// The backups of a type from before cards had an id, newest first.
export async function backupsWithoutId(p: Paths, board: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listBackups(p, board)) if (!(await backupIdentity(p, board, name)).cardId) out.push(name);
  return out;
}

// How the app names a radio in lists and messages: its name, else its type with the start of its id.
export function radioLabel(r: Pick<KnownRadio, 'name' | 'type' | 'cardId'>): string {
  return r.name ?? (r.cardId ? `${r.type} (${shortId(r.cardId)})` : r.type);
}

// The name of the radio behind a settings key, without reading its backups.
export function labelOfKey(s: Settings, types: readonly RadioType[], key: string): string {
  const [board, cardId] = key.split('/');
  return radioLabel({ name: s.radios[key]?.name, type: radioName(types, board), cardId });
}

const newest = (r: KnownRadio) => r.backups[0] ?? '';

// Every radio the app knows, the connected ones first, then by when they were last connected, then by their newest
// backup. Name and pilot come from the connected card, else from the settings, else from the newest backup.
export async function knownRadios(p: Paths, s: Settings, connected: ConnectedCard[] = []): Promise<KnownRadio[]> {
  const types = await radioTypes(p, s);
  const all = new Map<string, KnownRadio>();
  const entry = (board: string, cardId?: string): KnownRadio => {
    const key = radioKey(board, cardId);
    let r = all.get(key);
    if (!r) {
      r = { key, board, type: radioName(types, board), installed: {}, backups: [], kept: [], inSettings: false, test: isTestId(cardId) };
      if (cardId) r.cardId = cardId;
      all.set(key, r);
    }
    return r;
  };
  for (const [key, saved] of Object.entries(s.radios)) {
    const [board, cardId] = key.split('/');
    if (!board || !isSafeKey(board) || (cardId !== undefined && !isCardId(cardId))) continue;
    const r = entry(board, cardId);
    r.inSettings = true;
    if (saved.name) r.name = saved.name;
    if (saved.pilot) r.pilot = saved.pilot;
    if (saved.seen) r.seen = saved.seen;
    if (saved.firmware) r.firmware = saved.firmware;
    r.installed = { ...saved.installed };
  }
  const fromBackup = new Map<string, CardIdentity>(); // the identity in each card's newest backup
  for (const board of await backupBoards(p)) {
    const kept = s.keptBackups[board] ?? [];
    for (const name of await listBackups(p, board)) {
      const id = await backupIdentity(p, board, name);
      if (!id.cardId) continue;
      const r = entry(board, id.cardId);
      r.backups.push(name);
      if (kept.includes(name)) r.kept.push(name);
      if (!fromBackup.has(r.key)) fromBackup.set(r.key, id);
    }
  }
  for (const c of connected) {
    if (!c.board) continue;
    const r = entry(c.board, c.cardId);
    r.volume = c.volume;
    if (c.cardName) r.name = c.cardName;
    else delete r.name;
    if (c.cardPilot) r.pilot = c.cardPilot;
    else delete r.pilot;
  }
  for (const r of all.values()) {
    const b = fromBackup.get(r.key);
    if (!b || r.volume) continue;
    if (!r.name && !s.radios[r.key]?.name && b.cardName) r.name = b.cardName;
    if (!r.pilot && !s.radios[r.key]?.pilot && b.cardPilot) r.pilot = b.cardPilot;
  }
  const order = connected.map((c) => (c.board ? radioKey(c.board, c.cardId) : ''));
  const rank = (r: KnownRadio) => (r.volume ? order.indexOf(r.key) : Number.MAX_SAFE_INTEGER);
  return [...all.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.seen ?? '').localeCompare(a.seen ?? '') ||
      newest(b).localeCompare(newest(a)) ||
      a.key.localeCompare(b.key),
  );
}

// Takes a radio that isn't connected out of the app; with backups true its backups go too (those with its id, never
// the ones from before cards had ids). Returns the backups deleted.
export async function forgetRadio(p: Paths, s: Settings, key: string, backups: boolean): Promise<string[]> {
  const [board, cardId, more] = key.split('/');
  if (!board || !isSafeKey(board) || more !== undefined || (cardId !== undefined && !isCardId(cardId))) {
    throw new AppError('invalidRequest', { what: 'radio' });
  }
  const doomed: string[] = [];
  if (backups && cardId) {
    for (const name of await listBackups(p, board)) if ((await backupIdentity(p, board, name)).cardId === cardId) doomed.push(name);
  }
  if (!Object.hasOwn(s.radios, key) && doomed.length === 0) throw new AppError('radioUnknown', { radio: key });
  for (const name of doomed) await deleteBackup(p, board, name);
  if (doomed.length > 0) {
    s.keptBackups[board] = (s.keptBackups[board] ?? []).filter((n) => !doomed.includes(n));
    forgetBackups(s, board, doomed);
  }
  delete s.radios[key];
  return doomed;
}

// The radio behind an id or the start of one, as typed in the terminal; one match only.
export function findRadioKey(radios: readonly KnownRadio[], idStart: string): KnownRadio {
  const hits = radios.filter((r) => r.cardId?.startsWith(idStart) || r.key === idStart);
  if (hits.length !== 1) throw new AppError(hits.length === 0 ? 'radioUnknown' : 'radioAmbiguous', { radio: idStart });
  return hits[0]!;
}

