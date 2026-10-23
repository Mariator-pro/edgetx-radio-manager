import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../src/core/apply.ts';
import { readCard, type RadioCard } from '../src/core/card.ts';
import { detectVersion, isExcluded, localContent, releaseContent, sameOnCard, sdPrefix, sha256, type PackageContent } from '../src/core/content.ts';
import { versionDir } from '../src/core/packages.ts';
import { paths, type Paths } from '../src/core/paths.ts';
import { countActions, makePlan, mergePackages } from '../src/core/plan.ts';
import { ensureSelection, ownFolders } from '../src/core/selection.ts';
import { defaultSettings, findLocalRepos, type Settings } from '../src/core/settings.ts';
import { prepareUpdate } from '../src/core/update.ts';
import { makeZip, SDCARD_JSON, tempDir, writeTree } from './helpers.ts';

const src = (name: string) => defaultSettings().sources.find((s) => s.name === name)!;

async function writeRelease(p: Paths, name: string, tag: string, published: string, zips: Record<string, Record<string, string>>) {
  const dir = versionDir(p, name, tag);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'release.json'), JSON.stringify({ tag, published, url: '' }));
  for (const [zip, files] of Object.entries(zips)) await writeFile(join(dir, zip), makeZip(files));
  if (name === 'edgetx-sdcard') await writeFile(join(dir, 'sdcard.json'), SDCARD_JSON);
}

function pkg(name: string, origin: 'release' | 'local', time: number, files: Record<string, string>): PackageContent {
  const map = new Map(Object.entries(files).map(([path, text]) => [path, { data: Buffer.from(text), sha: sha256(Buffer.from(text)), time }]));
  return { name, origin, version: origin === 'local' ? 'local abc1234' : 'v1', files: map };
}

async function newCard(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir();
  await writeTree(root, { 'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16smk3\nttsLanguage: "en"\n', 'MODELS/model00.yml': 'm', ...files });
  return root;
}

