import type { InstalledList, RadioCard } from './card.ts';
import type { Origin } from './content.ts';
import { localVersions, mainInfo } from './packages.ts';
import type { Paths } from './paths.ts';
import type { Choice, Settings, Source } from './settings.ts';

// Sources that put files on the SD card (firmware is flashed instead).
export function updateSources(s: Settings): Source[] {
  return s.sources.filter((src) => src.kind !== 'firmware');
}

// Release when one is downloaded, else the newest main commit, else the local checkout when there is one.
export async function defaultOrigin(p: Paths, source: Source): Promise<Origin> {
  if ((await localVersions(p, source.name)).length > 0) return 'release';
  if (await mainInfo(p, source.name)) return 'main';
  return source.localDir ? 'local' : 'release';
}

// What goes on a radio is what its SD card holds when it is connected: every package in the card's list, with its
// origin, and the sounds with their voices. More is chosen in the app and holds until the radio is connected again.
// An empty card gets the sounds of the radio's voice language; SD content is always on. True when the choice changed.
export async function selectionFromCard(p: Paths, s: Settings, board: string, card: RadioCard, list: InstalledList): Promise<boolean> {
  const r = (s.radios[board] ??= {});
  const before = JSON.stringify([r.sources, r.sounds]);
  const empty = Object.keys(list.packages).length === 0;
  const sources: Record<string, Choice> = {};
  for (const src of updateSources(s)) {
    const listed = list.packages[src.name];
    const on = src.kind === 'sdcard' || !!listed || (empty && src.kind === 'sounds' && !!card.language);
    sources[src.name] = { on, origin: listed?.origin ?? (await defaultOrigin(p, src)) };
  }
  r.sources = sources;
  const sounds = s.sources.find((x) => x.kind === 'sounds');
  const listed = sounds ? list.packages[sounds.name] : undefined;
  r.sounds = listed ? (listed.voices ?? card.soundLanguages ?? []) : card.language ? [card.language] : [];
  return JSON.stringify([r.sources, r.sounds]) !== before;
}

// Sources the radio's choice doesn't know yet (added since the card was read) come in switched off.
export async function ensureSelection(p: Paths, s: Settings, board: string): Promise<boolean> {
  const r = (s.radios[board] ??= {});
  const sel = (r.sources ??= {});
  let changed = false;
  for (const src of updateSources(s)) {
    if (sel[src.name]) continue;
    sel[src.name] = { on: src.kind === 'sdcard', origin: await defaultOrigin(p, src) };
    changed = true;
  }
  return changed;
}
