import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstalledList } from './card.ts';
import { sha256, type PackageContent } from './content.ts';

// The version of one path that goes on the card, after overlaps are resolved.
export interface Wanted {
  sha: string;
  data: Buffer;
  from: string[];
  written: string;
}

export type Action = 'add' | 'replace' | 'unchanged' | 'delete' | 'conflict';

// modified: a package file changed on the card; unknown: a file no package delivered
// sits where a package file goes; removed-modified: a file to delete was changed on the card.
export type ConflictReason = 'modified' | 'unknown' | 'removed-modified';

export interface PlanItem {
  path: string;
  action: Action;
  pkg: string; // package writing the file, or the one that delivered a file to delete
  reason?: ConflictReason;
  wanted?: Wanted; // absent for deletions
}

// Local beats release; between two of the same kind the newer one (release date or
// file change time); on a tie the source listed first.
export function mergePackages(contents: PackageContent[]): Map<string, Wanted> {
  const best = new Map<string, { w: Wanted; local: boolean; time: number }>();
  for (const c of contents) {
    const local = c.origin === 'local';
    for (const [path, f] of c.files) {
      const cur = best.get(path);
      if (!cur) {
        best.set(path, { w: { sha: f.sha, data: f.data, from: [c.name], written: c.name }, local, time: f.time });
        continue;
      }
      cur.w.from.push(c.name);
      if ((local && !cur.local) || (local === cur.local && f.time > cur.time)) {
        Object.assign(cur.w, { sha: f.sha, data: f.data, written: c.name });
        cur.local = local;
        cur.time = f.time;
      }
    }
  }
  return new Map([...best].map(([path, b]) => [path, b.w]));
}

async function cardSha(root: string, path: string): Promise<string | undefined> {
  const data = await readFile(join(root, path)).catch(() => undefined);
  return data && sha256(data);
}

export async function makePlan(root: string, wanted: Map<string, Wanted>, list?: InstalledList): Promise<PlanItem[]> {
  const listed = list?.files ?? {};
  const plan: PlanItem[] = [];
  for (const [path, w] of wanted) {
    const onCard = await cardSha(root, path);
    const known = listed[path];
    let action: Action = 'conflict';
    let reason: ConflictReason | undefined;
    if (onCard === undefined) action = 'add';
    else if (onCard === w.sha) action = 'unchanged';
    else if (known && onCard === known.sha256) action = 'replace';
    else reason = known ? 'modified' : 'unknown';
    plan.push({ path, action, pkg: w.written, reason, wanted: w });
  }
  for (const [path, known] of Object.entries(listed)) {
    if (wanted.has(path)) continue;
    const onCard = await cardSha(root, path);
    if (onCard === undefined) continue;
    if (onCard === known.sha256) plan.push({ path, action: 'delete', pkg: known.written });
    else plan.push({ path, action: 'conflict', pkg: known.written, reason: 'removed-modified' });
  }
  return plan.sort((a, b) => a.path.localeCompare(b.path));
}

export function countActions(plan: PlanItem[]): Record<Action, number> {
  const n: Record<Action, number> = { add: 0, replace: 0, unchanged: 0, delete: 0, conflict: 0 };
  for (const item of plan) n[item.action]++;
  return n;
}
