import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

// File systems of SD cards and the UF2 bootloader drive; fuseblk is exFAT through FUSE on older systems.
const LINUX_FS = new Set(['vfat', 'msdos', 'exfat', 'fuseblk']);

// Mount points from /proc/mounts with one of those file systems, wherever the desktop mounted them
// (/media/<user>, /run/media/<user>, /mnt); the EFI partition under /boot is left out.
export function parseMounts(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.split(' '))
    .filter((f) => f.length > 2 && LINUX_FS.has(f[2]!))
    .map((f) => f[1]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))))
    .filter((mount) => mount !== '/' && mount !== '/boot' && !mount.startsWith('/boot/'));
}

// Mounted drives that could hold an SD card. The only OS-specific part of detection.
// RADIO_MANAGER_VOLUMES (paths separated like PATH) replaces detection, e.g. for a simulator SD folder.
export async function listVolumes(): Promise<string[]> {
  const override = process.env.RADIO_MANAGER_VOLUMES;
  if (override) return override.split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    return [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d));
  }
  if (process.platform === 'linux') return parseMounts(await readFile('/proc/mounts', 'utf8').catch(() => ''));
  const entries = await readdir('/Volumes', { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join('/Volumes', e.name));
}
