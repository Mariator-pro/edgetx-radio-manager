import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { versionDir } from '../src/core/packages.ts';
import { paths } from '../src/core/paths.ts';
import { PREFS_META, TOKEN_HEADER, TOKEN_META, type AppUpdateView, type BackupView, type PlanView, type RestorePlanView, type RestoreResultView, type StateView, type UpdateResultView } from '../src/server/api.ts';
import { noteServer, runningServer } from '../src/server/running.ts';
import { oneAtATime, startServer } from '../src/server/server.ts';
import { ApiError, errorText } from '../src/ui/errors.ts';
import { TEXTS } from '../src/ui/texts.ts';
import { makeZip, SDCARD_JSON, tempDir, writeTree } from './helpers.ts';

let url = '';
let token = '';
let close = () => {};
let card = '';
let p = paths('');

// Requests as the page makes them, with the server's key.
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url + path, { ...init, headers: { ...init.headers, [TOKEN_HEADER]: token } });
const get = async <T>(path: string) => (await call(path)).json() as Promise<T>;
const post = async <T>(path: string, body: unknown) =>
  (await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<T>;

beforeAll(async () => {
  p = paths(await tempDir());
  const dir = versionDir(p, 'edgetx-sdcard', 'v2.12.3');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'release.json'), JSON.stringify({ tag: 'v2.12.3', published: '2026-09-01T00:00:00Z', url: '' }));
  await writeFile(join(dir, 'c800x480.zip'), makeZip({ 'WIDGETS/BattAnalog/main.lua': 'b' }));
  await writeFile(join(dir, 'sdcard.json'), SDCARD_JSON);
  card = await tempDir();
  await writeTree(card, { 'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16smk3\nttsLanguage: "en"\n', 'MODELS/m.yml': 'm' });
  process.env.RADIO_MANAGER_VOLUMES = card;
  const s = await startServer({ paths: p, port: 0, repoParent: await tempDir(), pollMs: 60_000 });
  url = s.url;
  token = s.token;
  close = s.close;
});

afterAll(() => {
  close();
  delete process.env.RADIO_MANAGER_VOLUMES;
});

