import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../src/core/apply.ts';
import { readCard, type InstalledList, type RadioCard } from '../src/core/card.ts';
import { isExcluded, localContent, localVersion, releaseContent, sameOnCard, sdPrefix, sha256, voicesChanged, type PackageContent } from '../src/core/content.ts';
import { versionDir } from '../src/core/packages.ts';
import { paths, type Paths } from '../src/core/paths.ts';
import { countActions, makePlan, mergePackages } from '../src/core/plan.ts';
import { ensureSelection, selectionFromCard } from '../src/core/selection.ts';
import { defaultSettings, findLocalRepos, type Settings } from '../src/core/settings.ts';
import { prepareUpdate } from '../src/core/update.ts';
import { checkCard } from '../src/core/initialize.ts';
import { knownVersions, packKnown, setShippedCatalog } from '../src/core/known.ts';
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

// The card as the app has it after reading it: with its list.
async function checked(p: Paths, s: Settings, root: string): Promise<{ card: RadioCard; states: Awaited<ReturnType<typeof checkCard>>['states'] }> {
  const r = await checkCard(p, s, (await readCard(root))!, 'tx16smk3');
  return { card: (await readCard(root))!, states: r.states };
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
    expect(c!.version).toMatch(/^local [0-9a-f]{7,}\*[0-9a-f]{4}$/);

    // every further change is another version; untracked files don't count
    const source = { name: 'gps-homer', repo: 'x/edgetx-gps-homer', kind: 'project' as const, sdDir: 'src', localDir: repo };
    await writeTree(repo, { 'src/SCRIPTS/HOMER/core.lua': 'v3' });
    const v3 = await localVersion(source);
    expect(v3).toMatch(/^local [0-9a-f]{7,}\*[0-9a-f]{4}$/);
    expect(v3).not.toBe(c!.version);
    await writeTree(repo, { 'src/SCRIPTS/HOMER/core.lua': 'v1' });
    expect(await localVersion(source)).toMatch(/^local [0-9a-f]{7,}$/);
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

describe('sound pack voices', () => {
  const card = (voices?: string[], soundLanguages?: string[], listedLangs: string[] = []): RadioCard => ({
    volume: '/x',
    soundLanguages,
    installed: {
      tool: 1,
      updated: '',
      packages: { 'edgetx-sounds': { version: 'v2.12.3', origin: 'release', ...(voices ? { voices } : {}) } },
      files: Object.fromEntries(
        listedLangs.map((l) => [`SOUNDS/${l}/SYSTEM/hello.wav`, { sha256: '', from: ['edgetx-sounds'], written: 'edgetx-sounds' }]),
      ),
    },
  });

  it('sees another language or voice as a change, by the list on the card or else by the language folders', () => {
    expect(voicesChanged(card(['de', 'en']), 'edgetx-sounds', ['en', 'de'])).toBe(false);
    expect(voicesChanged(card(['de', 'en']), 'edgetx-sounds', ['de', 'en', 'fr'])).toBe(true);
    expect(voicesChanged(card(['en']), 'edgetx-sounds', ['en_gb-ryan'])).toBe(true);
    expect(voicesChanged(card(['de', 'en']), 'edgetx-sounds', ['en'])).toBe(true);
    // no voices in the list yet: a language missing on the card, or one the list has from the package but no longer wanted
    expect(voicesChanged(card(undefined, ['en']), 'edgetx-sounds', ['en', 'fr'])).toBe(true);
    expect(voicesChanged(card(undefined, ['de', 'en'], ['de', 'en']), 'edgetx-sounds', ['en'])).toBe(true);
    expect(voicesChanged(card(undefined, ['de', 'en'], ['de', 'en']), 'edgetx-sounds', ['de', 'en'])).toBe(false);
    // "de" copied by hand, not in the list: the update leaves it, so removing it changes nothing
    expect(voicesChanged(card(undefined, ['de', 'en'], ['en']), 'edgetx-sounds', ['en'])).toBe(false);
  });

  it('records which voices went into the sound pack content', async () => {
    const p = paths(await tempDir());
    const dir = versionDir(p, 'edgetx-sounds', 'v2.12.3');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'release.json'), JSON.stringify({ tag: 'v2.12.3', published: '2026-09-01T00:00:00Z', url: '' }));
    await writeFile(join(dir, 'edgetx-sdcard-sounds-en-2.12.3.zip'), makeZip({ 'SOUNDS/en/SYSTEM/hello.wav': 'x' }));
    const src = defaultSettings().sources.find((x) => x.kind === 'sounds')!;
    // "fr" is chosen but not downloaded: it is not in the content, so the list won't claim it either
    expect((await releaseContent(p, src, { voices: ['en', 'fr'] }))!.voices).toEqual(['en']);
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
    await applyPlan(root, { plan, contents });
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('new');
    expect(await readFile(join(root, 'WIDGETS/Mine/main.lua'), 'utf8')).toBe('mine');
    const card = (await readCard(root))!;
    expect(card.installed!.packages).toEqual({ a: { version: 'v1', origin: 'release' } });
    expect(Object.keys(card.installed!.files).sort()).toEqual(['WIDGETS/A/main.lua', 'WIDGETS/A/same.lua']);
  });

  it('changes nothing when a path leads off the card', async () => {
    const root = await newCard({ 'WIDGETS/A/main.lua': 'old' });
    const contents = [pkg('a', 'release', 1, { 'WIDGETS/A/main.lua': 'new' })];
    const plan = await makePlan(root, mergePackages(contents));
    plan.push({ path: '../outside.lua', action: 'delete', pkg: 'a' });
    await expect(applyPlan(root, { plan, contents })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('old');
  });

  it('stops after the current file when cancelled and leaves the list as it was', async () => {
    const root = await newCard();
    const contents = [pkg('a', 'release', 1, { 'WIDGETS/A/one.lua': '1', 'WIDGETS/A/two.lua': '2' })];
    const plan = await makePlan(root, mergePackages(contents));
    const abort = new AbortController();
    await expect(applyPlan(root, { plan, contents }, new Map(), () => abort.abort(), abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(join(root, 'WIDGETS/A'))).toEqual(['one.lua']);
    expect((await readCard(root))!.installed).toBeUndefined();
  });

  it('replaces, deletes what no package delivers any more, drops stale .luac and empty folders', async () => {
    const root = await newCard();
    const v1 = [pkg('a', 'release', 1, { 'SCRIPTS/A/core.lua': 'v1', 'SCRIPTS/A/old/gone.lua': 'g', 'SCRIPTS/TOOLS/T.lua': 't' })];
    await applyPlan(root, { plan: await makePlan(root, mergePackages(v1)), contents: v1 });
    await writeTree(root, { 'SCRIPTS/A/core.luac': 'compiled', 'SCRIPTS/A/old/gone.luac': 'compiled', 'SCRIPTS/TOOLS/Other.lua': 'edgetx' });

    const card = (await readCard(root))!;
    const v2 = [pkg('a', 'release', 2, { 'SCRIPTS/A/core.lua': 'v2', 'SCRIPTS/TOOLS/T.lua': 't' })];
    const plan = await makePlan(root, mergePackages(v2), card.installed);
    expect(plan.filter((i) => i.action !== 'unchanged').map((i) => [i.path, i.action])).toEqual([
      ['SCRIPTS/A/core.lua', 'replace'],
      ['SCRIPTS/A/old/gone.lua', 'delete'],
    ]);
    expect(await applyPlan(root, { plan, contents: v2 })).toEqual({ written: 1, deleted: 1, kept: 0 });
    expect(await readFile(join(root, 'SCRIPTS/A/core.lua'), 'utf8')).toBe('v2');
    const left = await readdir(join(root, 'SCRIPTS'), { recursive: true });
    expect(left).not.toContain(join('A', 'core.luac'));
    expect(left).not.toContain(join('A', 'old'));
    expect(left).toContain(join('TOOLS', 'Other.lua'));
  });

  it('deletes a file only when no package delivers it any more', async () => {
    const root = await newCard();
    const both = [pkg('a', 'release', 1, { 'SCRIPTS/TOOLS/FB.lua': 'fb' }), pkg('b', 'release', 1, { 'SCRIPTS/TOOLS/FB.lua': 'fb' })];
    await applyPlan(root, { plan: await makePlan(root, mergePackages(both)), contents: both });
    const onlyB = [both[1]!];
    const plan = await makePlan(root, mergePackages(onlyB), (await readCard(root))!.installed);
    expect(countActions(plan)).toMatchObject({ delete: 0, unchanged: 1 });
  });

  it('reports conflicts and keeps the card file unless told otherwise', async () => {
    const root = await newCard({ 'WIDGETS/B/main.lua': 'hand-made' });
    const v1 = [pkg('a', 'release', 1, { 'WIDGETS/A/main.lua': 'v1', 'WIDGETS/A/extra.lua': 'e' })];
    await applyPlan(root, { plan: await makePlan(root, mergePackages(v1)), contents: v1 });
    await writeTree(root, { 'WIDGETS/A/main.lua': 'edited', 'WIDGETS/A/extra.lua': 'edited too' });

    const v2 = [pkg('a', 'release', 2, { 'WIDGETS/A/main.lua': 'v2', 'WIDGETS/B/main.lua': 'package' })];
    const plan = await makePlan(root, mergePackages(v2), (await readCard(root))!.installed);
    expect(plan.map((i) => [i.path, i.action, i.reason])).toEqual([
      ['WIDGETS/A/extra.lua', 'conflict', 'removed-modified'],
      ['WIDGETS/A/main.lua', 'conflict', 'modified'],
      ['WIDGETS/B/main.lua', 'conflict', 'unknown'],
    ]);
    const r = await applyPlan(root, { plan, contents: v2 }, new Map([['WIDGETS/B/main.lua', 'apply']]));
    expect(r).toEqual({ written: 1, deleted: 0, kept: 2 });
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('edited');
    expect(await readFile(join(root, 'WIDGETS/B/main.lua'), 'utf8')).toBe('package');

    const again = await makePlan(root, mergePackages(v2), (await readCard(root))!.installed);
    expect(again.filter((i) => i.action === 'conflict').map((i) => i.path)).toEqual(['WIDGETS/A/main.lua']);
  });
});

describe('selection', () => {
  it('takes what goes on a radio from its card: packages with origin, sounds with voices', async () => {
    const p = paths(await tempDir());
    const s = defaultSettings();
    const card = (await readCard(await newCard({ 'SOUNDS/en/SYSTEM/hello.wav': 'h', 'SOUNDS/de/SYSTEM/hallo.wav': 'h' })))!;
    const list = (packages: InstalledList['packages']): InstalledList => ({ tool: 1, updated: '', packages, files: {} });

    expect(await selectionFromCard(p, s, 'tx16smk3', card, list({ 'lipo-nanny': { version: 'local abc1234', origin: 'local' }, 'edgetx-sounds': { version: 'v2.12.3', origin: 'release', voices: ['en_gb-ryan'] } }))).toBe(true);
    const r = s.radios.tx16smk3!;
    expect(r.sources).toMatchObject({
      'edgetx-sdcard': { on: true },
      'edgetx-sounds': { on: true, origin: 'release' },
      'lipo-nanny': { on: true, origin: 'local' },
      'flight-wingman': { on: false },
    });
    expect(r.sources!['edgetx-firmware']).toBeUndefined();
    expect(r.sounds).toEqual(['en_gb-ryan']);
    // a list from before the app noted voices: the language folders
    await selectionFromCard(p, s, 'tx16smk3', card, list({ 'edgetx-sounds': { version: 'v2.12.3', origin: 'release' } }));
    expect(r.sounds).toEqual(['de', 'en']);
    expect(r.sources!['lipo-nanny']!.on).toBe(false);
    // an empty card: SD content, and the sounds of the radio's voice language
    await selectionFromCard(p, s, 'tx16smk3', card, list({}));
    expect(Object.entries(r.sources!).filter(([, c]) => c.on).map(([n]) => n)).toEqual(['edgetx-sdcard', 'edgetx-sounds']);
    expect(r.sounds).toEqual(['en']);
    expect(await selectionFromCard(p, s, 'tx16smk3', card, list({}))).toBe(false);

    // a source added later comes in switched off
    s.sources.push({ name: 'widget', repo: 'someone/widget', kind: 'project' });
    expect(await ensureSelection(p, s, 'tx16smk3')).toBe(true);
    expect(r.sources!.widget).toEqual({ on: false, origin: 'release' });
  });
});

describe('prepareUpdate', () => {
  it('plans a first update of a card from downloaded packages', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', { 'c800x480.zip': { 'WIDGETS/BattAnalog/main.lua': 'b', 'MODELS/README.txt': 'r' } });
    await writeRelease(p, 'edgetx-sounds', 'v2.12.3', '2026-09-01T00:00:00Z', { 'edgetx-sdcard-sounds-en-2.12.3.zip': { 'SOUNDS/en/hello.wav': 'h' } });
    const root = await newCard();
    const s: Settings = defaultSettings();
    s.radios.tx16smk3 = { language: 'en' };
    await expect(prepareUpdate(p, s, (await readCard(root))!, 'tx16smk3')).rejects.toThrow('still reading the SD card');
    const { card } = await checked(p, s, root);
    await selectionFromCard(p, s, 'tx16smk3', card, card.installed!);
    const setup = await prepareUpdate(p, s, card, 'tx16smk3');
    expect(setup.contents.map((c) => c.name)).toEqual(['edgetx-sdcard', 'edgetx-sounds']);
    expect(setup.plan.map((i) => [i.path, i.action])).toEqual([
      ['MODELS/README.txt', 'add'],
      ['SOUNDS/en/hello.wav', 'add'],
      ['WIDGETS/BattAnalog/main.lua', 'add'],
    ]);
    expect(setup.missing).toEqual([]);
    expect(setup.changes).toEqual([
      { name: 'edgetx-sdcard', to: 'v2.12.3' },
      { name: 'edgetx-sounds', to: 'v2.12.3' },
    ]);

    s.radios.tx16smk3!.sources!['gps-homer'] = { on: true, origin: 'local' };
    const again = await prepareUpdate(p, s, card, 'tx16smk3');
    expect(again.missing).toEqual(['gps-homer (local)']);
  });

  it('leaves a package that is on but not available as it is on the card and in the list', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', { 'c800x480.zip': { 'WIDGETS/BattAnalog/main.lua': 'b' } });
    const elrs = { sha256: sha256(Buffer.from('lua')), from: ['elrs-lua'], written: 'elrs-lua' };
    const list = { tool: 1, updated: '2026-10-01T00:00:00Z', packages: { 'elrs-lua': { version: '4.1.0', origin: 'release' } }, files: { 'SCRIPTS/TOOLS/elrs.lua': elrs } };
    const root = await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'lua', '.radio-manager/installed.json': JSON.stringify(list) });
    const s: Settings = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'edgetx-sdcard': { on: true, origin: 'release' }, 'elrs-lua': { on: true, origin: 'release' } } };
    const setup = await prepareUpdate(p, s, (await readCard(root))!, 'tx16smk3');
    expect(setup.missing).toContain('elrs-lua (release)');
    expect(setup.plan.map((i) => [i.path, i.action])).toEqual([['WIDGETS/BattAnalog/main.lua', 'add']]);
    await applyPlan(root, setup);
    expect(await readFile(join(root, 'SCRIPTS/TOOLS/elrs.lua'), 'utf8')).toBe('lua');
    const after = (await readCard(root))!.installed!;
    expect(after.packages['elrs-lua']).toEqual(list.packages['elrs-lua']);
    expect(after.files['SCRIPTS/TOOLS/elrs.lua']).toEqual(elrs);
  });
});


