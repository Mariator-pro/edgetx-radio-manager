import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRadioYml } from '../src/core/card.ts';
import { mainContent } from '../src/core/content.ts';
import { downloadAll, wantedFiles, wantedVoices } from '../src/core/download.ts';
import type { FetchFn, Release } from '../src/core/github.ts';
import { localVersions, mainDir } from '../src/core/packages.ts';
import { paths } from '../src/core/paths.ts';
import { defaultOrigin } from '../src/core/selection.ts';
import { defaultSettings, loadSettings, rememberRadio, type Settings, type Source } from '../src/core/settings.ts';
import { voiceViews } from '../src/server/views.ts';
import { makeZip, tempDir } from './helpers.ts';

const source = (name: string) => defaultSettings().sources.find((s) => s.name === name)!;

const release = (tag: string, assets: string[]): Release => ({
  tag,
  name: `EdgeTX "Test" ${tag}`,
  published: '2026-09-18T14:00:00Z',
  url: `https://github.com/x/y/releases/tag/${tag}`,
  zipball: `https://api.github.com/repos/x/y/zipball/${tag}`,
  assets: assets.map((name) => ({ name, url: `https://dl/${name}`, size: name.length })),
  prerelease: tag.includes('-rc') || tag === 'nightly',
});

const settingsWith = (radios: Settings['radios']): Settings => ({ ...defaultSettings(), radios });

describe('wantedFiles', () => {
  it('takes the firmware zip only', () => {
    const r = release('v2.12.5', ['edgetx-cpn-macos-v2.12.5.zip', 'edgetx-firmware-v2.12.5.zip']);
    expect(wantedFiles(source('edgetx-firmware'), r, defaultSettings()).map((f) => f.name)).toEqual(['edgetx-firmware-v2.12.5.zip']);
  });

  it('takes SD content for every screen and sdcard.json, which maps radios to it', () => {
    const r = release('v2.12.3', ['bw128x64.zip', 'c320x240.zip', 'c480x272.zip', 'notes.txt', 'sdcard.json']);
    expect(wantedFiles(source('edgetx-sdcard'), r, defaultSettings()).map((f) => f.name)).toEqual(['bw128x64.zip', 'c320x240.zip', 'c480x272.zip', 'sdcard.json']);
  });

  it('takes only the sound packs the radios use, "en" not matching other English voices', () => {
    const r = release('v2.12.3', [
      'edgetx-sdcard-sounds-de-2.12.3.zip',
      'edgetx-sdcard-sounds-en-2.12.3.zip',
      'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip',
      'edgetx-sdcard-sounds-fr-2.12.3.zip',
    ]);
    const s = settingsWith({ tx16s: { language: 'en' }, tx15: { language: 'en', sounds: ['de', 'en_gb-ryan'] } });
    expect(wantedVoices(s)).toEqual(['de', 'en', 'en_gb-ryan']);
    expect(wantedFiles(source('edgetx-sounds'), r, s).map((f) => f.name)).toEqual([
      'edgetx-sdcard-sounds-de-2.12.3.zip',
      'edgetx-sdcard-sounds-en-2.12.3.zip',
      'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip',
    ]);
  });

  it('takes no sound pack before any radio was seen', () => {
    const r = release('v2.12.3', ['edgetx-sdcard-sounds-en-2.12.3.zip']);
    expect(wantedFiles(source('edgetx-sounds'), r, defaultSettings())).toEqual([]);
  });

  it('uses attached zips of a project, else the source archive', () => {
    const own = source('lipo-nanny');
    expect(wantedFiles(own, release('v1.1.1', []), defaultSettings())).toEqual([
      { name: 'edgetx-lipo-nanny-v1.1.1.zip', url: 'https://api.github.com/repos/x/y/zipball/v1.1.1' },
    ]);
    const foreign: Source = { name: 'widget', repo: 'someone/widget', kind: 'project' };
    expect(wantedFiles(foreign, release('v2.0', ['widget-v2.0.zip', 'notes.txt']), defaultSettings()).map((f) => f.name)).toEqual(['widget-v2.0.zip']);
  });

  it('takes only the one file of a one-file source', () => {
    expect(wantedFiles(source('elrs-lua'), release('4.1.0', ['elrs.lua', 'firmware.zip']), defaultSettings()).map((f) => f.name)).toEqual(['elrs.lua']);
  });
});

