import type { InstalledList, RadioCard } from './card.ts';
import { loadContent, type PackageContent } from './content.ts';
import { AppError } from './errors.ts';
import type { Paths } from './paths.ts';
import { makePlan, mergePackages, type PlanItem, type Wanted } from './plan.ts';
import { ensureSelection, updateSources } from './selection.ts';
import { soundsOf, type PackageChange, type Settings } from './settings.ts';

export interface UpdateSetup {
  contents: PackageContent[];
  missing: string[]; // switched on, but nothing to install (not downloaded, no checkout)
  held: Pick<InstalledList, 'packages' | 'files'>; // what the card has of the missing ones, left as it is
  plan: PlanItem[];
  changes: PackageChange[]; // packages whose version on the card changes
  selectionChanged: boolean;
}

// Switched on but not available: the card keeps its files of these packages, and the list its entries.
function holdMissing(list: InstalledList, wanted: Map<string, Wanted>, missing: Set<string>): UpdateSetup['held'] {
  const held: UpdateSetup['held'] = { packages: {}, files: {} };
  for (const [name, entry] of Object.entries(list.packages)) if (missing.has(name)) held.packages[name] = entry;
  for (const [path, f] of Object.entries(list.files)) if (!wanted.has(path) && f.from.some((n) => missing.has(n))) held.files[path] = f;
  return held;
}

// Everything an SD update of this card would do, without touching the card. The card must have been checked
// (checkCard), which gives it the list this compares with.
export async function prepareUpdate(p: Paths, s: Settings, card: RadioCard, board: string): Promise<UpdateSetup> {
  const list = card.installed;
  if (!list) throw new AppError('cardChecking');
  const ctx = { board, voices: soundsOf(s.radios[board]) };
  const selectionChanged = await ensureSelection(p, s, board);
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
  const wanted = mergePackages(contents);
  const held = holdMissing(list, wanted, unavailable);
  const planned = { ...list, files: Object.fromEntries(Object.entries(list.files).filter(([path]) => !held.files[path])) };
  const plan = await makePlan(card.volume, wanted, planned);
  // Switched off means removed; switched on but not available leaves the card's version alone.
  const changes: PackageChange[] = [];
  for (const src of updateSources(s)) {
    const from = list.packages[src.name]?.version;
    const to = contents.find((c) => c.name === src.name)?.version;
    if (to ? to !== from : from && !choices[src.name]?.on) changes.push({ name: src.name, from, to });
  }
  return { contents, missing, held, plan, changes, selectionChanged };
}
