import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { AppError, errorInfo, type ErrorInfo } from './errors.ts';
import { latestCommit, latestRelease, listReleases, releaseByTag, type FetchFn, type Release } from './github.ts';
import { knownVersionIn, knownVersions, newestShipped, SOUND_ZIP, storeVersion, tooOld } from './known.ts';
import { localVersions, mainDir, mainInfo, mainVersion, soundPackPattern, versionDir, type MainInfo, type ReleaseInfo } from './packages.ts';
import { isSafeName, type Paths } from './paths.ts';
import { isBuiltIn, soundsOf, type Settings, type Source } from './settings.ts';

interface WantedFile {
  name: string;
  url: string;
  size?: number;
}

interface DownloadResult {
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
      if (source.file) return pick((n) => n === source.file!.asset);
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
  if (!res.ok || !res.body) throw new AppError('downloadFailed', { status: res.status });
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
  // tag and file names of a release become folder and file names here; a project's repo is anyone's
  if (!isSafeName(release.tag)) throw new AppError('invalidRequest', { what: `tag ${release.tag}` });
  const wanted = wantedFiles(source, release, s).filter((f) => isSafeName(f.name));
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
  const info: ReleaseInfo = {
    tag: release.tag,
    ...(release.name ? { name: release.name } : {}),
    published: release.published,
    url: release.url,
    ...(release.prerelease ? { prerelease: true } : {}),
    ...(source.kind === 'sounds' ? { assets: release.assets.map((a) => a.name) } : {}),
  };
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { source: source.name, status: files.length > 0 ? 'new' : 'current', tag: release.tag, files };
}