describe('projects copied by hand', () => {
  it('removes an exact copy when switched off and asks about a changed one', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    const s: Settings = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'elrs-lua': { on: false, origin: 'release' } } };

    const exact = (await checked(p, s, await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'lua' }))).card;
    const removed = await prepareUpdate(p, s, exact, 'tx16smk3');
    expect(removed.plan.map((i) => [i.path, i.action, i.pkg])).toEqual([['SCRIPTS/TOOLS/elrs.lua', 'delete', 'elrs-lua']]);
    expect(removed.changes).toEqual([{ name: 'elrs-lua', from: '4.1.0' }]);

    const changed = (await checked(p, s, await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'my own' }))).card;
    expect((await prepareUpdate(p, s, changed, 'tx16smk3')).plan).toMatchObject([{ path: 'SCRIPTS/TOOLS/elrs.lua', action: 'conflict', reason: 'removed-modified' }]);
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

  it('adds only a source as the check makes it', async () => {
    const { addSource } = await import('../src/core/sources.ts');
    const s = defaultSettings();
    for (const bad of [
      { name: '..', repo: 'owner/..' },
      { name: 'other', repo: 'owner/repo' },
      { name: 'repo', repo: 'no-slash/../repo' },
      { name: 'repo', repo: 'owner/repo', sdDir: '../src' },
    ]) {
      expect(() => addSource(s, { ...bad, kind: 'project' })).toThrow('The request isn’t valid: source');
    }
    addSource(s, { name: 'repo', repo: 'owner/repo', kind: 'project', sdDir: 'a/src' });
    expect(s.sources.at(-1)).toMatchObject({ name: 'repo', sdDir: 'a/src' });
  });

  it('takes a pasted GitHub address as the repo', async () => {
    const { repoName } = await import('../src/core/sources.ts');
    for (const input of [
      'owner/my.repo',
      ' https://github.com/owner/my.repo ',
      'https://www.github.com/owner/my.repo/',
      'github.com/owner/my.repo/releases/tag/v1.0',
      'https://github.com/owner/my.repo.git',
      'https://github.com/owner/my.repo?tab=readme',
      'git@github.com:owner/my.repo.git',
    ]) {
      expect(repoName(input)).toBe('owner/my.repo');
    }
    expect(repoName('https://gitlab.com/owner/repo')).toBe('https://gitlab.com/owner/repo');
  });

  it('tells a repo without a release from one GitHub does not show', async () => {
    const { checkSource } = await import('../src/core/sources.ts');
    const p = paths(await tempDir());
    const github = (repos: string[]) =>
      (async (input: string | URL | Request) => {
        const repo = String(input).match(/\/repos\/([^/]+\/[^/]+)$/)?.[1];
        return repo && repos.includes(repo) ? Response.json({ full_name: repo }) : new Response('', { status: 404 });
      }) as typeof fetch;
    await expect(checkSource(p, defaultSettings(), 'owner/empty', github(['owner/empty']))).rejects.toThrow('owner/empty has no release');
    await expect(checkSource(p, defaultSettings(), 'owner/typo', github([]))).rejects.toThrow('Can’t find owner/typo on GitHub');
  });
});