describe('package content', () => {
  it('finds the card root in EdgeTX zips, below sdDir and in GitHub source archives', () => {
    expect(sdPrefix(['SCRIPTS/TOOLS/a.lua', 'WIDGETS/x/main.lua', 'README.md'])).toBe('');
    expect(sdPrefix(['src/SCRIPTS/A/core.lua', 'README.md'], 'src')).toBe('src/');
    expect(sdPrefix(['owner-repo-1a2b3c/README.md', 'owner-repo-1a2b3c/src/WIDGETS/A/main.lua'], 'src')).toBe('owner-repo-1a2b3c/src/');
    expect(sdPrefix(['docs/a.md'])).toBeUndefined();
  });

  it('never installs runtime data, models or radio settings', () => {
    expect(isExcluded('SCRIPTS/LIPONY/config.lua', 'project')).toBe(true);
    expect(isExcluded('SCRIPTS/GPSHOMER/flights.lua', 'project')).toBe(true);
    expect(isExcluded('MODELS/model00.yml', 'project')).toBe(true);
    expect(isExcluded('MODELS/README.txt', 'sdcard')).toBe(false);
    expect(isExcluded('RADIO/radio.yml', 'sdcard')).toBe(true);
    expect(isExcluded('SCRIPTS/._core.lua', 'project')).toBe(true);
    expect(isExcluded('SCRIPTS/LIPONY/core.lua', 'project')).toBe(false);
  });

  it('reads the zip that sdcard.json names for the radio, and the voice, from the newest release', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.2', '2026-08-01T00:00:00Z', { 'c800x480.zip': { 'WIDGETS/Old/main.lua': 'old' } });
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', {
      'c800x480.zip': { 'WIDGETS/BattAnalog/main.lua': 'big', 'MODELS/README.txt': 'r', 'RADIO/README.txt': 'r' },
      'c480x272.zip': { 'WIDGETS/BattAnalog/main.lua': 'small' },
    });
    const c = await releaseContent(p, src('edgetx-sdcard'), { board: 'tx16smk3' });
    expect(c?.version).toBe('v2.12.3');
    expect([...c!.files.keys()].sort()).toEqual(['MODELS/README.txt', 'RADIO/README.txt', 'WIDGETS/BattAnalog/main.lua']);
    expect(c!.files.get('WIDGETS/BattAnalog/main.lua')!.data.toString()).toBe('big');

    await writeRelease(p, 'edgetx-sounds', 'v2.12.3', '2026-09-01T00:00:00Z', {
      'edgetx-sdcard-sounds-en-2.12.3.zip': { 'SOUNDS/en/hello.wav': 'std' },
      'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip': { 'SOUNDS/en/hello.wav': 'ryan' },
    });
    const sounds = await releaseContent(p, src('edgetx-sounds'), { voices: ['en_gb-ryan'] });
    expect(sounds!.files.get('SOUNDS/en/hello.wav')!.data.toString()).toBe('ryan');
  });

  it('reads a GitHub source archive below src/', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'lipo-nanny', 'v1.1.1', '2026-09-18T00:00:00Z', {
      'edgetx-lipo-nanny-v1.1.1.zip': {
        'Mariator-pro-edgetx-lipo-nanny-1a2b3c/README.md': 'readme',
        'Mariator-pro-edgetx-lipo-nanny-1a2b3c/src/WIDGETS/LIPONY/main.lua': 'widget',
        'Mariator-pro-edgetx-lipo-nanny-1a2b3c/src/SCRIPTS/LIPONY/config.lua': 'no',
      },
    });
    const c = await releaseContent(p, src('lipo-nanny'), {});
    expect([...c!.files.keys()]).toEqual(['WIDGETS/LIPONY/main.lua']);
  });

  it('puts the one file of a one-file source at its card path', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    const c = await releaseContent(p, src('elrs-lua'), {});
    expect([...c!.files.keys()]).toEqual(['SCRIPTS/TOOLS/elrs.lua']);
    expect(c!.version).toBe('4.1.0');
  });

  it('finds the version of a project copied to the card by hand', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'lipo-nanny', 'v1.0.0', '2026-08-01T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'old', 'src/WIDGETS/LIPONY/ui.lua': 'ui' } });
    await writeRelease(p, 'lipo-nanny', 'v1.1.0', '2026-09-01T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'new', 'src/WIDGETS/LIPONY/ui.lua': 'ui' } });
    const nanny = src('lipo-nanny');
    expect(await detectVersion(p, nanny, await newCard({ 'WIDGETS/LIPONY/main.lua': 'old', 'WIDGETS/LIPONY/ui.lua': 'ui' }), 'release')).toMatchObject({
      version: 'v1.0.0',
      origin: 'release',
      onCard: true,
    });
    expect(await detectVersion(p, nanny, await newCard({ 'WIDGETS/LIPONY/main.lua': 'mine', 'WIDGETS/LIPONY/ui.lua': 'ui' }), 'release')).toEqual({
      onCard: true,
    });
    expect(await detectVersion(p, nanny, await newCard({ 'WIDGETS/LIPONY/ui.lua': 'ui' }), 'release')).toEqual({ onCard: false });

    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    expect(await detectVersion(p, src('elrs-lua'), await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'lua' }), 'main')).toMatchObject({ version: '4.1.0', onCard: true });
  });

  it('sees the same files under another version label as no update', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'lipo-nanny', 'v1.2.0', '2026-09-01T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'same' } });
    const listed = (files: string[]) =>
      JSON.stringify({
        tool: 1,
        updated: '2026-10-01T00:00:00Z',
        packages: { 'lipo-nanny': { version: 'local abc1234', origin: 'local' } },
        files: Object.fromEntries(files.map((f) => [f, { sha256: '', from: ['lipo-nanny'], written: 'lipo-nanny' }])),
      });
    const card = async (files: string[]) =>
      (await readCard(await newCard({ 'WIDGETS/LIPONY/main.lua': 'same', '.radio-manager/installed.json': listed(files) })))!;
    expect(await sameOnCard(p, src('lipo-nanny'), await card(['WIDGETS/LIPONY/main.lua']), 'release')).toBe(true);
    // the release no longer has old.lua, so an update would delete it
    expect(await sameOnCard(p, src('lipo-nanny'), await card(['WIDGETS/LIPONY/main.lua', 'WIDGETS/LIPONY/old.lua']), 'release')).toBe(false);
  });

  it('reads committed files of a local checkout in their working-tree state', async () => {
    const repo = await tempDir();
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q');
    await writeTree(repo, { 'src/SCRIPTS/HOMER/core.lua': 'v1', 'src/SCRIPTS/HOMER/config.lua': 'cfg', 'README.md': 'r' });
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await writeTree(repo, { 'src/SCRIPTS/HOMER/core.lua': 'v2', 'src/SCRIPTS/HOMER/untracked.lua': 'x' });
    const c = await localContent({ name: 'gps-homer', repo: 'x/edgetx-gps-homer', kind: 'project', sdDir: 'src', localDir: repo });
    expect([...c!.files.keys()]).toEqual(['SCRIPTS/HOMER/core.lua']);
    expect(c!.files.get('SCRIPTS/HOMER/core.lua')!.data.toString()).toBe('v2');
    expect(c!.version).toMatch(/^local [0-9a-f]{7,}\*$/);
  });

  it('finds own checkouts next to the tool', async () => {
    const parent = await tempDir();
    await mkdir(join(parent, 'edgetx-lipo-nanny', '.git'), { recursive: true });
    const s = defaultSettings();
    expect(findLocalRepos(s, parent)).toBe(true);
    expect(s.sources.find((x) => x.name === 'lipo-nanny')!.localDir).toBe(join(parent, 'edgetx-lipo-nanny'));
    expect(s.sources.find((x) => x.name === 'gps-homer')!.localDir).toBeUndefined();
  });
});

