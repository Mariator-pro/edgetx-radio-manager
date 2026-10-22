import { copyFile, mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { AppError } from './errors.ts';
import { isSafeName, type Paths } from './paths.ts';

// OS housekeeping on the card, never part of a backup.
const SKIP_NAMES = new Set(['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems', 'System Volume Information']);
const skip = (name: string) => SKIP_NAMES.has(name) || name.startsWith('._');

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}(_\d+)?$/;

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
}

const pad = (n: number) => String(n).padStart(2, '0');

export function backupName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

interface CardFile {
  path: string;
  size: number;
  atime: Date;
  mtime: Date;
}

async function listFiles(root: string): Promise<CardFile[]> {
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
): Promise<BackupResult> {
  const base = join(p.backups, board);
  await mkdir(base, { recursive: true });
  const name = await freeName(base, backupName(now));
  const dir = join(base, name);
  const files = await listFiles(volume);
  const bytesTotal = files.reduce((n, f) => n + f.size, 0);
  let bytesDone = 0;
  await mkdir(dir);
  for (const [i, f] of files.entries()) {
    const rel = relative(volume, f.path);
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(f.path, target);
    await utimes(target, f.atime, f.mtime);
    bytesDone += f.size;
    onProgress({ file: rel, done: i + 1, total: files.length, bytesDone, bytesTotal });
  }
  return { dir, name, files: files.length, bytes: bytesTotal };
}

export async function listBackups(p: Paths, board: string): Promise<string[]> {
  const entries = await readdir(join(p.backups, board), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// Keeps the newest `keep` backups of a radio; kept ones don't count and are never deleted.
export async function pruneBackups(p: Paths, board: string, keep: number, kept: string[] = []): Promise<string[]> {
  const candidates = (await listBackups(p, board)).filter((n) => !kept.includes(n));
  const doomed = candidates.slice(Math.max(keep, 0));
  for (const n of doomed) await rm(join(p.backups, board, n), { recursive: true, force: true });
  return doomed;
}

export async function deleteBackup(p: Paths, board: string, name: string): Promise<void> {
  if (!isSafeName(board) || !BACKUP_NAME.test(name)) throw new AppError('invalidRequest', { what: 'backup' });
  await rm(join(p.backups, board, name), { recursive: true, force: true });
}
