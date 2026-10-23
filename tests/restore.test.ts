import { readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupCard } from '../src/core/backup.ts';
import { paths } from '../src/core/paths.ts';
import { applyRestore, planRestore } from '../src/core/restore.ts';
import { tempDir, writeTree } from './helpers.ts';

const when = new Date(2026, 9, 21, 14, 30);

// A card, backed up, then changed: one file edited, one deleted, new ones added.
async function setup() {
  const card = await tempDir();
  const p = paths(await tempDir());
  await writeTree(card, {
    'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16s\n',
    'MODELS/model00.yml': 'name: old\n',
    'MODELS/model01.yml': 'name: gone\n',
    'SCRIPTS/TOOLS/tool.lua': 'return 1\n',
  });
  const b = await backupCard(card, 'tx16s', p, when);
  await writeTree(card, {
    'RADIO/radio.yml': 'semver: 2.12.5\nboard: tx16s\n',
    'MODELS/model00.yml': 'name: newer one\n',
    'WIDGETS/New/main.lua': 'return {}\n',
    'WIDGETS/New/img/a.png': 'x',
    'NEW.txt': 'x',
    '.Spotlight-V100/store.db': 'x',
  });
  await rm(join(card, 'MODELS/model01.yml'));
  return { card, p, name: b.name };
}

describe('planRestore', () => {
  it('lists what goes back, what is replaced and what is deleted', async () => {
    const { card, p, name } = await setup();
    const plan = await planRestore(card, p, 'tx16s', name);
    const by = (a: string) => plan.items.filter((i) => i.action === a).map((i) => i.path);
    expect(by('add')).toEqual(['MODELS/model01.yml']);
    expect(by('replace')).toEqual(['MODELS/model00.yml', 'RADIO/radio.yml']);
    expect(by('delete')).toEqual(['NEW.txt', 'WIDGETS/New/img/a.png', 'WIDGETS/New/main.lua']);
    expect(plan.unchanged).toBe(1);
    expect(plan.firmware).toBe('2.12.3');
  });

  it('compares small files by content when size and time match', async () => {
    const { card, p, name } = await setup();
    const t = (await stat(join(p.backups, 'tx16s', name, 'SCRIPTS/TOOLS/tool.lua'))).mtime;
    await writeTree(card, { 'SCRIPTS/TOOLS/tool.lua': 'return 2\n' });
    await utimes(join(card, 'SCRIPTS/TOOLS/tool.lua'), t, t);
    const plan = await planRestore(card, p, 'tx16s', name);
    expect(plan.items).toContainEqual({ path: 'SCRIPTS/TOOLS/tool.lua', action: 'replace' });
  });

  it('refuses names that are no backup', async () => {
    const { card, p } = await setup();
    await expect(planRestore(card, p, 'tx16s', '../x')).rejects.toMatchObject({ code: 'invalidRequest' });
    await expect(planRestore(card, p, 'tx16s', '2020-01-01_0000')).rejects.toMatchObject({ code: 'backupNotFound' });
  });
});

describe('applyRestore', () => {
  it('brings the card back to exactly the backup', async () => {
    const { card, p, name } = await setup();
    const r = await applyRestore(card, await planRestore(card, p, 'tx16s', name));
    expect(r).toEqual({ written: 3, deleted: 3 });
    const files = (await readdir(card, { recursive: true })).sort();
    expect(files).not.toContain('NEW.txt');
    expect(files).not.toContain(join('WIDGETS', 'New'));
    expect(files).toContain('WIDGETS'); // top-level folders stay
    expect(files).toContain(join('.Spotlight-V100', 'store.db')); // system folders are left alone
    expect(await readFile(join(card, 'MODELS/model00.yml'), 'utf8')).toBe('name: old\n');
    expect(await readFile(join(card, 'MODELS/model01.yml'), 'utf8')).toBe('name: gone\n');
    const backed = await stat(join(p.backups, 'tx16s', name, 'MODELS/model00.yml'));
    expect((await stat(join(card, 'MODELS/model00.yml'))).mtime.getTime()).toBe(backed.mtime.getTime());
    expect((await planRestore(card, p, 'tx16s', name)).items).toEqual([]);
  });

  it('restores a file renamed only in case under its old name', async () => {
    const { card, p, name } = await setup();
    await rename(join(card, 'MODELS/model00.yml'), join(card, 'MODELS/MODEL00.yml'));
    await applyRestore(card, await planRestore(card, p, 'tx16s', name));
    expect(await readdir(join(card, 'MODELS'))).toContain('model00.yml');
    expect(await readdir(join(card, 'MODELS'))).not.toContain('MODEL00.yml');
  });

  it('restores a folder renamed only in case under its old name', async () => {
    const { card, p, name } = await setup();
    await rename(join(card, 'SCRIPTS/TOOLS'), join(card, 'SCRIPTS/tools'));
    await applyRestore(card, await planRestore(card, p, 'tx16s', name));
    expect(await readdir(join(card, 'SCRIPTS'))).toEqual(['TOOLS']);
    expect((await planRestore(card, p, 'tx16s', name)).items).toEqual([]);
  });
});