describe('overlapping files', () => {
  it('lets local beat release, then the newer one win, and records every source', () => {
    const w = mergePackages([
      pkg('lipo-nanny', 'release', 200, { 'SCRIPTS/LIPONY/core.lua': 'release', 'SCRIPTS/TOOLS/FLIGHTBAG.lua': 'fb-new' }),
      pkg('flight-wingman', 'local', 100, { 'SCRIPTS/LIPONY/core.lua': 'local-old' }),
      pkg('link-sentinel', 'release', 100, { 'SCRIPTS/TOOLS/FLIGHTBAG.lua': 'fb-old' }),
    ]);
    expect(w.get('SCRIPTS/LIPONY/core.lua')).toMatchObject({ written: 'flight-wingman', from: ['lipo-nanny', 'flight-wingman'] });
    expect(w.get('SCRIPTS/LIPONY/core.lua')!.data.toString()).toBe('local-old');
    expect(w.get('SCRIPTS/TOOLS/FLIGHTBAG.lua')).toMatchObject({ written: 'lipo-nanny', from: ['lipo-nanny', 'link-sentinel'] });
  });

  it('takes the newer file between two local checkouts', () => {
    const w = mergePackages([pkg('a', 'local', 100, { 'X/f': 'old' }), pkg('b', 'local', 300, { 'X/f': 'new' })]);
    expect(w.get('X/f')!.written).toBe('b');
  });
});

