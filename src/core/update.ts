import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledList, RadioCard } from './card.ts';
import { loadContent, releaseContent, type PackageContent, type RadioContext } from './content.ts';
import { downloadTag } from './download.ts';
import type { FetchFn } from './github.ts';
import { versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import { makePlan, mergePackages, type PlanItem } from './plan.ts';
import { ensureSelection, updateSources } from './selection.ts';
import { soundsOf, type Settings } from './settings.ts';

export interface UpdateSetup {
  contents: PackageContent[];
  missing: string[]; // switched on, but nothing to install (not downloaded, no checkout)
  plan: PlanItem[];
  selectionChanged: boolean;
}

// A card the tool never updated has no list. If EdgeTX's SD content says which version it is
// (edgetx.sdcard.version), that version's files stand in for the list: files still exactly as
// shipped get replaced or deleted without asking, only real changes stay conflicts.
async function sdContentBaseline(p: Paths, s: Settings, card: RadioCard, ctx: RadioContext, fetchFn: FetchFn): Promise<InstalledList | undefined> {
  const src = s.sources.find((x) => x.kind === 'sdcard');
  if (card.installed || !card.sdcardVersion || !src) return undefined;
  const tag = card.sdcardVersion.startsWith('v') ? card.sdcardVersion : `v${card.sdcardVersion}`;
  // older downloads may lack sdcard.json; downloading again only fetches the missing files
  if (!existsSync(join(versionDir(p, src.name, tag), 'sdcard.json'))) {
    await downloadTag(p, s, src, tag, fetchFn).catch(() => undefined); // offline: no baseline
  }
  const old = await releaseContent(p, src, ctx, tag);
  if (!old || old.files.size === 0) return undefined;
  const files = Object.fromEntries([...old.files].map(([path, f]) => [path, { sha256: f.sha, from: [src.name], written: src.name }]));
  return { tool: 1, updated: '', packages: { [src.name]: { version: tag, origin: 'release' } }, files };
}

// Everything an SD update of this card would do, without touching the card.
export async function prepareUpdate(p: Paths, s: Settings, card: RadioCard, board: string, fetchFn: FetchFn = fetch): Promise<UpdateSetup> {
  const ctx = { board, voices: soundsOf(s.radios[board]) };
  const selectionChanged = await ensureSelection(p, s, board, card.volume, ctx);
  const choices = s.radios[board]!.sources!;
  const contents: PackageContent[] = [];
  const missing: string[] = [];
  for (const src of updateSources(s)) {
    const choice = choices[src.name];
    if (!choice?.on) continue;
    const content = await loadContent(p, src, choice.origin, ctx);
    if (content && content.files.size > 0) contents.push(content);
    else missing.push(`${src.name} (${choice.origin})`);
  }
  const list = card.installed ?? (await sdContentBaseline(p, s, card, ctx, fetchFn));
  const plan = await makePlan(card.volume, mergePackages(contents), list);
  return { contents, missing, plan, selectionChanged };
}
