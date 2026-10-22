import { AppError } from './errors.ts';

export type FetchFn = typeof fetch;

export interface Asset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  tag: string;
  published: string;
  url: string;
  zipball: string;
  assets: Asset[];
}

const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'edgetx-radio-manager' };

interface ApiRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  zipball_url: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

// Newest non-prerelease release, or undefined when the repo has none.
export function latestRelease(repo: string, fetchFn: FetchFn = fetch): Promise<Release | undefined> {
  return getRelease(`https://api.github.com/repos/${repo}/releases/latest`, fetchFn);
}

// The release of one tag, or undefined when there is none.
export function releaseByTag(repo: string, tag: string, fetchFn: FetchFn = fetch): Promise<Release | undefined> {
  return getRelease(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, fetchFn);
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
    throw limited ? new AppError('rateLimit') : new AppError('githubStatus', { status: res.status });
  }
  return (await res.json()) as T;
}

async function getRelease(url: string, fetchFn: FetchFn): Promise<Release | undefined> {
  const r = await getJson<ApiRelease>(url, fetchFn);
  if (!r) return undefined;
  return {
    tag: r.tag_name,
    published: r.published_at,
    url: r.html_url,
    zipball: r.zipball_url,
    assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}
