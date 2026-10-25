import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paths } from '../src/core/paths.ts';
import {
  TOKEN_HEADER,
  type BackupView,
  type DiffGroupView,
  type ImportView,
  type ModelsPlanView,
  type ModelsResultView,
  type ModelsView,
} from '../src/server/api.ts';
import { startServer } from '../src/server/server.ts';
import { tempDir, writeTree } from './helpers.ts';

let url = '';
let token = '';
let close = () => {};
let card = '';

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url + path, { ...init, headers: { ...init.headers, [TOKEN_HEADER]: token } });
const get = async <T>(path: string) => (await call(path)).json() as Promise<T>;
const post = async <T>(path: string, body: unknown) =>
  (await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<T>;

const RADIO = 'semver: 2.12.5\nboard: tx15\nttsLanguage: "en"\ninternalModule: TYPE_CROSSFIRE\nswitchConfig:\n   SA:\n      type: 3POS\n';
const model = (name: string, weight: number, bitmap = '') =>
  `semver: 2.12.5\nheader: \n   name: "${name}"\n   bitmap: "${bitmap}"\n   labels: ""\nmixData: \n -\n   destCh: 0\n   swtch: "SA0"\n   weight: ${weight}\n`;

beforeAll(async () => {
  const p = paths(await tempDir());
  card = await tempDir();
  await writeTree(card, { 'RADIO/radio.yml': RADIO, 'MODELS/model1.yml': model('Copter', 100, 'c.png'), 'IMAGES/c.png': 'png' });
  process.env.RADIO_MANAGER_VOLUMES = card;
  const s = await startServer({ paths: p, port: 0, pollMs: 60_000 });
  url = s.url;
  token = s.token;
  close = s.close;
});

afterAll(() => {
  close();
  delete process.env.RADIO_MANAGER_VOLUMES;
});

describe('models page', () => {
  let backup = '';

  it('lists the models of the backups and compares them with the card', async () => {
    backup = await post<string>('/api/backup', { volume: card });
    await writeTree(card, { 'MODELS/model1.yml': model('Copter', 80), 'MODELS/model2.yml': model('New', 1) });
    const v = await get<ModelsView>(`/api/models?board=tx15&volume=${encodeURIComponent(card)}`);
    expect(v.boards.map((b) => b.board)).toEqual(['tx15']);
    expect(v.entries).toEqual([
      { name: 'Copter', versions: [{ file: 'model1.yml', backup, since: backup, semver: '2.12.5', bitmap: 'c.png', labels: [] }], card: 'changed' },
    ]);
    expect(v.onlyOnCard.map((m) => m.name)).toEqual(['New']);
  });

  it('serves the picture and the export, and refuses unsafe names', async () => {
    const img = await call(`/api/models/image?board=tx15&backup=${backup}&file=c.png`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(await img.text()).toBe('png');
    const exp = await call(`/api/models/export?board=tx15&backup=${backup}&file=model1.yml`);
    expect(exp.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Copter.yml");
    expect(await exp.text()).toContain('weight: 100');
    expect((await call(`/api/models/image?board=tx15&backup=${backup}&file=..%2Fx.png`)).status).toBe(400);
    expect((await call(`/api/models/export?board=..&backup=${backup}&file=model1.yml`)).status).toBe(400);
  });

  it('shows the differences between a version and the card', async () => {
    const d = await post<DiffGroupView[]>('/api/models/diff', { a: { board: 'tx15', backup, file: 'model1.yml' }, volume: card });
    expect(d).toEqual([
      { area: 'setup', entries: [{ path: 'header › bitmap', from: 'c.png', to: '' }] },
      { area: 'mixes', entries: [{ path: 'Mix CH1, line 1 › weight', from: '100', to: '80' }] },
    ]);
  });

  it('plans and copies a version back, after a backup that names the model', async () => {
    const ref = { board: 'tx15', backup, file: 'model1.yml' };
    const plan = await post<ModelsPlanView>('/api/models/plan', { volume: card, copy: [{ ref }] });
    expect(plan.confirm).toBe(false);
    expect(plan.copy[0]).toMatchObject({ name: 'Copter', mode: 'replace', target: 'model1.yml', ref });
    const r = await post<ModelsResultView>('/api/models/run', { volume: card, copy: [{ ref }], backupFirst: true });
    expect(r).toMatchObject({ written: 1, moved: 0 });
    expect(await readFile(join(card, 'MODELS/model1.yml'), 'utf8')).toContain('weight: 100');
    const [b] = await get<BackupView[]>('/api/backups');
    expect(b!.items.find((i) => i.name === r.backup)).toMatchObject({ reason: 'models', models: ['Copter'] });
  });

  it('imports a model file and asks for confirmation when it does not fit', async () => {
    const odd = model('Odd', 5).replace('SA0', 'SG2');
    const imp = (await (await call('/api/models/import?name=Odd.yml', { method: 'POST', body: odd })).json()) as ImportView;
    expect(imp.models.map((m) => m.name)).toEqual(['Odd']);
    const copy = [{ ref: { import: imp.id, file: '' } }];
    const plan = await post<ModelsPlanView>('/api/models/plan', { volume: card, copy });
    expect(plan.confirm).toBe(true);
    expect(plan.copy[0]).toMatchObject({ mode: 'add', target: 'model3.yml', controls: ['SG'] });
    const refused = await call('/api/models/run', { method: 'POST', body: JSON.stringify({ volume: card, copy, backupFirst: false }) });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('modelsDontFit');
    await post('/api/models/run', { volume: card, copy, backupFirst: false, force: true });
    expect(await readdir(join(card, 'MODELS'))).toContain('model3.yml');
    await post('/api/models/import/close', { id: imp.id });
    expect((await call('/api/models/plan', { method: 'POST', body: JSON.stringify({ volume: card, copy }) })).status).toBe(404);
  });

  it('deletes by moving to MODELS/DELETED', async () => {
    const plan = await post<ModelsPlanView>('/api/models/plan', { volume: card, delete: ['model2.yml'] });
    expect(plan.delete).toEqual([{ name: 'New', file: 'model2.yml', moves: ['model2.yml'], active: false }]);
    const r = await post<ModelsResultView>('/api/models/run', { volume: card, delete: ['model2.yml'], backupFirst: false });
    expect(r).toMatchObject({ written: 0, moved: 1 });
    expect(await readdir(join(card, 'MODELS/DELETED'))).toEqual(['model2.yml']);
  });
});