describe('first update of a card with older SD content', () => {
  it('compares with the version the card holds instead of reporting every older file', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.3', '2026-09-01T00:00:00Z', {
      'c800x480.zip': { 'edgetx.sdcard.version': '2.12.3', 'WIDGETS/Batt/main.lua': 'new', 'WIDGETS/Hist/app.lua': 'new' },
    });
    const old = { 'edgetx.sdcard.version': '2.12.1', 'WIDGETS/Batt/main.lua': 'old', 'WIDGETS/Hist/app.lua': 'old', 'WIDGETS/Gone/main.lua': 'gone' };
    await writeRelease(p, 'edgetx-sdcard', 'v2.12.1', '2026-07-01T00:00:00Z', { 'c800x480.zip': old });
    const s = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'edgetx-sdcard': { on: true, origin: 'release' } } };
    const { card, states } = await checked(p, s, await newCard({ ...old, 'WIDGETS/Hist/app.lua': 'edited by hand' }));
    expect(card.installed!.packages['edgetx-sdcard']).toEqual({ version: 'v2.12.1', origin: 'release' });
    expect(states.find((x) => x.name === 'edgetx-sdcard')).toEqual({ name: 'edgetx-sdcard', missing: [], changed: ['WIDGETS/Hist/app.lua'] });
    const setup = await prepareUpdate(p, s, card, 'tx16smk3');
    expect(setup.plan.filter((i) => i.action !== 'unchanged').map((i) => `${i.action} ${i.path}`)).toEqual([
      'replace edgetx.sdcard.version',
      'replace WIDGETS/Batt/main.lua',
      'delete WIDGETS/Gone/main.lua',
      'conflict WIDGETS/Hist/app.lua',
    ]);
  });
});

