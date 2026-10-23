import { copyFile, mkdir, readdir, readFile, rm, rmdir, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { ApplyProgress } from './apply.ts';
import { backupFirmware, isBackupName, listFiles, type CardFile } from './backup.ts';
import { AppError } from './errors.ts';
import { isSafeName, type Paths } from './paths.ts';

export type RestoreAction = 'add' | 'replace' | 'delete';

export interface RestoreItem {
  path: string; // relative to the card, with "/"
  action: RestoreAction;
}

export interface RestorePlan {
  dir: string; // the backup folder
  dirs: Set<string>; // folders in the backup, spelled exactly as there
  items: RestoreItem[];
  unchanged: number;
  firmware?: string; // EdgeTX version in the backup's radio.yml
}

export interface RestoreResult {
  written: number;
  deleted: number;
}

// FAT keeps modification times to 2 s.
const SAME_TIME_MS = 2000;
// Small files with the same size and time are compared byte by byte: with the radio's clock not set,
// an edited model can keep both.
const COMPARE_BYTES = 1 << 20;

export function backupDir(p: Paths, board: string, name: string): string {
  if (!isSafeName(board) || !isBackupName(name)) throw new AppError('invalidRequest', { what: 'backup' });
  return join(p.backups, board, name);
}

const relPath = (root: string, f: CardFile) => relative(root, f.path).split(sep).join('/');

async function same(a: CardFile, b: CardFile): Promise<boolean> {
  if (a.size !== b.size || Math.abs(a.mtime.getTime() - b.mtime.getTime()) > SAME_TIME_MS) return false;
  return a.size > COMPARE_BYTES || (await readFile(a.path)).equals(await readFile(b.path));
}

// What it takes to bring the card back to the backup: missing and changed files back, files the backup doesn't have deleted.
export async function planRestore(volume: string, p: Paths, board: string, name: string): Promise<RestorePlan> {
  const dir = backupDir(p, board, name);
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new AppError('backupNotFound', { name });
  const wanted = new Map((await listFiles(dir)).map((f) => [relPath(dir, f), f]));
  const onCard = new Map((await listFiles(volume)).map((f) => [relPath(volume, f), f]));
  const items: RestoreItem[] = [];
  let unchanged = 0;
  for (const [path, f] of wanted) {
    const c = onCard.get(path);
    if (!c) items.push({ path, action: 'add' });
    else if (await same(f, c)) unchanged++;
    else items.push({ path, action: 'replace' });
  }
  for (const path of onCard.keys()) if (!wanted.has(path)) items.push({ path, action: 'delete' });
  items.sort((a, b) => a.path.localeCompare(b.path));
  const dirs = new Set<string>();
  for (const path of wanted.keys()) for (let d = dirname(path); d !== '.'; d = dirname(d)) dirs.add(d);
  return { dir, dirs, items, unchanged, firmware: await backupFirmware(dir) };
}

// Removes folders left empty by deletions unless the backup has them, never the top-level card folders.
// Compared by name rather than on disk, where a folder that differs only in case would count as there.
async function dropEmptyDirs(root: string, keep: Set<string>, path: string): Promise<void> {
  for (let dir = dirname(path); dir.includes('/'); dir = dirname(dir)) {
    if (keep.has(dir)) return;
    const full = join(root, dir);
    if ((await readdir(full).catch(() => ['?'])).length > 0) return;
    await rmdir(full);
  }
}

// Deletes first, so a file renamed only in case (FAT ignores case) comes back under its old name.
export async function applyRestore(
  volume: string,
  plan: RestorePlan,
  onProgress: (pr: ApplyProgress) => void = () => {},
): Promise<RestoreResult> {
  const todo = [...plan.items.filter((i) => i.action === 'delete'), ...plan.items.filter((i) => i.action !== 'delete')];
  const result: RestoreResult = { written: 0, deleted: 0 };
  try {
    for (const [n, item] of todo.entries()) {
      const target = join(volume, item.path);
      if (item.action === 'delete') {
        await rm(target, { force: true });
        await dropEmptyDirs(volume, plan.dirs, item.path);
        result.deleted++;
      } else {
        const from = join(plan.dir, item.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(from, target);
        const st = await stat(from);
        await utimes(target, st.atime, st.mtime);
        result.written++;
      }
      onProgress({ path: item.path, done: n + 1, total: todo.length });
    }
  } catch (e) {
    if (!(await stat(volume).catch(() => undefined))) throw new AppError('restoreInterrupted');
    throw e;
  }
  return result;
}
