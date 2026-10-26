// electron-builder hook, run after packing and before signing. Every Electron app of one Electron version
// ships the same main executable, with the same Mach-O UUID. macOS tells apps apart by that UUID for its
// "Local Network" permission, so the app was taken for Electron itself and never asked for it.
// This gives the macOS executable a UUID of its own, made from the old one, the app id and the version.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LC_UUID = 0x1b;

interface Context {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { id: string; version: string; productFilename: string } };
}

// Offsets of the 16 UUID bytes in each architecture of a thin or universal Mach-O file.
function uuidOffsets(buf: Buffer): number[] {
  if (buf.readUInt32BE(0) === 0xcafebabe) {
    const offsets: number[] = [];
    for (let i = 0; i < buf.readUInt32BE(4); i++) {
      const start = buf.readUInt32BE(8 + i * 20 + 8); // fat_arch: cputype, cpusubtype, offset, size, align
      offsets.push(...uuidOffsets(buf.subarray(start)).map((o) => o + start));
    }
    return offsets;
  }
  if (buf.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Not a 64-bit Mach-O file');
  let at = 32;
  for (let i = 0; i < buf.readUInt32LE(16); i++) {
    if (buf.readUInt32LE(at) === LC_UUID) return [at + 8];
    at += buf.readUInt32LE(at + 4);
  }
  throw new Error('No LC_UUID in the executable');
}

export default function afterPack(context: Context): void {
  if (context.electronPlatformName !== 'darwin') return;
  const { id, version, productFilename } = context.packager.appInfo;
  const file = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  const buf = readFileSync(file);
  for (const at of uuidOffsets(buf)) {
    const uuid = createHash('sha256').update(buf.subarray(at, at + 16)).update(`${id} ${version}`).digest().subarray(0, 16);
    uuid[6] = (uuid[6]! & 0x0f) | 0x50; // name-based UUID (version 5 layout), RFC 9562
    uuid[8] = (uuid[8]! & 0x3f) | 0x80;
    uuid.copy(buf, at);
  }
  writeFileSync(file, buf);
}
