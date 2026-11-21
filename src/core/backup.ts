import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isAppleDouble, SYSTEM_DIRS } from './appledouble.ts';
import { ensureCardId, parseRadioYml, readIdentity } from './card.ts';
import { AppError } from './errors.ts';
import { isSafeName, type Paths } from './paths.ts';

// OS housekeeping on the card, never part of a backup.
const skip = (name: string) => SYSTEM_DIRS.has(name) || isAppleDouble(name);

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}(_\d+)?$/;
export const isBackupName = (name: string) => BACKUP_NAME.test(name);

// A backup is written under this name and gets its own only when complete, so one cut short (the app quit, the
// card pulled) never shows up as a backup.
const PARTIAL = /^\..+\.partial$/;
const partialName = (name: string) => `.${name}.partial`;

export interface BackupProgress {
  file: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface BackupResult {
  dir: string;
  name: string;
  files: number;
  bytes: number;
  cardId: string; // the SD card it is from
}

const pad = (n: number) => String(n).padStart(2, '0');

export function backupName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export interface CardFile {
  path: string;
  size: number;
  atime: Date;
  mtime: Date;
}

// Every file below root except OS housekeeping, with full paths.
export async function listFiles(root: string): Promise<CardFile[]> {
  const out: CardFile[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (skip(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await stat(full);
        out.push({ path: full, size: st.size, atime: st.atime, mtime: st.mtime });
      }
    }
  };
  await walk(root);
  return out;
}

async function freeName(base: string, name: string): Promise<string> {
  let candidate = name;
  for (let i = 2; await stat(join(base, candidate)).catch(() => undefined); i++) candidate = `${name}_${i}`;
  return candidate;
}

// Copies the whole card as a folder under Backups/<board>/<date_time>/, keeping file times.
export async function backupCard(
  volume: string,
  board: string,
  p: Paths,
  now = new Date(),
  onProgress: (pr: BackupProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<BackupResult> {
  // the card gets its id first, so every backup tells which SD card it is from, also one made while the app is
  // still reading a newly connected card
  const cardId = await ensureCardId(volume);
  const base = join(p.backups, board);
  await mkdir(base, { recursive: true });
  // left over from a backup cut short
  for (const e of await readdir(base, { withFileTypes: true })) {
    if (e.isDirectory() && PARTIAL.test(e.name)) await rm(join(base, e.name), { recursive: true, force: true });
  }
  const name = await freeName(base, backupName(now));
  const dir = join(base, name);
  const partial = join(base, partialName(name));
  const files = await listFiles(volume);
  const bytesTotal = files.reduce((n, f) => n + f.size, 0);
  let bytesDone = 0;
  await mkdir(partial);
  try {
    for (const [i, f] of files.entries()) {
      if (signal?.aborted) throw new AppError('cancelled');
      const rel = relative(volume, f.path);
      const target = join(partial, rel);
      await mkdir(dirname(target), { recursive: true });
      try {
        await copyFile(f.path, target);
        await utimes(target, f.atime, f.mtime);
      } catch (e) {
        // gone since it was listed (the app's own list is written through a temporary file), while the card is
        // still there: it is no longer on the card, so not in the backup either
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !(await stat(join(volume, 'RADIO')).catch(() => undefined))) throw e;
      }
      bytesDone += f.size;
      onProgress({ file: rel, done: i + 1, total: files.length, bytesDone, bytesTotal });
    }
    await rename(partial, dir);
  } catch (e) {
    // incomplete, so not kept
    await rm(partial, { recursive: true, force: true });
    throw e;
  }
  return { dir, name, files: files.length, bytes: bytesTotal, cardId };
}

// EdgeTX version in a backup folder's radio.yml.
export async function backupFirmware(dir: string): Promise<string | undefined> {
  try {
    return parseRadioYml(await readFile(join(dir, 'RADIO', 'radio.yml'), 'utf8')).firmware;
  } catch {
    return undefined; // no or unreadable radio.yml in the backup
  }
}

export async function listBackups(p: Paths, board: string): Promise<string[]> {
  const entries = await readdir(join(p.backups, board), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// The backups of one SD card, newest first: those with its id and those from before cards had one. Two radios of a
// type share the folder, but neither pushes out the other's backups.
export async function cardBackups(p: Paths, board: string, cardId?: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listBackups(p, board)) {
    const id = (await readIdentity(join(p.backups, board, name))).cardId;
    if (!id || id === cardId) out.push(name);
  }
  return out;
}

// Keeps the newest `keep` backups of an SD card; kept ones don't count and are never deleted.
export async function pruneBackups(p: Paths, board: string, keep: number, kept: string[] = [], cardId?: string): Promise<string[]> {
  const candidates = (await cardBackups(p, board, cardId)).filter((n) => !kept.includes(n));
  const doomed = candidates.slice(Math.max(keep, 0));
  for (const n of doomed) await rm(join(p.backups, board, n), { recursive: true, force: true });
  return doomed;
}

export async function deleteBackup(p: Paths, board: string, name: string): Promise<void> {
  if (!isSafeName(board) || !BACKUP_NAME.test(name)) throw new AppError('invalidRequest', { what: 'backup' });
  await rm(join(p.backups, board, name), { recursive: true, force: true });
}