describe('reading the SD card', () => {
  it('finds the version of a project copied by hand, and what differs', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'lipo-nanny', 'v1.0.0', '2026-08-01T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'old', 'src/WIDGETS/LIPONY/ui.lua': 'ui' } });
    await writeRelease(p, 'lipo-nanny', 'v1.1.0', '2026-09-01T00:00:00Z', { 'l.zip': { 'src/WIDGETS/LIPONY/main.lua': 'new', 'src/WIDGETS/LIPONY/ui.lua': 'ui' } });
    const s = defaultSettings();
    const nanny = (r: { card: RadioCard; states: { name: string }[] }) => [r.card.installed?.packages['lipo-nanny']?.version, r.states.find((x) => x.name === 'lipo-nanny')];

    expect(nanny(await checked(p, s, await newCard({ 'WIDGETS/LIPONY/main.lua': 'old', 'WIDGETS/LIPONY/ui.lua': 'ui' })))).toEqual([
      'v1.0.0',
      { name: 'lipo-nanny', missing: [], changed: [] },
    ]);
    // both fit equally well: the newer one, with the changed file
    expect(nanny(await checked(p, s, await newCard({ 'WIDGETS/LIPONY/main.lua': 'mine', 'WIDGETS/LIPONY/ui.lua': 'ui' })))).toEqual([
      'v1.1.0',
      { name: 'lipo-nanny', missing: [], changed: ['WIDGETS/LIPONY/main.lua'] },
    ]);
    // half of its files or fewer: not on the card
    expect(nanny(await checked(p, s, await newCard({ 'WIDGETS/LIPONY/ui.lua': 'ui' })))).toEqual([undefined, undefined]);
  });

  it('finds version and voice of the sounds, an exact older version before a newer one with one more file', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'edgetx-sounds', 'v2.12.0', '2026-03-01T00:00:00Z', {
      'edgetx-sdcard-sounds-en-2.12.0.zip': { 'SOUNDS/en/SYSTEM/hello.wav': 'h', 'SOUNDS/en/one.wav': '1' },
    });
    await writeRelease(p, 'edgetx-sounds', 'v2.12.3', '2026-09-01T00:00:00Z', {
      'edgetx-sdcard-sounds-en-2.12.3.zip': { 'SOUNDS/en/SYSTEM/hello.wav': 'h', 'SOUNDS/en/one.wav': '1', 'SOUNDS/en/two.wav': '2' },
      'edgetx-sdcard-sounds-en_gb-ryan-2.12.3.zip': { 'SOUNDS/en/SYSTEM/hello.wav': 'ryan h', 'SOUNDS/en/one.wav': 'ryan 1', 'SOUNDS/en/two.wav': 'ryan 2' },
    });
    const s = defaultSettings();
    const sounds = async (files: Record<string, string>) => {
      const r = await checked(p, s, await newCard(files));
      return [r.card.installed?.packages['edgetx-sounds'], r.states.find((x) => x.name === 'edgetx-sounds')];
    };
    expect(await sounds({ 'SOUNDS/en/SYSTEM/hello.wav': 'h', 'SOUNDS/en/one.wav': '1' })).toEqual([
      { version: 'v2.12.0', origin: 'release', voices: ['en'] },
      { name: 'edgetx-sounds', missing: [], changed: [] },
    ]);
    expect(
      await sounds({ 'SOUNDS/en/SYSTEM/hello.wav': 'my own', 'SOUNDS/en/one.wav': 'ryan 1', 'SOUNDS/en/two.wav': 'ryan 2', 'SOUNDS/en/mine.wav': 'm' }),
    ).toEqual([
      { version: 'v2.12.3', origin: 'release', voices: ['en_gb-ryan'] },
      { name: 'edgetx-sounds', missing: [], changed: ['SOUNDS/en/SYSTEM/hello.wav'] },
    ]);
  });

  it('checks a listed card by size and change time, and writes only what changed', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    const s = defaultSettings();
    s.radios.tx16smk3 = { language: 'en', sources: { 'elrs-lua': { on: true, origin: 'release' } } };
    // a list as older versions of the app wrote it: no size, no last check
    const list = { tool: 1, updated: '2026-10-01T00:00:00Z', packages: { 'elrs-lua': { version: '4.1.0', origin: 'release' } }, files: { 'SCRIPTS/TOOLS/elrs.lua': { sha256: sha256(Buffer.from('lua')), from: ['elrs-lua'], written: 'elrs-lua' } } };
    const root = await newCard({ 'SCRIPTS/TOOLS/elrs.lua': 'lua', '.radio-manager/installed.json': JSON.stringify(list) });

    const first = await checkCard(p, s, (await readCard(root))!, 'tx16smk3');
    expect(first.written).toBe(true);
    expect((await readCard(root))!.installed!.files['SCRIPTS/TOOLS/elrs.lua']!.seen).toMatchObject({ size: 3, same: true });
    expect((await checkCard(p, s, (await readCard(root))!, 'tx16smk3')).written).toBe(false);

    await writeFile(join(root, 'SCRIPTS/TOOLS/elrs.lua'), 'mine');
    expect((await checkCard(p, s, (await readCard(root))!, 'tx16smk3')).states).toContainEqual({ name: 'elrs-lua', missing: [], changed: ['SCRIPTS/TOOLS/elrs.lua'] });
    await rm(join(root, 'SCRIPTS/TOOLS/elrs.lua'));
    expect((await checkCard(p, s, (await readCard(root))!, 'tx16smk3')).states).toContainEqual({ name: 'elrs-lua', missing: ['SCRIPTS/TOOLS/elrs.lua'], changed: [] });

    // after an SD update the list knows the card's files, so the next check reads nothing new
    const { card } = await checked(p, s, root);
    await applyPlan(root, await prepareUpdate(p, s, card, 'tx16smk3'));
    expect((await checkCard(p, s, (await readCard(root))!, 'tx16smk3')).written).toBe(false);
  });

  it('keeps the checksums of a downloaded version after its package is deleted, next to the shipped ones', async () => {
    const p = paths(await tempDir());
    await writeRelease(p, 'elrs-lua', '4.1.0', '2026-10-01T00:00:00Z', {});
    await writeFile(join(versionDir(p, 'elrs-lua', '4.1.0'), 'elrs.lua'), 'lua');
    const elrs = src('elrs-lua');
    expect((await knownVersions(p, elrs)).map((v) => v.tag)).toEqual(['4.1.0']);
    await rm(versionDir(p, 'elrs-lua', '4.1.0'), { recursive: true });
    const shipped = { tag: '4.0.0', published: '2026-06-01T00:00:00Z', variants: new Map([['', new Map([['SCRIPTS/TOOLS/elrs.lua', { sha: sha256(Buffer.from('old')), size: 3 }]])]]) };
    setShippedCatalog({ 'elrs-lua': packKnown([shipped]) });
    try {
      expect((await knownVersions(p, elrs)).map((v) => v.tag)).toEqual(['4.1.0', '4.0.0']);
    } finally {
      setShippedCatalog({});
    }
  });
});
