import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { versionDir } from '../src/core/packages.ts';
import { paths } from '../src/core/paths.ts';
import type { BackupView, PlanView, RestorePlanView, RestoreResultView, StateView, UpdateResultView } from '../src/server/api.ts';
import { startServer } from '../src/server/server.ts';
import { ApiError, errorText } from '../src/ui/api.ts';
import { TEXTS } from '../src/ui/texts.ts';
import { makeZip, SDCARD_JSON, tempDir, writeTree } from './helpers.ts';

let url = '';
let close = () => {};
let card = '';

const get = async <T>(path: string) => (await fetch(url + path)).json() as Promise<T>;
const post = async <T>(path: string, body: unknown) =>
  (await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<T>;

beforeAll(async () => {
  const p = paths(await tempDir());
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
    const wrong = await fetch(`${url}/api/restore/plan`, { method: 'POST', body: JSON.stringify({ volume: card, board: 'tx15', name: lastBackup }) });
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

  it('sends errors as codes the interface translates', async () => {
    const res = await fetch(`${url}/api/radio/board`, { method: 'POST', body: JSON.stringify({ volume: card, board: 'nope' }) });
    const data = (await res.json()) as { error: string; code: string; params: unknown };
    expect(res.status).toBe(400);
    expect(data).toEqual({ error: 'Unknown radio type: nope', code: 'unknownRadioType', params: { board: 'nope' } });
    const e = new ApiError({ message: data.error, code: 'unknownRadioType', params: data.params });
    expect(errorText(TEXTS.de, e)).toBe('Unbekannter Sendertyp: nope');
    expect(errorText(TEXTS.de, new Error('boom'))).toBe('boom');
  });

  it('refuses unknown routes and paths outside its folders', async () => {
    expect((await fetch(`${url}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${url}/api/backups/delete`, { method: 'POST', body: JSON.stringify({ board: '..', name: 'x' }) })).status).toBe(400);
  });
});
