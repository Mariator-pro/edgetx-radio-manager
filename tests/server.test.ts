import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { versionDir } from '../src/core/packages.ts';
import { paths } from '../src/core/paths.ts';
import { PREFS_META, TOKEN_HEADER, TOKEN_META, type AppUpdateView, type BackupView, type LicensesView, type PlanView, type RestorePlanView, type RestoreResultView, type StateView, type UpdateResultView } from '../src/server/api.ts';
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

// The state once the app has read the connected cards.
async function ready(): Promise<StateView> {
  for (let i = 0; i < 300; i++) {
    const state = await get<StateView>('/api/state');
    if (state.radios.every((r) => !r.checking)) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('still reading the card');
}

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
  const s = await startServer({ paths: p, port: 0, repoParent: await tempDir(), licensesFile: join(p.root, 'THIRD_PARTY_LICENSES.txt'), pollMs: 60_000 });
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
    const state = await ready();
    expect(state.radios).toHaveLength(1);
    const r = state.radios[0]!;
    expect(r).toMatchObject({ board: 'tx16smk3', name: 'RadioMaster TX16S MK3', firmware: '2.12.3', belowMin: false, updates: ['edgetx-sdcard'] });
    expect(r.sources.find((x) => x.name === 'edgetx-sdcard')).toMatchObject({ on: true, fixed: true, available: 'v2.12.3' });
    expect(state.appUpdate).toBeUndefined();
  });

  it('sends the open source licenses from the build, or says they are missing', async () => {
    expect(await get('/api/licenses')).toMatchObject({ code: 'licensesMissing' });
    await writeFile(join(p.root, 'THIRD_PARTY_LICENSES.txt'), 'THIRD-PARTY SOFTWARE NOTICES\n');
    expect(await get<LicensesView>('/api/licenses')).toEqual({ text: 'THIRD-PARTY SOFTWARE NOTICES\n' });
  });

  it('plans and runs an update with a backup first', async () => {
    await ready();
    const plan = await post<PlanView>('/api/update/plan', { volume: card });
    expect(plan.counts.add).toBe(1);
    expect(plan.groups.map((g) => g.name)).toEqual(['edgetx-sdcard']);
    const r = await post<UpdateResultView>('/api/update/run', { volume: card, resolutions: {} });
    expect(r).toMatchObject({ written: 1, deleted: 0, kept: 0 });
    expect(r.backup).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}$/);
    const state = await ready();
    expect(state.radios[0]!.updates).toEqual([]);
    expect(state.radios[0]!.lastBackup).toBe(r.backup);
  });

  it('restores the backup from before the update, backing up first and keeping the restored one', async () => {
    const { lastBackup } = (await ready()).radios[0]!;
    const wrong = await call('/api/restore/plan', { method: 'POST', body: JSON.stringify({ volume: card, board: 'tx15', name: lastBackup }) });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe('wrongRadioForBackup');

    const plan = await post<RestorePlanView>('/api/restore/plan', { volume: card, board: 'tx16smk3', name: lastBackup });
    // the card got its list when the app first read it, before the update
    expect(plan.counts).toEqual({ add: 0, replace: 1, delete: 1 });
    expect(plan.files.map((f) => f.path)).toEqual(['.radio-manager/installed.json', 'WIDGETS/BattAnalog/main.lua']);
    expect(plan.backupFirmware).toBe('2.12.3');

    const r = await post<RestoreResultView>('/api/restore/run', { volume: card, board: 'tx16smk3', name: lastBackup, backupFirst: true });
    expect(r).toMatchObject({ written: 1, deleted: 1 });
    expect(r.backup).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}(_\d+)?$/);
    const [backups] = await get<BackupView[]>('/api/backups');
    expect(backups!.items.map((i) => i.name)).toEqual(expect.arrayContaining([lastBackup, r.backup]));
    expect((await ready()).radios[0]!.updates).toEqual(['edgetx-sdcard']);
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

  it('turns away requests too large, not JSON or with a board every object has as a name', async () => {
    const post = (path: string, body: string) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    // node:http, as fetch keeps sending a body the server no longer reads
    const large = await new Promise<number>((resolve, reject) => {
      const port = new URL(url).port;
      const req = request({ host: '127.0.0.1', port, path: '/api/backups/keep', method: 'POST', headers: { host: `localhost:${port}`, [TOKEN_HEADER]: token } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(Buffer.alloc(2 * 1024 * 1024, 120));
    });
    expect(large).toBe(413);
    expect((await post('/api/backups/keep', '{not json')).status).toBe(400);
    for (const board of ['__proto__', 'constructor']) {
      expect((await post('/api/radio/sounds', JSON.stringify({ board, sounds: ['en'] }))).status).toBe(400);
      expect((await post('/api/backups/keep', JSON.stringify({ board, name: '2026-10-01_1200', keep: true }))).status).toBe(400);
      expect((await post('/api/backups/delete', JSON.stringify({ board, name: '2026-10-01_1200' }))).status).toBe(400);
    }
    expect(({} as Record<string, unknown>).sounds).toBeUndefined();
  });

  it('answers only with its key, which comes behind # in the address and not in the page', async () => {
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
      const html = await page.text();
      expect(html).not.toContain(other.token);
      expect(html).not.toContain(TOKEN_META);
      expect(other.open).toBe(`${other.url}/#token=${other.token}`);
      // under Vite in development the key is put into the page
      expect(other.page('<head></head>')).toContain(`<meta name="${TOKEN_META}" content="${other.token}" />`);
      expect(other.token).not.toBe(token);
      // no other site may show the page in a frame, and it loads only its own files
      for (const res of [page, await fetch(`${other.url}/api/packages`, { headers: { [TOKEN_HEADER]: other.token } })]) {
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(res.headers.get('content-security-policy')).toContain("script-src 'self';");
      }
    } finally {
      other.close();
    }
  });

  it('answers only under its own name, so another site pointed at this computer cannot read the key', async () => {
    const staticDir = await tempDir();
    await writeFile(join(staticDir, 'index.html'), '<html><head><title>x</title></head></html>');
    const other = await startServer({ paths: p, port: 0, staticDir, pollMs: 60_000 });
    try {
      const port = new URL(other.url).port;
      // fetch keeps the Host header to itself, node:http sends the one given
      const get = (path: string, host: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, path, headers: { host, [TOKEN_HEADER]: other.token } }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on('error', reject);
          req.end();
        });
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost:5173']) {
        expect((await get('/', host)).status).toBe(200);
        expect((await get('/api/packages', host)).status).toBe(200);
      }
      for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, 'evil.example']) {
        const page = await get('/', host);
        expect(page.status).toBe(403);
        expect(page.body).not.toContain(other.token);
        expect((await get('/api/packages', host)).status).toBe(403);
      }
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
    const forget = await noteServer(file, s.open);
    expect(await runningServer(file)).toBe(s.open);
    // the address carries the key: only this user may read the note
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
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

