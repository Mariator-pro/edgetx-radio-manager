import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

// Mounted drives that could hold an SD card. The only OS-specific part of detection.
// RADIO_MANAGER_VOLUMES (paths separated like PATH) replaces detection, e.g. for a simulator SD folder.
export async function listVolumes(): Promise<string[]> {
  const override = process.env.RADIO_MANAGER_VOLUMES;
  if (override) return override.split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    return [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d));
  }
  const entries = await readdir('/Volumes', { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join('/Volumes', e.name));
}
