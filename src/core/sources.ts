import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CARD_DIRS } from './content.ts';
import { downloadSource } from './download.ts';
import { AppError } from './errors.ts';
import type { FetchFn } from './github.ts';
import { versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import type { Settings, Source } from './settings.ts';
import { readZip } from './zip.ts';

export interface SourceCheck {
  source: Source;
  tag: string;
  files: number;
  sample: string[]; // a few card paths, for the confirmation
}

// The folder inside a release that holds the card content, without the changing top folder of a
// GitHub source archive ("owner-repo-sha/"); undefined when the card root is the zip root.
export function findSdDir(names: string[]): string | undefined | null {
  const counts = new Map<string, number>();
  for (const n of names) {
    const parts = n.split('/');
    const i = parts.findIndex((seg, k) => k < parts.length - 1 && CARD_DIRS.has(seg));
    if (i < 0) continue;
    const prefix = parts.slice(0, i).join('/');
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [prefix] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const segs = prefix === '' ? [] : prefix.split('/');
  if (tops.size === 1 && segs.length > 0) segs.shift();
  return segs.length > 0 ? segs.join('/') : undefined;
}

// Downloads the newest release of a new repo and finds its SD folder; nothing is added yet.
export async function checkSource(p: Paths, s: Settings, repo: string, fetchFn: FetchFn = fetch): Promise<SourceCheck> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AppError('repoFormat');
  const name = repo.split('/')[1]!;
  if (s.sources.some((x) => x.name === name || x.repo.toLowerCase() === repo.toLowerCase())) throw new AppError('alreadySource', { name: repo });
  const source: Source = { name, repo, kind: 'project' };
  const r = await downloadSource(p, s, source, fetchFn);
  if (r.status === 'no-release' || !r.tag) throw new AppError('noRelease', { repo });
  const dir = versionDir(p, name, r.tag);
  const names: string[] = [];
  for (const zip of (await readdir(dir)).filter((n) => n.endsWith('.zip'))) names.push(...(await readZip(join(dir, zip))).keys());
  const sdDir = findSdDir(names);
  if (sdDir === null) throw new AppError('noSdFolder', { repo, tag: r.tag });
  if (sdDir) source.sdDir = sdDir;
  const card = names.filter((n) => [...CARD_DIRS].some((d) => n.includes(`${d}/`)));
  return { source, tag: r.tag, files: card.length, sample: card.slice(0, 8) };
}

// Adds a checked source; a radio connected right now gets it switched on.
export function addSource(s: Settings, source: Source, connectedBoard?: string): void {
  s.sources.push(source);
  const sel = connectedBoard ? s.radios[connectedBoard]?.sources : undefined;
  if (sel) sel[source.name] = { on: true, origin: 'release' };
}

// Removes a project source from the list and from every radio; downloaded versions stay.
// EdgeTX's own sources can't be removed.
export function removeSource(s: Settings, name: string): boolean {
  const before = s.sources.length;
  s.sources = s.sources.filter((x) => x.name !== name || x.kind !== 'project');
  for (const r of Object.values(s.radios)) {
    if (r.sources) delete r.sources[name];
    if (r.newSources) r.newSources = r.newSources.filter((n) => n !== name);
  }
  return s.sources.length < before;
}
