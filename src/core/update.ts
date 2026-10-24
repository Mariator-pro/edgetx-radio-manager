import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledList, RadioCard } from './card.ts';
import { detectVersion, loadContent, releaseContent, type PackageContent, type RadioContext } from './content.ts';
import { downloadTag } from './download.ts';
import type { FetchFn } from './github.ts';
import { versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import { makePlan, mergePackages, type PlanItem, type Wanted } from './plan.ts';
import { ensureSelection, updateSources } from './selection.ts';
import { soundsOf, type Choice, type PackageChange, type Settings } from './settings.ts';

export interface UpdateSetup {
  contents: PackageContent[];
  missing: string[]; // switched on, but nothing to install (not downloaded, no checkout)
  held: Pick<InstalledList, 'packages' | 'files'>; // what the card has of the missing ones, left as it is
  plan: PlanItem[];
  changes: PackageChange[]; // packages whose version on the card changes
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

// Projects copied to the card by hand that match a downloaded version exactly count as installed by the
// tool: switched off they are removed, switched on they are replaced without asking.
async function withCopied(p: Paths, s: Settings, card: RadioCard, list: InstalledList | undefined, choices: Record<string, Choice>) {
  const out: InstalledList = list ? { ...list, packages: { ...list.packages }, files: { ...list.files } } : { tool: 1, updated: '', packages: {}, files: {} };
  let adopted = false;
  for (const src of updateSources(s)) {
    if (src.kind !== 'project' || out.packages[src.name]) continue;
    const found = await detectVersion(p, src, card.volume, choices[src.name]?.origin ?? 'release');
    if (!found.files) continue;
    out.packages[src.name] = { version: found.version!, origin: found.origin! };
    for (const [path, sha] of found.files) out.files[path] ??= { sha256: sha, from: [src.name], written: src.name };
    adopted = true;
  }
  return adopted ? out : list;
}

// Switched on but not available: the card keeps its files of these packages, and the list its entries.
function holdMissing(list: InstalledList | undefined, wanted: Map<string, Wanted>, missing: Set<string>): UpdateSetup['held'] {
  const held: UpdateSetup['held'] = { packages: {}, files: {} };
  for (const [name, entry] of Object.entries(list?.packages ?? {})) if (missing.has(name)) held.packages[name] = entry;
  for (const [path, f] of Object.entries(list?.files ?? {})) if (!wanted.has(path) && f.from.some((n) => missing.has(n))) held.files[path] = f;
  return held;
}

// Everything an SD update of this card would do, without touching the card.
export async function prepareUpdate(p: Paths, s: Settings, card: RadioCard, board: string, fetchFn: FetchFn = fetch): Promise<UpdateSetup> {
  const ctx = { board, voices: soundsOf(s.radios[board]) };
  const selectionChanged = await ensureSelection(p, s, board, card.volume, ctx);
  const choices = s.radios[board]!.sources!;
  const contents: PackageContent[] = [];
  const missing: string[] = [];
  const unavailable = new Set<string>();
  for (const src of updateSources(s)) {
    const choice = choices[src.name];
    if (!choice?.on) continue;
    const content = await loadContent(p, src, choice.origin, ctx);
    if (content && content.files.size > 0) contents.push(content);
    else {
      missing.push(`${src.name} (${choice.origin})`);
      unavailable.add(src.name);
    }
  }
  const list = await withCopied(p, s, card, card.installed ?? (await sdContentBaseline(p, s, card, ctx, fetchFn)), choices);
  const wanted = mergePackages(contents);
  const held = holdMissing(list, wanted, unavailable);
  const planned = list && { ...list, files: Object.fromEntries(Object.entries(list.files).filter(([path]) => !held.files[path])) };
  const plan = await makePlan(card.volume, wanted, planned);
  // Switched off means removed; switched on but not available leaves the card's version alone.
  const changes: PackageChange[] = [];
  for (const src of updateSources(s)) {
    const from = list?.packages[src.name]?.version;
    const to = contents.find((c) => c.name === src.name)?.version;
    if (to ? to !== from : from && !choices[src.name]?.on) changes.push({ name: src.name, from, to });
  }
  return { contents, missing, held, plan, changes, selectionChanged };
}