describe('plan and apply', () => {
  it('adds, keeps unchanged and records the list', async () => {
    const root = await newCard({ 'WIDGETS/A/same.lua': 'same', 'WIDGETS/Mine/main.lua': 'mine' });
    const contents = [pkg('a', 'release', 1, { 'WIDGETS/A/main.lua': 'new', 'WIDGETS/A/same.lua': 'same' })];
    const plan = await makePlan(root, mergePackages(contents));
    expect(plan.map((i) => [i.path, i.action])).toEqual([
      ['WIDGETS/A/main.lua', 'add'],
      ['WIDGETS/A/same.lua', 'unchanged'],
    ]);
    await applyPlan(root, plan, contents);
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('new');
    expect(await readFile(join(root, 'WIDGETS/Mine/main.lua'), 'utf8')).toBe('mine');
    const card = (await readCard(root))!;
    expect(card.installed!.packages).toEqual({ a: { version: 'v1', origin: 'release' } });
    expect(Object.keys(card.installed!.files).sort()).toEqual(['WIDGETS/A/main.lua', 'WIDGETS/A/same.lua']);
  });

  it('replaces, deletes what no package delivers any more, drops stale .luac and empty folders', async () => {
    const root = await newCard();
    const v1 = [pkg('a', 'release', 1, { 'SCRIPTS/A/core.lua': 'v1', 'SCRIPTS/A/old/gone.lua': 'g', 'SCRIPTS/TOOLS/T.lua': 't' })];
    await applyPlan(root, await makePlan(root, mergePackages(v1)), v1);
    await writeTree(root, { 'SCRIPTS/A/core.luac': 'compiled', 'SCRIPTS/A/old/gone.luac': 'compiled', 'SCRIPTS/TOOLS/Other.lua': 'edgetx' });

    const card = (await readCard(root))!;
    const v2 = [pkg('a', 'release', 2, { 'SCRIPTS/A/core.lua': 'v2', 'SCRIPTS/TOOLS/T.lua': 't' })];
    const plan = await makePlan(root, mergePackages(v2), card.installed);
    expect(plan.filter((i) => i.action !== 'unchanged').map((i) => [i.path, i.action])).toEqual([
      ['SCRIPTS/A/core.lua', 'replace'],
      ['SCRIPTS/A/old/gone.lua', 'delete'],
    ]);
    expect(await applyPlan(root, plan, v2)).toEqual({ written: 1, deleted: 1, kept: 0 });
    expect(await readFile(join(root, 'SCRIPTS/A/core.lua'), 'utf8')).toBe('v2');
    const left = await readdir(join(root, 'SCRIPTS'), { recursive: true });
    expect(left).not.toContain(join('A', 'core.luac'));
    expect(left).not.toContain(join('A', 'old'));
    expect(left).toContain(join('TOOLS', 'Other.lua'));
  });

  it('deletes a file only when no package delivers it any more', async () => {
    const root = await newCard();
    const both = [pkg('a', 'release', 1, { 'SCRIPTS/TOOLS/FB.lua': 'fb' }), pkg('b', 'release', 1, { 'SCRIPTS/TOOLS/FB.lua': 'fb' })];
    await applyPlan(root, await makePlan(root, mergePackages(both)), both);
    const onlyB = [both[1]!];
    const plan = await makePlan(root, mergePackages(onlyB), (await readCard(root))!.installed);
    expect(countActions(plan)).toMatchObject({ delete: 0, unchanged: 1 });
  });

  it('reports conflicts and keeps the card file unless told otherwise', async () => {
    const root = await newCard({ 'WIDGETS/B/main.lua': 'hand-made' });
    const v1 = [pkg('a', 'release', 1, { 'WIDGETS/A/main.lua': 'v1', 'WIDGETS/A/extra.lua': 'e' })];
    await applyPlan(root, await makePlan(root, mergePackages(v1)), v1);
    await writeTree(root, { 'WIDGETS/A/main.lua': 'edited', 'WIDGETS/A/extra.lua': 'edited too' });

    const v2 = [pkg('a', 'release', 2, { 'WIDGETS/A/main.lua': 'v2', 'WIDGETS/B/main.lua': 'package' })];
    const plan = await makePlan(root, mergePackages(v2), (await readCard(root))!.installed);
    expect(plan.map((i) => [i.path, i.action, i.reason])).toEqual([
      ['WIDGETS/A/extra.lua', 'conflict', 'removed-modified'],
      ['WIDGETS/A/main.lua', 'conflict', 'modified'],
      ['WIDGETS/B/main.lua', 'conflict', 'unknown'],
    ]);
    const r = await applyPlan(root, plan, v2, new Map([['WIDGETS/B/main.lua', 'apply']]));
    expect(r).toEqual({ written: 1, deleted: 0, kept: 2 });
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('edited');
    expect(await readFile(join(root, 'WIDGETS/B/main.lua'), 'utf8')).toBe('package');

    const again = await makePlan(root, mergePackages(v2), (await readCard(root))!.installed);
    expect(again.filter((i) => i.action === 'conflict').map((i) => i.path)).toEqual(['WIDGETS/A/main.lua']);
  });
});