// Newest commit on a project's default branch, as source archive in "_main/"; undefined when the repo has no commit.
export async function downloadMain(
  p: Paths,
  source: Source,
  fetchFn: FetchFn = fetch,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<DownloadResult | undefined> {
  const commit = await latestCommit(source.repo, fetchFn);
  if (!commit) return undefined;
  const info: MainInfo = { sha: commit.sha, date: commit.date };
  const tag = mainVersion(info);
  if ((await mainInfo(p, source.name))?.sha === commit.sha) return { source: source.name, status: 'current', tag, files: [] };
  const dir = mainDir(p, source.name);
  await mkdir(dir, { recursive: true });
  // a one-file source loads just that file of the commit, not the whole repo
  const one = source.file?.repoPath;
  const name = one ? source.file!.asset : `${source.repo.split('/')[1] ?? source.name}-${commit.sha.slice(0, 7)}.zip`;
  const url = one ? `https://raw.githubusercontent.com/${source.repo}/${commit.sha}/${one}` : commit.zipball;
  onEvent({ type: 'file', source: source.name, file: name });
  await fetchTo(url, join(dir, name), fetchFn);
  for (const old of await readdir(dir)) if (old !== name) await rm(join(dir, old), { force: true });
  await writeFile(join(dir, 'commit.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { source: source.name, status: 'new', tag, files: [name] };
}

// Checks every source, projects also for their newest main commit; one failing source doesn't stop the others.
export async function downloadAll(
  p: Paths,
  s: Settings,
  fetchFn: FetchFn = fetch,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  for (const source of s.sources) {
    await allowSearch(p, source);
    try {
      const result = await downloadSource(p, s, source, fetchFn, onEvent);
      results.push(result);
      // recognizing more versions is a bonus: whatever fails is tried again with the next check
      if (result.tag) await learnNewer(p, s, source, result.tag, fetchFn, onEvent).catch(() => {});
    } catch (e) {
      const error = errorInfo(e);
      results.push({ source: source.name, status: 'error', files: [], message: error.message, error });
      if (error.code === 'rateLimit') return results; // every further request fails the same way
    }
    if (source.kind !== 'project' || (source.file && !source.file.repoPath)) continue; // no main without a path in the repo
    try {
      const main = await downloadMain(p, source, fetchFn, onEvent);
      if (main) results.push(main);
    } catch (e) {
      const error = errorInfo(e);
      results.push({ source: source.name, status: 'error', tag: 'main', files: [], message: error.message, error });
      if (error.code === 'rateLimit') return results;
    }
  }
  return results;
}

// The releases of a repo, newest first, asked for at most every 10 minutes: GitHub allows 60 requests an hour.
const releaseLists = new Map<string, { at: number; releases: Release[] }>();

async function releaseList(p: Paths, repo: string, fetchFn: FetchFn): Promise<Release[]> {
  const key = `${p.root}|${repo}`;
  const have = releaseLists.get(key);
  if (have && Date.now() - have.at < 10 * 60_000) return have.releases;
  const releases = (await listReleases(repo, fetchFn)).sort((a, b) => b.published.localeCompare(a.published));
  releaseLists.set(key, { at: Date.now(), releases });
  return releases;
}

// Notes a search that ended without a match, so reading a card doesn't ask GitHub again until the next check for updates.
const searchedFile = (p: Paths, source: Source) => join(p.known, source.name, 'searched');

async function allowSearch(p: Paths, source: Source): Promise<void> {
  releaseLists.delete(`${p.root}|${source.repo}`);
  if (isSafeName(source.name)) await rm(searchedFile(p, source), { force: true });
}

// Loads one release only for its checksums, unless they are known; true when there are new ones.
async function learnRelease(
  p: Paths,
  s: Settings,
  source: Source,
  release: Release,
  fetchFn: FetchFn,
  onEvent: (e: DownloadEvent) => void = () => {},
): Promise<boolean> {
  if (!isSafeName(release.tag) || tooOld(source, release.tag)) return false;
  const known = (await knownVersions(p, source)).find((v) => v.tag === release.tag);
  // a known version of the sounds can lack a voice chosen since
  if (known && source.kind !== 'sounds') return false;
  const wanted = wantedFiles(source, release, s).filter((f) => isSafeName(f.name) && !known?.variants.has(f.name.match(SOUND_ZIP)?.[1] ?? ''));
  if (wanted.length === 0) return false;
  const dir = await mkdtemp(join(tmpdir(), 'radio-manager-'));
  try {
    for (const f of wanted) {
      onEvent({ type: 'file', source: source.name, file: f.name, size: f.size });
      await fetchTo(f.url, join(dir, f.name), fetchFn);
    }
    const version = await knownVersionIn(dir, source, release.tag, release.published);
    for (const [variant, files] of known?.variants ?? []) version.variants.set(variant, files);
    // stored even without files for the card, so it isn't loaded again
    await storeVersion(p, source, version);
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Built-in sources: every release newer than the shipped checksums; the newest one is downloaded as a package anyway.
async function learnNewer(p: Paths, s: Settings, source: Source, newest: string, fetchFn: FetchFn, onEvent: (e: DownloadEvent) => void): Promise<void> {
  if (source.kind === 'firmware' || !isBuiltIn(source)) return;
  const shipped = newestShipped(source.name);
  if (!shipped || shipped.tag === newest) return;
  const local = (await localVersions(p, source.name)).map((v) => v.tag);
  for (const r of await releaseList(p, source.repo, fetchFn)) {
    if (r.published <= shipped.published || local.includes(r.tag)) continue;
    await learnRelease(p, s, source, r, fetchFn, onEvent);
  }
}

// Added projects: the newest releases, so the usual versions are recognized without a search.
export async function learnNewest(p: Paths, s: Settings, source: Source, count: number, fetchFn: FetchFn = fetch): Promise<void> {
  await allowSearch(p, source);
  for (const r of (await releaseList(p, source.repo, fetchFn)).slice(0, count)) await learnRelease(p, s, source, r, fetchFn);
}

// Added projects: loads releases not known yet, newest first, until `found` says one of them is on the card.
// Ends quietly without internet; a release that can't be loaded is skipped. Once all were tried, it does nothing
// until the next check for updates.
export async function learnUntil(p: Paths, s: Settings, source: Source, found: () => Promise<boolean>, fetchFn: FetchFn, signal?: AbortSignal): Promise<void> {
  if (!isSafeName(source.name) || (await fileSize(searchedFile(p, source))) !== undefined) return;
  const releases = await releaseList(p, source.repo, fetchFn).catch(() => undefined);
  if (!releases) return;
  for (const r of releases) {
    if (signal?.aborted) return;
    try {
      if (!(await learnRelease(p, s, source, r, fetchFn))) continue;
    } catch (e) {
      if (e instanceof AppError && e.code === 'downloadFailed') continue;
      return; // connection lost, tried again at the next reading
    }
    if (await found()) return;
  }
  if (signal?.aborted) return;
  await mkdir(join(p.known, source.name), { recursive: true });
  await writeFile(searchedFile(p, source), '');
}
