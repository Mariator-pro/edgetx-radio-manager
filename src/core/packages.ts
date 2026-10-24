import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.ts';
import { isSafeName, type Paths } from './paths.ts';
import type { Settings } from './settings.ts';

// release.json next to the zips of one package version.
export interface ReleaseInfo {
  tag: string;
  name?: string; // the release's title on GitHub
  published: string;
  url: string;
  prerelease?: boolean; // a release candidate of the firmware
  assets?: string[]; // sound packs: every file of the release, for the choice of voices
}

// commit.json next to the source archive of a project's newest main commit.
export interface MainInfo {
  sha: string;
  date: string;
}

export function versionDir(p: Paths, name: string, tag: string): string {
  return join(p.packages, name, tag);
}

// Next to the releases; has no release.json, so it never counts as a release.
export function mainDir(p: Paths, name: string): string {
  return join(p.packages, name, '_main');
}

export async function mainInfo(p: Paths, name: string): Promise<MainInfo | undefined> {
  const text = await readFile(join(mainDir(p, name), 'commit.json'), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as MainInfo);
}

// "main 1a2b3c4"
export function mainVersion(info: MainInfo): string {
  return `main ${info.sha.slice(0, 7)}`;
}

// Downloaded versions of a package, newest release first; pre-releases only when asked for.
export async function localVersions(p: Paths, name: string, prereleases = false): Promise<ReleaseInfo[]> {
  const dirs = await readdir(join(p.packages, name), { withFileTypes: true }).catch(() => []);
  const infos = await Promise.all(
    dirs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const text = await readFile(join(p.packages, name, d.name, 'release.json'), 'utf8').catch(() => undefined);
        return text === undefined ? undefined : (JSON.parse(text) as ReleaseInfo);
      }),
  );
  return infos
    .filter((i): i is ReleaseInfo => i !== undefined && (prereleases || !i.prerelease))
    .sort((a, b) => b.published.localeCompare(a.published));
}

export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isFile()) total += (await stat(join(e.parentPath, e.name))).size;
  }
  return total;
}

// Radios that had this package version installed when last seen; such versions can't be deleted.
export function installedOn(s: Settings, name: string, tag: string): string[] {
  return Object.entries(s.radios)
    .filter(([, r]) => r.installed?.[name] === tag || (name === 'edgetx-firmware' && r.firmware && `v${r.firmware}` === tag))
    .map(([board]) => board);
}

export async function deleteVersion(p: Paths, s: Settings, name: string, tag: string): Promise<void> {
  if (!isSafeName(name) || !isSafeName(tag)) throw new AppError('invalidRequest', { what: 'package' });
  const boards = installedOn(s, name, tag);
  if (boards.length > 0) throw new AppError('installedOn', { name, tag, radios: boards.join(', ') });
  await rm(versionDir(p, name, tag), { recursive: true, force: true });
}
