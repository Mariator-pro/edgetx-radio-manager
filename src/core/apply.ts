import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIST_FILE, type InstalledList, type ListedFile } from './card.ts';
import type { PackageContent } from './content.ts';
import type { PlanItem } from './plan.ts';

// For a conflict: keep the card's file, or go ahead (write the package version, or delete).
export type Resolution = 'keep' | 'apply';

export interface ApplyProgress {
  path: string;
  done: number;
  total: number;
}

export interface ApplyResult {
  written: number;
  deleted: number;
  kept: number;
}

// A replaced or removed .lua makes the radio's compiled .luac stale.
async function dropLuac(root: string, path: string): Promise<void> {
  if (path.endsWith('.lua')) await rm(join(root, `${path}c`), { force: true });
}

// The card root needs no mkdir, and Windows refuses one on a drive root with EPERM.
export async function makeParent(root: string, path: string): Promise<void> {
  if (path.includes('/')) await mkdir(dirname(join(root, path)), { recursive: true });
}

// Removes folders left empty by deletions, never the top-level card folders.
async function dropEmptyDirs(root: string, path: string): Promise<void> {
  for (let dir = dirname(path); dir.includes('/'); dir = dirname(dir)) {
    const full = join(root, dir);
    if ((await readdir(full).catch(() => ['?'])).length > 0) return;
    await rmdir(full);
  }
}

export async function applyPlan(
  root: string,
  plan: PlanItem[],
  contents: PackageContent[],
  resolutions: Map<string, Resolution> = new Map(),
  onProgress: (pr: ApplyProgress) => void = () => {},
): Promise<ApplyResult> {
  const result: ApplyResult = { written: 0, deleted: 0, kept: 0 };
  const todo = plan.filter((i) => i.action !== 'unchanged');
  for (const [n, item] of todo.entries()) {
    const go = item.action !== 'conflict' || resolutions.get(item.path) === 'apply';
    if (!go) result.kept++;
    else if (item.wanted) {
      await makeParent(root, item.path);
      await writeFile(join(root, item.path), item.wanted.data);
      await dropLuac(root, item.path);
      result.written++;
    } else {
      await rm(join(root, item.path), { force: true });
      await dropLuac(root, item.path);
      await dropEmptyDirs(root, item.path);
      result.deleted++;
    }
    onProgress({ path: item.path, done: n + 1, total: todo.length });
  }
  await writeList(root, plan, contents);
  return result;
}

// Records every package file, kept conflicts included, so a changed file stays a conflict next time.
async function writeList(root: string, plan: PlanItem[], contents: PackageContent[]): Promise<void> {
  const files: Record<string, ListedFile> = {};
  for (const item of plan) {
    if (item.wanted) files[item.path] = { sha256: item.wanted.sha, from: item.wanted.from, written: item.wanted.written };
  }
  const list: InstalledList = {
    tool: 1,
    updated: new Date().toISOString(),
    packages: Object.fromEntries(contents.map((c) => [c.name, { version: c.version, origin: c.origin, ...(c.voices ? { voices: c.voices } : {}) }])),
    files,
  };
  const path = join(root, LIST_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(list, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
}