describe('two radios of the same type', () => {
  it('marks backups of the connected SD card, names it, and asks before restoring one of another card', async () => {
    const q = paths(await tempDir());
    const radio = await tempDir();
    await writeTree(radio, { 'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16smk3\nttsLanguage: "en"\n', 'MODELS/m.yml': 'm' });
    // a backup from before cards had an id
    await writeTree(join(q.backups, 'tx16smk3', '2026-10-01_1200'), { 'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16smk3\n', 'MODELS/m.yml': 'm' });
    const before = process.env.RADIO_MANAGER_VOLUMES;
    process.env.RADIO_MANAGER_VOLUMES = [before, radio].filter(Boolean).join(delimiter); // the other test card stays connected
    const srv = await startServer({ paths: q, port: 0, repoParent: await tempDir(), licensesFile: join(q.root, 'none.txt'), pollMs: 60_000 });
    const req = (path: string, body?: unknown) =>
      fetch(srv.url + path, { method: body ? 'POST' : 'GET', headers: { [TOKEN_HEADER]: srv.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const mine = async () => ((await (await req('/api/state')).json()) as StateView).radios.find((r) => r.volume === radio);
      for (let i = 0; i < 300 && (await mine())?.checking !== false; i++) await new Promise((r) => setTimeout(r, 10));
      const made = (await (await req('/api/backup', { volume: radio })).json()) as string;
      const group = ((await (await req('/api/backups')).json()) as BackupView[]).find((g) => g.board === 'tx16smk3');
      expect(group!.items.find((i) => i.name === made)).toMatchObject({ thisCard: true, card: expect.stringMatching(/^tx16smk3 · [\w-]{4}$/) }); // two cards of this type known: with the start of the id
      expect(group!.items.find((i) => i.name === '2026-10-01_1200')).not.toHaveProperty('card');

      expect((await req('/api/radio/name', { volume: radio, name: 'Mk3 Wing' })).status).toBe(200);
      expect(await mine()).toMatchObject({ label: 'Mk3 Wing', cardName: 'Mk3 Wing' });

      // the backup as if from the other radio of this type
      await writeFile(join(q.backups, 'tx16smk3', made, '.radio-manager', 'radio.json'), '{"id":"another-card-1"}');
      const plan = async (name: string) => ((await (await req('/api/restore/plan', { volume: radio, board: 'tx16smk3', name })).json()) as RestorePlanView).origin;
      expect(await plan(made)).toBe('other');
      expect(await plan('2026-10-01_1200')).toBe('unknown');
      const refused = await req('/api/restore/run', { volume: radio, board: 'tx16smk3', name: made, backupFirst: false });
      expect(((await refused.json()) as { code: string }).code).toBe('backupFromOtherCard');
      expect((await req('/api/restore/run', { volume: radio, board: 'tx16smk3', name: made, backupFirst: false, otherCard: true })).status).toBe(200);
      expect(JSON.parse(await readFile(join(radio, '.radio-manager', 'radio.json'), 'utf8'))).toMatchObject({ name: 'Mk3 Wing' });
    } finally {
      srv.close();
      process.env.RADIO_MANAGER_VOLUMES = before;
    }
  });
});