describe('server', () => {
  it('shows the connected radio with its selection', async () => {
    const state = await get<StateView>('/api/state');
    expect(state.radios).toHaveLength(1);
    const r = state.radios[0]!;
    expect(r).toMatchObject({ board: 'tx16smk3', name: 'RadioMaster TX16S MK3', firmware: '2.12.3', belowMin: false, updates: ['edgetx-sdcard'] });
    expect(r.sources.find((x) => x.name === 'edgetx-sdcard')).toMatchObject({ on: true, fixed: true, available: 'v2.12.3' });
    expect(state.appUpdate).toBeUndefined();
  });

  it('plans and runs an update with a backup first', async () => {
    const plan = await post<PlanView>('/api/update/plan', { volume: card });
    expect(plan.counts.add).toBe(1);
    expect(plan.groups.map((g) => g.name)).toEqual(['edgetx-sdcard']);
    const r = await post<UpdateResultView>('/api/update/run', { volume: card, resolutions: {} });
    expect(r).toMatchObject({ written: 1, deleted: 0, kept: 0 });
    expect(r.backup).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}$/);
    const state = await get<StateView>('/api/state');
    expect(state.radios[0]!.updates).toEqual([]);
    expect(state.radios[0]!.lastBackup).toBe(r.backup);
  });

  it('restores the backup from before the update, backing up first and keeping the restored one', async () => {
    const { lastBackup } = (await get<StateView>('/api/state')).radios[0]!;
    const wrong = await call('/api/restore/plan', { method: 'POST', body: JSON.stringify({ volume: card, board: 'tx15', name: lastBackup }) });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe('wrongRadioForBackup');

    const plan = await post<RestorePlanView>('/api/restore/plan', { volume: card, board: 'tx16smk3', name: lastBackup });
    expect(plan.counts).toEqual({ add: 0, replace: 0, delete: 2 });
    expect(plan.files.map((f) => f.path)).toEqual(['.radio-manager/installed.json', 'WIDGETS/BattAnalog/main.lua']);
    expect(plan.backupFirmware).toBe('2.12.3');

    const r = await post<RestoreResultView>('/api/restore/run', { volume: card, board: 'tx16smk3', name: lastBackup, backupFirst: true });
    expect(r).toMatchObject({ written: 0, deleted: 2 });
    expect(r.backup).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}(_\d+)?$/);
    const [backups] = await get<BackupView[]>('/api/backups');
    expect(backups!.items.map((i) => i.name)).toEqual(expect.arrayContaining([lastBackup, r.backup]));
    expect((await get<StateView>('/api/state')).radios[0]!.updates).toEqual(['edgetx-sdcard']);
  });

  it('labels backups with EdgeTX version and reason, and keeps notes until the backup goes', async () => {
    const [b] = await get<BackupView[]>('/api/backups');
    const restoreBackup = b!.items[0]!;
    const updateBackup = b!.items[1]!;
    expect(updateBackup).toMatchObject({ firmware: '2.12.3', reason: 'update', changes: [{ name: 'edgetx-sdcard', to: 'v2.12.3' }] });
    expect(restoreBackup).toMatchObject({ reason: 'restore', restoredFrom: updateBackup.name });

    await post('/api/backups/note', { board: 'tx16smk3', name: updateBackup.name, note: '  before the new SD content ' });
    expect((await get<BackupView[]>('/api/backups'))[0]!.items[1]!.note).toBe('before the new SD content');
    const long = await call('/api/backups/note', { method: 'POST', body: JSON.stringify({ board: 'tx16smk3', name: updateBackup.name, note: 'x'.repeat(201) }) });
    expect(long.status).toBe(400);
    await post('/api/backups/note', { board: 'tx16smk3', name: updateBackup.name, note: '' });
    expect((await get<BackupView[]>('/api/backups'))[0]!.items[1]!.note).toBeUndefined();

    await post('/api/backups/note', { board: 'tx16smk3', name: restoreBackup.name, note: 'gone soon' });
    await post('/api/backups/delete', { board: 'tx16smk3', name: restoreBackup.name });
    const settings = JSON.parse(await readFile(join(p.root, 'settings.json'), 'utf8')) as { backupInfo: Record<string, Record<string, unknown>> };
    expect(Object.keys(settings.backupInfo.tx16smk3!)).toEqual([updateBackup.name]);
  });

  it('sends errors as codes the interface translates', async () => {
    const res = await call('/api/radio/board', { method: 'POST', body: JSON.stringify({ volume: card, board: 'nope' }) });
    const data = (await res.json()) as { error: string; code: string; params: unknown };
    expect(res.status).toBe(400);
    expect(data).toEqual({ error: 'Unknown radio type: nope', code: 'unknownRadioType', params: { board: 'nope' } });
    const e = new ApiError({ message: data.error, code: 'unknownRadioType', params: data.params });
    expect(errorText(TEXTS.de, e)).toBe('Unbekannter Sendertyp: nope');
    expect(errorText(TEXTS.de, new Error('boom'))).toBe('boom');
  });

  it('checks an own firmware file and flashes one without identification only when confirmed', async () => {
    const upload = (name: string, data: Buffer) => call(`/api/firmware/file?board=tx16s&name=${name}`, { method: 'POST', body: data });
    const odd = (await (await upload('odd.bin', Buffer.alloc(2048, 0xff))).json()) as Record<string, unknown>;
    expect(odd).toEqual({ name: 'odd.bin', size: 2048, method: 'dfu' });
    const unconfirmed = await call('/api/firmware/flash', { method: 'POST', body: JSON.stringify({ board: 'tx16s', file: true }) });
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { code: string }).code).toBe('unknownFirmwareFile');
    const wrong = await upload('mk3.bin', Buffer.from('\0edgetx-tx16smk3-v2.12.5 (0ebe2e98)\0'));
    expect(((await wrong.json()) as { code: string }).code).toBe('wrongFirmwareBoard');
    expect(await get('/api/firmware?board=tx16s')).toMatchObject({ prereleases: [], includePrereleases: false });
  });

  it('refuses unknown routes and paths outside its folders', async () => {
    expect((await call('/api/nothing')).status).toBe(404);
    expect((await call('/api/backups/delete', { method: 'POST', body: JSON.stringify({ board: '..', name: 'x' }) })).status).toBe(400);
    const flash = await call('/api/firmware/flash', { method: 'POST', body: JSON.stringify({ board: 'tx16s', tag: '../../Backups/tx16s/x' }) });
    expect(await flash.json()).toMatchObject({ code: 'invalidRequest', params: { what: 'tag' } });
  });

  it('answers only with its key, which it puts into the page', async () => {
    expect((await fetch(`${url}/api/packages`)).status).toBe(403);
    expect((await fetch(`${url}/api/events`)).status).toBe(403);
    expect((await fetch(`${url}/api/backups/delete`, { method: 'POST', headers: { [TOKEN_HEADER]: 'wrong' }, body: '{}' })).status).toBe(403);
    const events = await fetch(`${url}/api/events?token=${token}`);
    expect(events.status).toBe(200);
    await events.body?.cancel();

    const staticDir = await tempDir();
    await writeFile(join(staticDir, 'index.html'), '<html><head><title>x</title></head></html>');
    const other = await startServer({ paths: p, port: 0, staticDir, pollMs: 60_000 });
    try {
      const page = await fetch(`${other.url}/radio`);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(await page.text()).toContain(`<meta name="${TOKEN_META}" content="${other.token}" />`);
      expect(other.token).not.toBe(token);
    } finally {
      other.close();
    }
  });

  it('keeps language and theme and puts them into the page, whatever port it runs on', async () => {
    const staticDir = await tempDir();
    await writeFile(join(staticDir, 'index.html'), '<html><head><title>x</title></head></html>');
    const dataDir = paths(await tempDir());
    const first = await startServer({ paths: dataDir, port: 0, staticDir, pollMs: 60_000 });
    const choose = (prefs: unknown) =>
      fetch(`${first.url}/api/prefs`, { method: 'POST', headers: { [TOKEN_HEADER]: first.token }, body: JSON.stringify(prefs) });
    try {
      expect(await (await fetch(first.url)).text()).toContain(`<meta name="${PREFS_META}" content="{}" />`);
      expect((await choose({ lang: 'de' })).status).toBe(200);
      expect((await choose({ theme: 'dark' })).status).toBe(200);
      expect((await choose({ lang: '../x' })).status).toBe(400);
      expect((await choose({ theme: 'pink' })).status).toBe(400);
    } finally {
      first.close();
    }
    const second = await startServer({ paths: dataDir, port: 0, staticDir, pollMs: 60_000 });
    try {
      expect(await (await fetch(second.url)).text()).toContain(`<meta name="${PREFS_META}" content="{&quot;lang&quot;:&quot;de&quot;,&quot;theme&quot;:&quot;dark&quot;}" />`);
    } finally {
      second.close();
    }
  });

  it('finds the running browser server through its note, and only while it answers', async () => {
    const staticDir = await tempDir();
    await writeFile(join(staticDir, 'index.html'), '<html><head></head></html>');
    const file = join(await tempDir(), 'server.json');
    expect(await runningServer(file)).toBeUndefined();
    const s = await startServer({ paths: paths(await tempDir()), port: 0, staticDir, pollMs: 60_000 });
    const forget = await noteServer(file, s.url);
    expect(await runningServer(file)).toBe(s.url);
    s.close();
    expect(await runningServer(file)).toBeUndefined();
    await forget();
    expect(await readFile(file, 'utf8').catch(() => 'gone')).toBe('gone');
    // a note of a process that is gone counts as no server
    await writeFile(file, JSON.stringify({ url: s.url, pid: 2 ** 22 + 1 }));
    expect(await runningServer(file)).toBeUndefined();
  });
});

