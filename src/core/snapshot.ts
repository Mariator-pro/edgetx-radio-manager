import { relative, sep } from 'node:path';
import { listFiles } from './backup.ts';
import { ID_PATH } from './card.ts';

// The card's files by size and change time, taken with a plan: what "Restore", "Update" or "Copy" then does holds
// only while the card is still like this. Reads no file, so it is quick also over the radio's slow USB.
export type CardSnapshot = Map<string, string>;

export async function cardSnapshot(volume: string): Promise<CardSnapshot> {
  const out: CardSnapshot = new Map();
  for (const f of await listFiles(volume)) {
    const path = relative(volume, f.path).split(sep).join('/');
    if (path !== ID_PATH) out.set(path, `${f.size}|${f.mtime.getTime()}`); // the card's id the app may write meanwhile
  }
  return out;
}

export async function cardChangedSince(volume: string, then: CardSnapshot): Promise<boolean> {
  const now = await cardSnapshot(volume);
  return now.size !== then.size || [...now].some(([path, s]) => then.get(path) !== s);
}