describe('selection', () => {
  it('counts only folders a single package brings', () => {
    const own = ownFolders([
      pkg('flight-wingman', 'local', 1, { 'WIDGETS/WINGMAN/main.lua': '', 'SCRIPTS/LIPONY/core.lua': '', 'SCRIPTS/TOOLS/FLIGHTBAG.lua': '' }),
      pkg('lipo-nanny', 'release', 1, { 'WIDGETS/LIPONY/main.lua': '', 'SCRIPTS/LIPONY/core.lua': '', 'SCRIPTS/TOOLS/FLIGHTBAG.lua': '' }),
    ]);
    expect(own.get('flight-wingman')).toEqual(['WIDGETS/WINGMAN']);
    expect(own.get('lipo-nanny')).toEqual(['WIDGETS/LIPONY']);
  });

  it('switches on EdgeTX content, Flight Wingman and the projects already on the card, later sources come in as new', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'lipo-nanny', 'v1.1.1', '2026-09-18T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'w', 'src/SCRIPTS/TOOLS/FLIGHTBAG.lua': 'f' } });
    await writeRelease(p, 'link-sentinel', 'v2.1.1', '2026-09-18T00:00:00Z', { 's.zip': { 'src/WIDGETS/SNTNL/main.lua': 'w', 'src/SCRIPTS/TOOLS/FLIGHTBAG.lua': 'f' } });
    const root = await newCard({ 'WIDGETS/LIPONY/main.lua': 'deployed', 'SCRIPTS/TOOLS/FLIGHTBAG.lua': 'f' });
    const s = defaultSettings();
    expect(await ensureSelection(p, s, 'tx16smk3', root, {})).toBe(true);
    const sel = s.radios.tx16smk3!.sources!;
    expect(sel['edgetx-sdcard']).toEqual({ on: true, origin: 'release' });
    expect(sel['flight-wingman']!.on).toBe(true);
    expect(sel['lipo-nanny']).toEqual({ on: true, origin: 'release' });
    expect(sel['link-sentinel']!.on).toBe(false);
    expect(sel['gps-homer']!.on).toBe(false);
    expect(sel['elrs-lua']!.on).toBe(false);
    expect(sel['edgetx-firmware']).toBeUndefined();

    s.sources.push({ name: 'widget', repo: 'someone/widget', kind: 'project' });
    expect(await ensureSelection(p, s, 'tx16smk3', root, {})).toBe(true);
    expect(s.radios.tx16smk3!.sources!.widget).toEqual({ on: false, origin: 'release' });
    expect(s.radios.tx16smk3!.newSources).toEqual(['widget']);
  });
});

describe('prepareUpdate', () => {
  it('plans a first update of a card from downloaded packages', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', { 'c800x480.zip': { 'WIDGETS/BattAnalog/main.lua': 'b', 'MODELS/README.txt': 'r' } });
    await writeRelease(p, 'edgetx-sounds', 'v2.12.3', '2026-09-01T00:00:00Z', { 'edgetx-sdcard-sounds-en-2.12.3.zip': { 'SOUNDS/en/hello.wav': 'h' } });
    const root = await newCard();
    const card: RadioCard = (await readCard(root))!;
    const s: Settings = defaultSettings();
    s.radios.tx16smk3 = { language: 'en' };
    const setup = await prepareUpdate(p, s, card, 'tx16smk3');
    expect(setup.contents.map((c) => c.name)).toEqual(['edgetx-sdcard', 'edgetx-sounds']);
    expect(setup.plan.map((i) => [i.path, i.action])).toEqual([
      ['MODELS/README.txt', 'add'],
      ['SOUNDS/en/hello.wav', 'add'],
      ['WIDGETS/BattAnalog/main.lua', 'add'],
    ]);
    // Flight Wingman is on for a new radio but not downloaded here, so it changes nothing on the card
    expect(setup.missing).toEqual(['flight-wingman (release)']);
    expect(setup.changes).toEqual([
      { name: 'edgetx-sdcard', to: 'v2.12.3' },
      { name: 'edgetx-sounds', to: 'v2.12.3' },
    ]);

    s.radios.tx16smk3!.sources!['gps-homer'] = { on: true, origin: 'local' };
    const again = await prepareUpdate(p, s, card, 'tx16smk3');
    expect(again.missing).toEqual(['flight-wingman (release)', 'gps-homer (local)']);
  });
});