describe('rememberRadio', () => {
  it('takes the sound languages from the card once and keeps chosen voices', () => {
    const s = settingsWith({});
    expect(rememberRadio(s, { volume: '/v', board: 'tx15', language: 'en', soundLanguages: ['de', 'en'] })).toBe(true);
    expect(s.radios.tx15).toEqual({ language: 'en', sounds: ['de', 'en'] });
    s.radios.tx15!.sounds = ['de', 'en_gb-ryan'];
    expect(rememberRadio(s, { volume: '/v', board: 'tx15', language: 'en', soundLanguages: ['de', 'en', 'fr'] })).toBe(false);
    expect(s.radios.tx15!.sounds).toEqual(['de', 'en_gb-ryan']);
  });

  it('changes no other object for a card whose board is a name every object has', () => {
    const s = settingsWith({});
    for (const board of ['__proto__', 'constructor', 'toString']) {
      const card = parseRadioYml(`board: ${board}\nttsLanguage: xx\nsemver: 2.11.0\n`);
      expect(card.board).toBeUndefined();
      expect(rememberRadio(s, { volume: '/v', ...card })).toBe(false);
    }
    expect(({} as Record<string, unknown>).language).toBeUndefined();
    expect(s.radios).toEqual({});
  });

  it('turns the earlier single voice into the sound list', async () => {
    const p = paths(await tempDir());
    await mkdir(p.root, { recursive: true });
    await writeFile(p.settings, JSON.stringify({ radios: { tx16s: { language: 'en', voice: 'en_gb-ryan' } } }));
    expect((await loadSettings(p)).radios.tx16s).toEqual({ language: 'en', sounds: ['en_gb-ryan'] });
  });

  it('adds a new default source to existing settings once', async () => {
    const p = paths(await tempDir());
    await mkdir(p.root, { recursive: true });
    const old = defaultSettings();
    old.sources = old.sources.filter((x) => x.name !== 'elrs-lua');
    delete old.knownDefaults;
    await writeFile(p.settings, JSON.stringify(old));
    const s = await loadSettings(p);
    expect(s.sources.map((x) => x.name)).toContain('elrs-lua');

    expect(s.sources.find((x) => x.name === 'elrs-lua')?.file?.repoPath).toBe('src/lua/elrs.lua');

    s.sources = s.sources.filter((x) => x.name !== 'elrs-lua'); // removed by the user
    await writeFile(p.settings, JSON.stringify(s));
    expect((await loadSettings(p)).sources.map((x) => x.name)).not.toContain('elrs-lua');
  });
});