describe('app update', () => {
  // a server with app updates as the desktop app gives it; install fails once on request
  const start = async (installable: boolean, fail = false) => {
    let changed = () => {};
    const view: AppUpdateView = { version: '9.0.0', url: 'https://example.com/v9.0.0', installable };
    const s = await startServer({
      paths: paths(await tempDir()),
      port: 0,
      pollMs: 60_000,
      appUpdates: {
        view: () => view,
        onChange: (fn) => (changed = fn),
        install: async (onProgress) => {
          if (fail) throw new Error('net::ERR_INTERNET_DISCONNECTED');
          onProgress(50);
          view.restarting = true;
          changed();
        },
      },
    });
    const ask = (path: string, method = 'GET') => fetch(s.url + path, { method, headers: { [TOKEN_HEADER]: s.token } });
    return { s, ask };
  };

  it('shows a newer release and installs it where the app can', async () => {
    const { s, ask } = await start(true);
    expect(((await (await ask('/api/state')).json()) as StateView).appUpdate).toMatchObject({ version: '9.0.0', installable: true });
    expect((await ask('/api/app-update', 'POST')).status).toBe(200);
    expect(((await (await ask('/api/state')).json()) as StateView).appUpdate?.restarting).toBe(true);
    s.close();
  });

  it('only links to the download where the app cannot install it', async () => {
    const { s, ask } = await start(false);
    const r = await ask('/api/app-update', 'POST');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('invalidRequest');
    s.close();
  });

  it('reports a failed download as a code the interface translates', async () => {
    const { s, ask } = await start(true, true);
    const r = await ask('/api/app-update', 'POST');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('appUpdateFailed');
    expect(((await (await ask('/api/state')).json()) as StateView).busy).toBeUndefined();
    s.close();
  });
});

describe('oneAtATime', () => {
  it('makes up for a forced call that came while one ran, and drops a plain one', async () => {
    const calls: boolean[] = [];
    let release = () => {};
    const call = oneAtATime(async (force) => {
      calls.push(force);
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
    });
    const first = call();
    await call(true);
    await call();
    expect(calls).toEqual([false]);
    release();
    await first;
    expect(calls).toEqual([false, true]);
  });
});
