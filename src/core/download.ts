import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { AppError, errorInfo, type ErrorInfo } from './errors.ts';
import { latestRelease, releaseByTag, type FetchFn, type Release } from './github.ts';
import { versionDir, type ReleaseInfo } from './packages.ts';
import type { Paths } from './paths.ts';
import { soundsOf, type Settings, type Source } from './settings.ts';

export interface WantedFile {
  name: string;
  url: string;
  size?: number;
}

export interface DownloadResult {
  source: string;
  status: 'new' | 'current' | 'no-release' | 'skipped' | 'error';
  tag?: string;
  files: string[]; // downloaded this run
  message?: string;
  error?: ErrorInfo; // status "error" only
}

export type DownloadEvent =
  | { type: 'checking'; source: string }
  | { type: 'file'; source: string; file: string; size?: number };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sound pack zip of one voice; "en" must not match "en_gb-ryan": the voice id is followed directly by the version.
export function soundPackPattern(voice: string): RegExp {
  return new RegExp(`^edgetx-sdcard-sounds-${escape(voice)}-\\d[\\d.]*\\.zip$`);
}

// Sound packs the radios use: one id per language and voice, e.g. "en", "de", "en_gb-ryan".
export function wantedVoices(s: Settings): string[] {
  const ids = Object.values(s.radios).flatMap(soundsOf);
  return [...new Set(ids)].sort();
}

// The files of a release this tool keeps for a source.
export function wantedFiles(source: Source, release: Release, s: Settings): WantedFile[] {
  const pick = (test: (name: string) => boolean) => release.assets.filter((a) => test(a.name));
  switch (source.kind) {
    case 'firmware':
      return pick((n) => /^edgetx-firmware-.*\.zip$/.test(n));
    case 'sdcard':
      // every screen package, and sdcard.json which says which radio takes which
      return pick((n) => n.endsWith('.zip') || n === 'sdcard.json');
    case 'sounds': {
      const res = wantedVoices(s).map(soundPackPattern);
      return pick((n) => res.some((re) => re.test(n)));
    }
    case 'project': {
      const zips = pick((n) => n.endsWith('.zip'));
      if (zips.length > 0) return zips;
      const repoName = source.repo.split('/')[1] ?? source.name;
      return [{ name: `${repoName}-${release.tag}.zip`, url: release.zipball }];
    }
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  return (await stat(path).catch(() => undefined))?.size;
}

async function fetchTo(url: string, path: string, fetchFn: FetchFn): Promise<void> {
  const res = await fetchFn(url, { headers: { 'User-Agent': 'edgetx-radio-manager' } }).catch(() => {
    throw new AppError('noConnection');
  });
  if (!res.ok || !res.body) throw new AppError('downloadFailed', { status: res.status, url });
  const part = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), createWriteStream(part));
  await rename(part, path);
}

export async function downloadSource(
  p: Paths,
  s: Settings,
  source: Source,
  fetchFn: FetchFn = fetch,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<DownloadResult> {
  onEvent({ type: 'checking', source: source.name });
  const release = await latestRelease(source.repo, fetchFn);
  if (!release) return { source: source.name, status: 'no-release', files: [] };
  return downloadRelease(p, s, source, release, fetchFn, onEvent);
}

// One older release, e.g. the SD content version already on a card, for comparing.
export async function downloadTag(p: Paths, s: Settings, source: Source, tag: string, fetchFn: FetchFn = fetch): Promise<DownloadResult> {
  const release = await releaseByTag(source.repo, tag, fetchFn);
  if (!release) return { source: source.name, status: 'no-release', files: [] };
  return downloadRelease(p, s, source, release, fetchFn);
}

async function downloadRelease(
  p: Paths,
  s: Settings,
  source: Source,
  release: Release,
  fetchFn: FetchFn,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<DownloadResult> {
  const wanted = wantedFiles(source, release, s);
  if (wanted.length === 0) {
    const message = source.kind === 'sounds' ? 'no radio seen yet, language unknown' : 'no matching file in the release';
    return { source: source.name, status: 'skipped', tag: release.tag, files: [], message };
  }

  const dir = versionDir(p, source.name, release.tag);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const f of wanted) {
    const target = join(dir, f.name);
    const have = await fileSize(target);
    if (have !== undefined && (f.size === undefined || have === f.size)) continue;
    onEvent({ type: 'file', source: source.name, file: f.name, size: f.size });
    await fetchTo(f.url, target, fetchFn);
    files.push(f.name);
  }
  const info: ReleaseInfo = { tag: release.tag, published: release.published, url: release.url };
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { source: source.name, status: files.length > 0 ? 'new' : 'current', tag: release.tag, files };
}

// Checks every source; one failing source doesn't stop the others.
export async function downloadAll(
  p: Paths,
  s: Settings,
  fetchFn: FetchFn = fetch,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  for (const source of s.sources) {
    try {
      results.push(await downloadSource(p, s, source, fetchFn, onEvent));
    } catch (e) {
      const error = errorInfo(e);
      results.push({ source: source.name, status: 'error', files: [], message: error.message, error });
    }
  }
  return results;
}