describe('downloadAll', () => {
  const api = (r: Release) => ({
    tag_name: r.tag,
    name: r.name,
    published_at: r.published,
    html_url: r.url,
    zipball_url: r.zipball,
    assets: r.assets.map((a) => ({ name: a.name, browser_download_url: a.url, size: a.size })),
    prerelease: r.prerelease,
  });

  // Fake GitHub: newest release and release list per repo, file downloads return the file name as content.
  function fakeGitHub(
    releases: Record<string, Release | 'fail'>,
    calls: string[],
    commits: Record<string, string> = {},
    lists: Record<string, Release[]> = {},
  ): FetchFn {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const c = url.match(/repos\/(.+)\/commits\/HEAD$/);
      if (c) {
        const sha = commits[c[1]!];
        return sha ? Response.json({ sha, commit: { committer: { date: '2026-10-01T10:00:00Z' } } }) : new Response('{}', { status: 409 });
      }
      const z = url.match(/zipball\/([0-9a-f]+)$/);
      if (z) return new Response(makeZip({ [`x-y-${z[1]!.slice(0, 7)}/src/WIDGETS/LIPONY/main.lua`]: z[1]! }));
      const l = url.match(/repos\/(.+)\/releases\?/);
      if (l) return Response.json((lists[l[1]!] ?? []).map(api));
      const m = url.match(/repos\/(.+)\/releases\/latest$/);
      if (m) {
        const r = releases[m[1]!];
        if (r === undefined) return new Response('{}', { status: 404 });
        if (r === 'fail') return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
        return Response.json(api(r));
      }
      return new Response(url.split('/').pop());
    }) as FetchFn;
  }

  it('downloads new files once, stores release.json and reports every source', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({ tx16smk3: { language: 'en' } });
    s.sources = [source('edgetx-firmware'), source('edgetx-sounds'), source('gps-homer'), source('lipo-nanny')];
    const releases = {
      'EdgeTX/edgetx': release('v2.12.5', ['edgetx-firmware-v2.12.5.zip']),
      'EdgeTX/edgetx-sdcard-sounds': release('v2.12.3', ['edgetx-sdcard-sounds-en-2.12.3.zip', 'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip']),
      'Mariator-pro/edgetx-lipo-nanny': 'fail' as const,
    };
    const calls: string[] = [];
    const first = await downloadAll(p, s, fakeGitHub(releases, calls));
    expect(first.map((r) => [r.source, r.status])).toEqual([
      ['edgetx-firmware', 'new'],
      ['edgetx-sounds', 'new'],
      ['gps-homer', 'no-release'],
      ['lipo-nanny', 'error'],
    ]);
    expect(first[3]!.message).toMatch(/no more requests/);

    const dir = join(p.packages, 'edgetx-firmware', 'v2.12.5');
    expect((await readdir(dir)).sort()).toEqual(['edgetx-firmware-v2.12.5.zip', 'release.json']);
    expect(await readFile(join(dir, 'edgetx-firmware-v2.12.5.zip'), 'utf8')).toBe('edgetx-firmware-v2.12.5.zip');
    expect((await localVersions(p, 'edgetx-firmware'))[0]).toMatchObject({ tag: 'v2.12.5', name: 'EdgeTX "Test" v2.12.5' });
    expect((await localVersions(p, 'edgetx-firmware'))[0]!.assets).toBeUndefined();
    // the sound packs' file list, so the choice of voices needs no request of its own
    expect((await localVersions(p, 'edgetx-sounds'))[0]!.assets).toEqual(['edgetx-sdcard-sounds-en-2.12.3.zip', 'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip']);
    expect((await voiceViews(p, s)).map((v) => v.id)).toEqual(['en', 'en_gb-ryan']);

    const second = await downloadAll(p, s, fakeGitHub(releases, calls));
    expect(second[0]!.status).toBe('current');
    expect(calls.filter((c) => c.startsWith('https://dl/'))).toHaveLength(2);
  });

  it('stops at the GitHub rate limit instead of asking for every further source', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({});
    s.sources = [source('lipo-nanny'), source('gps-homer')];
    const calls: string[] = [];
    const results = await downloadAll(p, s, fakeGitHub({ 'Mariator-pro/edgetx-lipo-nanny': 'fail' }, calls));
    expect(results.map((r) => [r.source, r.status, r.error?.code])).toEqual([['lipo-nanny', 'error', 'rateLimit']]);
    expect(calls.some((c) => c.includes('gps-homer'))).toBe(false);
  });

  it('writes no file of a release outside its own folder', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({});
    s.sources = [source('lipo-nanny')];
    const calls: string[] = [];
    const evil = release('v1.0.0', ['../../evil.zip', 'good.zip']);
    expect((await downloadAll(p, s, fakeGitHub({ 'Mariator-pro/edgetx-lipo-nanny': evil }, calls)))[0]!.files).toEqual(['good.zip']);
    expect(calls.filter((c) => c.startsWith('https://dl/'))).toEqual(['https://dl/good.zip']);
    const results = await downloadAll(p, s, fakeGitHub({ 'Mariator-pro/edgetx-lipo-nanny': release('..', ['x.zip']) }, calls));
    expect(results[0]).toMatchObject({ status: 'error', error: { code: 'invalidRequest' } });
    expect(await readdir(p.packages)).toEqual(['lipo-nanny']);
  });

  it('downloads only the newest firmware release; older ones come when flashed', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({});
    s.sources = [source('edgetx-firmware')];
    const fw = (tag: string) => release(tag, [`edgetx-firmware-${tag}.zip`]);
    const lists = { 'EdgeTX/edgetx': ['v2.13.0-rc1', 'v2.12.5', 'v2.11.6', 'v2.12.4', 'v2.12.3', 'v2.12.2'].map(fw) };
    const calls: string[] = [];
    const results = await downloadAll(p, s, fakeGitHub({ 'EdgeTX/edgetx': fw('v2.12.5') }, calls, {}, lists));
    expect(results.map((r) => [r.tag, r.status])).toEqual([['v2.12.5', 'new']]);
    expect(await readdir(join(p.packages, 'edgetx-firmware'))).toEqual(['v2.12.5']);
    expect(calls.some((c) => c.includes('/releases?'))).toBe(false);
  });

  it('loads only the one file of a one-file source from the newest main commit', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({});
    s.sources = [source('elrs-lua')];
    const calls: string[] = [];
    const results = await downloadAll(p, s, fakeGitHub({}, calls, { 'ExpressLRS/ExpressLRS': 'ccccccc333' }));
    expect(results.map((r) => [r.status, r.tag])).toEqual([['no-release', undefined], ['new', 'main ccccccc']]);
    expect(calls).toContain('https://raw.githubusercontent.com/ExpressLRS/ExpressLRS/ccccccc333/src/lua/elrs.lua');
    expect(calls.some((c) => c.includes('zipball'))).toBe(false);
    expect((await readdir(mainDir(p, 'elrs-lua'))).sort()).toEqual(['commit.json', 'elrs.lua']);
    const c = await mainContent(p, s.sources[0]!);
    expect([...c!.files.keys()]).toEqual(['SCRIPTS/TOOLS/elrs.lua']);
  });

  it('keeps the newest main commit of a project next to the releases, replacing the older one', async () => {
    const p = paths(await tempDir());
    const s = settingsWith({});
    s.sources = [source('lipo-nanny')];
    const calls: string[] = [];
    const repo = 'Mariator-pro/edgetx-lipo-nanny';
    const first = await downloadAll(p, s, fakeGitHub({}, calls, { [repo]: 'aaaaaaa111' }));
    expect(first.map((r) => [r.status, r.tag])).toEqual([['no-release', undefined], ['new', 'main aaaaaaa']]);
    expect((await downloadAll(p, s, fakeGitHub({}, calls, { [repo]: 'aaaaaaa111' })))[1]!.status).toBe('current');

    await downloadAll(p, s, fakeGitHub({}, calls, { [repo]: 'bbbbbbb222' }));
    expect((await readdir(mainDir(p, 'lipo-nanny'))).sort()).toEqual(['commit.json', 'edgetx-lipo-nanny-bbbbbbb.zip']);
    expect(await localVersions(p, 'lipo-nanny')).toEqual([]);
    const c = await mainContent(p, s.sources[0]!);
    expect(c?.version).toBe('main bbbbbbb');
    expect(c?.files.get('WIDGETS/LIPONY/main.lua')?.data.toString()).toBe('bbbbbbb222');
    expect(await defaultOrigin(p, s.sources[0]!)).toBe('main');
  });
});
