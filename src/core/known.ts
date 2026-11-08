import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isExcluded, sdPrefix, sha256 } from './content.ts';
import { KNOWN_FILES } from './known-files.ts';
import { localVersions, versionDir } from './packages.ts';
import { isSafeName, type Paths } from './paths.ts';
import { isBelowMin, radioTypesIn } from './radios.ts';
import type { Source } from './settings.ts';
import { readZip } from './zip.ts';

// What every version of a package puts on the card, to tell from the card which version it holds.
// The app ships these checksums for all versions up to its build (scripts/known-files.ts) and adds those of
// versions it downloads later (Known/ in the data folder).

export interface KnownFile {
  sha: string;
  size: number;
}

// variant -> card path -> file. Variant: the zip of one screen size (SD content), one voice (sounds), "" (projects).
export type Variants = Map<string, Map<string, KnownFile>>;

export interface KnownVersion {
  tag: string;
  published: string;
  boards?: Record<string, string>; // SD content: radio type -> its variant
  variants: Variants;
}

// The stored form, compact: each path once, with every content it had and the versions that had it.
export interface KnownSource {
  versions: { tag: string; published: string; boards?: Record<string, string> }[];
  packs: Record<string, Record<string, [sha: string, size: number, versions: number[]][]>>;
}

export type KnownCatalog = Record<string, KnownSource>;

export const SOUND_ZIP = /^edgetx-sdcard-sounds-(.+)-\d[\d.]*\.zip$/;

// EdgeTX packages older than the app supports aren't compared with.
export function tooOld(source: Source, tag: string): boolean {
  return (source.kind === 'sdcard' || source.kind === 'sounds') && isBelowMin(tag.replace(/^v/, ''));
}

// The files of one downloaded version, by variant.
export async function variantsIn(dir: string, source: Source): Promise<Variants> {
  const out: Variants = new Map();
  if (source.file) {
    const data = await readFile(join(dir, source.file.asset)).catch(() => undefined);
    if (data) out.set('', new Map([[source.file.card, { sha: sha256(data), size: data.length }]]));
    return out;
  }
  const zips = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.zip')).sort();
  for (const zip of zips) {
    const variant = source.kind === 'sdcard' ? zip.slice(0, -4) : source.kind === 'sounds' ? zip.match(SOUND_ZIP)?.[1] : '';
    if (variant === undefined) continue;
    const entries = await readZip(join(dir, zip));
    const prefix = sdPrefix([...entries.keys()], source.sdDir);
    if (prefix === undefined) continue;
    const files = out.get(variant) ?? new Map<string, KnownFile>();
    for (const [name, data] of entries) {
      const path = name.slice(prefix.length);
      if (!name.startsWith(prefix) || path === '' || isExcluded(path, source.kind)) continue;
      files.set(path, { sha: sha256(data), size: data.length });
    }
    out.set(variant, files);
  }
  return out;
}

export async function knownVersionIn(dir: string, source: Source, tag: string, published: string): Promise<KnownVersion> {
  const types = source.kind === 'sdcard' ? await radioTypesIn(dir) : [];
  const boards = Object.fromEntries(types.map((t) => [t.board, t.sdPackage]));
  return { tag, published, ...(types.length > 0 ? { boards } : {}), variants: await variantsIn(dir, source) };
}

export function packKnown(versions: KnownVersion[]): KnownSource {
  const packs: KnownSource['packs'] = {};
  versions.forEach((v, i) => {
    for (const [variant, files] of v.variants) {
      const pack = (packs[variant] ??= {});
      for (const [path, f] of files) {
        const contents = (pack[path] ??= []);
        const same = contents.find(([sha]) => sha === f.sha);
        if (same) same[2].push(i);
        else contents.push([f.sha, f.size, [i]]);
      }
    }
  });
  return { versions: versions.map(({ variants: _v, ...rest }) => rest), packs };
}

export function unpackKnown(k: KnownSource): KnownVersion[] {
  const versions: KnownVersion[] = k.versions.map((v) => ({ ...v, variants: new Map() }));
  for (const [variant, pack] of Object.entries(k.packs)) {
    for (const [path, contents] of Object.entries(pack)) {
      for (const [sha, size, which] of contents) {
        for (const i of which) {
          const v = versions[i];
          if (!v) continue;
          let files = v.variants.get(variant);
          if (!files) v.variants.set(variant, (files = new Map()));
          files.set(path, { sha, size });
        }
      }
    }
  }
  return versions;
}

let catalog: KnownCatalog = KNOWN_FILES;
const shipped = new Map<string, KnownVersion[]>();
const merged = new Map<string, { key: string; versions: KnownVersion[] }>();

// Tests compare with their own versions only.
export function setShippedCatalog(c: KnownCatalog): void {
  catalog = c;
  shipped.clear();
  merged.clear();
}

function shippedVersions(name: string): KnownVersion[] {
  if (!shipped.has(name)) shipped.set(name, catalog[name] ? unpackKnown(catalog[name]) : []);
  return shipped.get(name)!;
}

async function storedVersion(p: Paths, source: Source, tag: string): Promise<KnownVersion | undefined> {
  const text = await readFile(join(p.known, source.name, `${tag}.json`), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return unpackKnown(JSON.parse(text) as KnownSource)[0];
  } catch {
    return undefined; // damaged: read again from the package
  }
}

// Stores the checksums of a downloaded version, so they stay when the package is deleted.
export async function rememberVersion(p: Paths, source: Source, tag: string): Promise<KnownVersion | undefined> {
  if (!isSafeName(source.name) || !isSafeName(tag)) return undefined;
  const info = (await localVersions(p, source.name)).find((v) => v.tag === tag);
  if (!info || tooOld(source, tag)) return undefined;
  const v = await knownVersionIn(versionDir(p, source.name, tag), source, tag, info.published);
  if (v.variants.size === 0) return undefined;
  const dir = join(p.known, source.name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${tag}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(packKnown([v])));
  await rename(`${file}.tmp`, file);
  return v;
}

function joinVersion(into: KnownVersion, more: KnownVersion): void {
  for (const [variant, files] of more.variants) if (!into.variants.has(variant)) into.variants.set(variant, files);
  into.boards = { ...more.boards, ...into.boards };
}

// Every known version of a package, newest first: shipped with the app, stored, and downloaded ones not
// stored yet (downloads from before the app stored them).
export async function knownVersions(p: Paths, source: Source): Promise<KnownVersion[]> {
  const local = (await localVersions(p, source.name)).filter((v) => !tooOld(source, v.tag));
  const storedTags = (await readdir(join(p.known, source.name)).catch(() => [])).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  const key = JSON.stringify([local.map((v) => v.tag), storedTags]);
  const cacheKey = `${p.root}|${source.name}`;
  const cached = merged.get(cacheKey);
  if (cached?.key === key) return cached.versions;

  const byTag = new Map<string, KnownVersion>();
  for (const v of shippedVersions(source.name)) byTag.set(v.tag, { ...v, variants: new Map(v.variants) });
  const add = (v: KnownVersion | undefined) => {
    if (!v) return;
    const have = byTag.get(v.tag);
    if (have) joinVersion(have, v);
    else byTag.set(v.tag, v);
  };
  for (const tag of storedTags) add(await storedVersion(p, source, tag));
  for (const v of local) if (!storedTags.includes(v.tag)) add(await rememberVersion(p, source, v.tag));
  const versions = [...byTag.values()].filter((v) => !tooOld(source, v.tag)).sort((a, b) => b.published.localeCompare(a.published));
  merged.set(cacheKey, { key, versions });
  return versions;
}
