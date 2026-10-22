import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadContent, type Origin, type PackageContent, type RadioContext } from './content.ts';
import { localVersions, mainInfo } from './packages.ts';
import type { Paths } from './paths.ts';
import { ON_FOR_NEW_RADIOS, type Settings, type Source } from './settings.ts';

// Sources that put files on the SD card (firmware is flashed instead).
export function updateSources(s: Settings): Source[] {
  return s.sources.filter((src) => src.kind !== 'firmware');
}

// Release when one is downloaded, else the newest main commit, else the local checkout when there is one.
export async function defaultOrigin(p: Paths, source: Source): Promise<Origin> {
  if ((await localVersions(p, source.name)).length > 0) return 'release';
  if (await mainInfo(p, source.name)) return 'main';
  return source.localDir ? 'local' : 'release';
}

// Folders under SCRIPTS/ and WIDGETS/ that only this package brings. Shared ones like
// SCRIPTS/TOOLS or the Flight Bag copies say nothing about which project is installed.
export function ownFolders(contents: PackageContent[]): Map<string, string[]> {
  const folders = contents.map((c) => {
    const set = new Set<string>();
    for (const path of c.files.keys()) {
      const parts = path.split('/');
      if (parts.length > 2 && (parts[0] === 'SCRIPTS' || parts[0] === 'WIDGETS')) set.add(`${parts[0]}/${parts[1]}`);
    }
    return { name: c.name, set };
  });
  return new Map(
    folders.map(({ name, set }) => [name, [...set].filter((f) => folders.every((o) => o.name === name || !o.set.has(f)))]),
  );
}

async function anyExists(root: string, rels: string[]): Promise<boolean> {
  for (const rel of rels) if (await stat(join(root, rel)).catch(() => undefined)) return true;
  return false;
}

// First detection of a radio: EdgeTX content always, Flight Wingman, and projects that are already on the card
// (switching those off would delete them on the next update).
// Later: sources added since then come in switched off and listed as new.
export async function ensureSelection(
  p: Paths,
  s: Settings,
  board: string,
  cardRoot: string,
  ctx: RadioContext,
): Promise<boolean> {
  const r = (s.radios[board] ??= {});
  const sources = updateSources(s);
  if (!r.sources) {
    const origins = new Map<string, Origin>();
    for (const src of sources) origins.set(src.name, await defaultOrigin(p, src));
    const projects = sources.filter((src) => src.kind === 'project');
    const contents = await Promise.all(projects.map((src) => loadContent(p, src, origins.get(src.name)!, ctx).catch(() => undefined)));
    const own = ownFolders(contents.filter((c): c is PackageContent => c !== undefined));
    r.sources = {};
    for (const src of sources) {
      const on = src.kind !== 'project' || ON_FOR_NEW_RADIOS.includes(src.name) || (await anyExists(cardRoot, own.get(src.name) ?? []));
      r.sources[src.name] = { on, origin: origins.get(src.name)! };
    }
    return true;
  }
  let changed = false;
  for (const src of sources) {
    if (r.sources[src.name]) continue;
    r.sources[src.name] = { on: false, origin: await defaultOrigin(p, src) };
    (r.newSources ??= []).push(src.name);
    changed = true;
  }
  return changed;
}
