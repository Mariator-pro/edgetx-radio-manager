import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// macOS keeps file metadata on FAT cards in "._<name>" files next to each file and folder it writes. They are of
// no use to the radio, so the app removes them.

// OS housekeeping folders on the card, never touched.
export const SYSTEM_DIRS = new Set(['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems', 'System Volume Information']);

export const isAppleDouble = (name: string) => name.startsWith('._');

// Removes the "._" file of one file or folder just written.
export async function dropAppleDouble(path: string): Promise<void> {
  await rm(join(dirname(path), `._${basename(path)}`), { force: true });
}

// Removes every "._" file on the card, also those left by earlier versions of the app or by the Finder.
export async function removeAppleDouble(root: string): Promise<number> {
  let removed = 0;
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SYSTEM_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (isAppleDouble(e.name) && e.isFile()) {
        await rm(full, { force: true });
        removed++;
      } else if (e.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return removed;
}
