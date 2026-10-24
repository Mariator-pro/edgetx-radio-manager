import { AppError } from './errors.ts';

export type FetchFn = typeof fetch;

export interface Asset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  tag: string;
  name?: string; // e.g. 'EdgeTX "Queen Anne's Revenge" v2.12.5'
  published: string;
  url: string;
  zipball: string;
  assets: Asset[];
  prerelease: boolean;
}

const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'edgetx-radio-manager' };

interface ApiRelease {
  tag_name: string;
  name?: string | null;
  published_at: string;
  html_url: string;
  zipball_url: string;
  assets: { name: string; browser_download_url: string; size: number }[];
  draft?: boolean;
  prerelease?: boolean;
}

// Newest non-prerelease release, or undefined when the repo has none.
export function latestRelease(repo: string, fetchFn: FetchFn = fetch): Promise<Release | undefined> {
  return getRelease(`https://api.github.com/repos/${repo}/releases/latest`, fetchFn);
}

// The release of one tag, or undefined when there is none.
export function releaseByTag(repo: string, tag: string, fetchFn: FetchFn = fetch): Promise<Release | undefined> {
  return getRelease(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, fetchFn);
}

// The newest 30 releases without drafts, newest first: the finished ones, or with prereleases only the pre-releases.
export async function listReleases(repo: string, fetchFn: FetchFn = fetch, prereleases = false): Promise<Release[]> {
  const list = await getJson<ApiRelease[]>(`https://api.github.com/repos/${repo}/releases?per_page=30`, fetchFn);
  return (list ?? []).filter((r) => !r.draft && !!r.prerelease === prereleases).map(toRelease);
}

export interface Commit {
  sha: string;
  date: string;
  zipball: string;
}

// Newest commit on the default branch, or undefined when the repo has none (409: empty repo).
export async function latestCommit(repo: string, fetchFn: FetchFn = fetch): Promise<Commit | undefined> {
  const c = await getJson<{ sha: string; commit: { committer: { date: string } } }>(
    `https://api.github.com/repos/${repo}/commits/HEAD`,
    fetchFn,
    [404, 409],
  );
  return c && { sha: c.sha, date: c.commit.committer.date, zipball: `https://api.github.com/repos/${repo}/zipball/${c.sha}` };
}

async function getJson<T>(url: string, fetchFn: FetchFn, missing = [404]): Promise<T | undefined> {
  const res = await fetchFn(url, { headers: HEADERS }).catch(() => {
    throw new AppError('noConnection');
  });
  if (missing.includes(res.status)) return undefined;
  if (!res.ok) {
    const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
    const reset = Number(res.headers.get('x-ratelimit-reset')); // seconds since 1970
    if (limited) throw new AppError('rateLimit', reset ? { reset: new Date(reset * 1000).toISOString() } : {});
    throw new AppError('githubStatus', { status: res.status });
  }
  return (await res.json()) as T;
}

async function getRelease(url: string, fetchFn: FetchFn): Promise<Release | undefined> {
  const r = await getJson<ApiRelease>(url, fetchFn);
  return r && toRelease(r);
}

function toRelease(r: ApiRelease): Release {
  return {
    tag: r.tag_name,
    ...(r.name ? { name: r.name } : {}),
    published: r.published_at,
    url: r.html_url,
    zipball: r.zipball_url,
    assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    prerelease: !!r.prerelease,
  };
}
