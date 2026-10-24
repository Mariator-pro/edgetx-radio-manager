import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyPlan } from '../src/core/apply.ts';
import { backupCard } from '../src/core/backup.ts';
import { sha256, type PackageContent } from '../src/core/content.ts';
import { paths } from '../src/core/paths.ts';
import { makePlan, mergePackages } from '../src/core/plan.ts';
import { applyRestore, planRestore } from '../src/core/restore.ts';
import { tempDir, writeTree } from './helpers.ts';

// Like Windows on a removable card: mkdir of the drive root fails with EPERM.
const roots = new Set<string>();
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const mkdir = async (path: string, options?: { recursive?: boolean }) => {
    if (roots.has(resolve(path))) throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${path}'`), { code: 'EPERM' });
    return fs.mkdir(path, options);
  };
  return { ...fs, mkdir: mkdir as typeof fs.mkdir };
});

async function newCard(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir();
  await writeTree(root, { 'RADIO/radio.yml': 'semver: 2.12.5\nboard: tx15\n', ...files });
  roots.add(resolve(root));
  return root;
}

describe('files at the card root', () => {
  it('are written without creating the root folder', async () => {
    const root = await newCard();
    const files = new Map(['edgetx.sdcard.version', 'WIDGETS/A/main.lua'].map((path) => [path, { data: Buffer.from(path), sha: sha256(Buffer.from(path)), time: 1 }]));
    const contents: PackageContent[] = [{ name: 'edgetx-sdcard', origin: 'release', version: 'v1', files }];
    await applyPlan(root, { plan: await makePlan(root, mergePackages(contents)), contents });
    expect(await readFile(join(root, 'edgetx.sdcard.version'), 'utf8')).toBe('edgetx.sdcard.version');
    expect(await readFile(join(root, 'WIDGETS/A/main.lua'), 'utf8')).toBe('WIDGETS/A/main.lua');
  });

  it('are restored without creating the root folder', async () => {
    const root = await newCard({ 'edgetx.sdcard.version': 'v1' });
    const p = paths(await tempDir());
    const b = await backupCard(root, 'tx15', p, new Date(2026, 9, 25, 12, 0));
    await writeFile(join(root, 'edgetx.sdcard.version'), 'v2, longer');
    await applyRestore(root, await planRestore(root, p, 'tx15', b.name));
    expect(await readFile(join(root, 'edgetx.sdcard.version'), 'utf8')).toBe('v1');
  });
});
