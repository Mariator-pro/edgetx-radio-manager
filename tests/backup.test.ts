import { mkdir, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupCard, backupName, listBackups, pruneBackups } from '../src/core/backup.ts';
import { paths } from '../src/core/paths.ts';
import { tempDir, writeTree } from './helpers.ts';

const when = new Date(2026, 9, 21, 14, 30);

describe('backupCard', () => {
  it('copies the whole card without OS housekeeping files', async () => {
    const card = await tempDir();
    const p = paths(await tempDir());
    await writeTree(card, {
      'RADIO/radio.yml': 'board: tx16smk3\n',
      'MODELS/model00.yml': 'header: {}\n',
      'SCRIPTS/GPSHOMER/flights.lua': 'return {}\n',
      '.radio-manager/installed.json': '{}',
      '.Spotlight-V100/store.db': 'x',
      '.fseventsd/log': 'x',
      'SCRIPTS/._core.lua': 'x',
      'System Volume Information/x': 'x',
    });
    const old = new Date(2026, 0, 2, 3, 4, 5);
    await utimes(join(card, 'MODELS/model00.yml'), old, old);

    const r = await backupCard(card, 'tx16smk3', p, when);
    expect(r.name).toBe('2026-10-21_1430');
    expect(r.files).toBe(4);
    const copied = (await readdir(r.dir, { recursive: true })).sort();
    expect(copied).toContain(join('.radio-manager', 'installed.json'));
    expect(copied).toContain(join('SCRIPTS', 'GPSHOMER', 'flights.lua'));
    expect(copied.some((f) => f.includes('Spotlight') || f.includes('fseventsd') || f.includes('._') || f.includes('System Volume'))).toBe(false);
    expect(await readFile(join(r.dir, 'MODELS/model00.yml'), 'utf8')).toBe('header: {}\n');
    expect((await stat(join(r.dir, 'MODELS/model00.yml'))).mtime.getTime()).toBe(old.getTime());
  });

  it('never overwrites a backup from the same minute', async () => {
    const card = await tempDir();
    const p = paths(await tempDir());
    await writeTree(card, { 'RADIO/a': '1', 'MODELS/b': '2' });
    const a = await backupCard(card, 'tx15', p, when);
    const b = await backupCard(card, 'tx15', p, when);
    expect([a.name, b.name]).toEqual(['2026-10-21_1430', '2026-10-21_1430_2']);
  });
});

describe('pruneBackups', () => {
  async function setup(names: string[]) {
    const p = paths(await tempDir());
    for (const n of names) await mkdir(join(p.backups, 'tx16s', n), { recursive: true });
    await mkdir(join(p.backups, 'tx16s', 'my notes'), { recursive: true });
    return p;
  }

  it('keeps the newest N and leaves foreign folders alone', async () => {
    const p = await setup(['2026-10-01_1000', '2026-10-02_1000', '2026-10-03_1000', '2026-10-03_1000_2']);
    expect(await pruneBackups(p, 'tx16s', 2)).toEqual(['2026-10-02_1000', '2026-10-01_1000']);
    expect(await listBackups(p, 'tx16s')).toEqual(['2026-10-03_1000_2', '2026-10-03_1000']);
    expect(await readdir(join(p.backups, 'tx16s'))).toContain('my notes');
  });

  it('never deletes kept backups and does not count them', async () => {
    const p = await setup(['2026-10-01_1000', '2026-10-02_1000', '2026-10-03_1000']);
    expect(await pruneBackups(p, 'tx16s', 1, ['2026-10-01_1000'])).toEqual(['2026-10-02_1000']);
    expect(await listBackups(p, 'tx16s')).toEqual(['2026-10-03_1000', '2026-10-01_1000']);
  });

  it('formats names as date and time', () => {
    expect(backupName(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05_0703');
  });
});