describe('projects copied by hand', () => {
  it('removes an exact copy when switched off and leaves a changed one alone', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    const s: Settings = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'elrs-lua': { on: false, origin: 'release' } } };

    const exact = (await readCard(await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'lua' })))!;
    const removed = await prepareUpdate(p, s, exact, 'tx16smk3');
    expect(removed.plan.map((i) => [i.path, i.action, i.pkg])).toEqual([['SCRIPTS/TOOLS/elrs.lua', 'delete', 'elrs-lua']]);
    expect(removed.changes).toEqual([{ name: 'elrs-lua', from: '4.1.0' }]);

    const changed = (await readCard(await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'my own' })))!;
    expect((await prepareUpdate(p, s, changed, 'tx16smk3')).plan).toEqual([]);
  });
});

describe('new sources', () => {
  it('finds the SD folder without the changing top folder of a source archive', async () => {
    const { findSdDir } = await import('../src/core/sources.ts');
    expect(findSdDir(['owner-repo-1a2b/README.md', 'owner-repo-1a2b/src/WIDGETS/X/main.lua', 'owner-repo-1a2b/src/SCRIPTS/X/a.lua'])).toBe('src');
    expect(findSdDir(['WIDGETS/X/main.lua', 'README.md'])).toBeUndefined();
    expect(findSdDir(['widget-v2/SD/WIDGETS/X/main.lua'])).toBe('SD');
    expect(findSdDir(['docs/readme.md'])).toBeNull();
  });
});

describe('first update of a card with older SD content', () => {
  async function setup() {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', {
      'c800x480.zip': { 'edgetx.sdcard.version': '2.12.3', 'WIDGETS/Batt/main.lua': 'new', 'WIDGETS/Hist/app.lua': 'new' },
    });
    const old = { 'edgetx.sdcard.version': '2.12.1', 'WIDGETS/Batt/main.lua': 'old', 'WIDGETS/Hist/app.lua': 'old', 'WIDGETS/Gone/main.lua': 'gone' };
    const root = await newCard({ ...old, 'WIDGETS/Hist/app.lua': 'edited by hand' });
    const s = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'edgetx-sdcard': { on: true, origin: 'release' } } };
    return { p, s, root, old };
  }
  const summary = (plan: { path: string; action: string }[]) => plan.map((i) => `${i.action} ${i.path}`);

  it('compares with the version on the card instead of reporting every older file', async () => {
    const { p, s, root, old } = await setup();
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.1', '2026-07-01T00:00:00Z', { 'c800x480.zip': old });
    const setupResult = await prepareUpdate(p, s, (await readCard(root))!, 'tx16smk3', (() => {
      throw new Error('no network needed');
    }) as never);
    expect(summary(setupResult.plan)).toEqual([
      'replace edgetx.sdcard.version',
      'replace WIDGETS/Batt/main.lua',
      'delete WIDGETS/Gone/main.lua',
      'conflict WIDGETS/Hist/app.lua',
    ]);
  });

  it('downloads that version first when it is missing, and stays as before when offline', async () => {
    const { p, s, root, old } = await setup();
    const zip = makeZip(old);
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/tags/v2.12.1')) {
        return Response.json({
          tag_name: 'v2.12.1',
          published_at: '2026-07-01T00:00:00Z',
          html_url: '',
          zipball_url: '',
          assets: [
            { name: 'c800x480.zip', browser_download_url: 'https://dl/c800x480.zip', size: zip.length },
            { name: 'sdcard.json', browser_download_url: 'https://dl/sdcard.json', size: SDCARD_JSON.length },
          ],
        });
      }
      return new Response(url.endsWith('sdcard.json') ? SDCARD_JSON : zip);
    }) as typeof fetch;
    const online = await prepareUpdate(p, s, (await readCard(root))!, 'tx16smk3', fakeFetch);
    expect(online.plan.find((i) => i.path === 'WIDGETS/Batt/main.lua')!.action).toBe('replace');

    const p2 = paths(await tempDir());
    await writeRelease(p2, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', { 'c800x480.zip': { 'WIDGETS/Batt/main.lua': 'new' } });
    const offline = await prepareUpdate(p2, s, (await readCard(root))!, 'tx16smk3', (async () => {
      throw new Error('offline');
    }) as typeof fetch);
    expect(offline.plan.find((i) => i.path === 'WIDGETS/Batt/main.lua')).toMatchObject({ action: 'conflict', reason: 'unknown' });
  });
});
