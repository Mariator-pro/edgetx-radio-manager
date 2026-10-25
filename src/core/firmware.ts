import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from './errors.ts';
import { listReleases, type FetchFn } from './github.ts';
import { versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import { isBelowMin, MIN_EDGETX } from './radios.ts';
import type { Source } from './settings.ts';
import { readZip, remoteZipNames, zipNames } from './zip.ts';

// UF2 radios flash by copying to the bootloader's drive; the others over USB DFU.
export type FlashMethod = 'uf2' | 'dfu';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "<board>-<hash>.uf2|.bin"; "x9e" must not match "x9e-hall-<hash>.bin".
const boardFile = (board: string) => new RegExp(`^(?:.*/)?${escape(board)}-[0-9a-f]+\\.(?:uf2|bin)$`);

// The firmware zip ships a .uf2 for radios with a UF2 bootloader and a .bin for the others.
const methodOf = (file: string): FlashMethod => (file.endsWith('.uf2') ? 'uf2' : 'dfu');

async function firmwareZip(p: Paths, tag: string): Promise<string> {
  const dir = versionDir(p, 'edgetx-firmware', tag);
  const zip = (await readdir(dir).catch(() => [])).find((n) => n.endsWith('.zip'));
  if (!zip) throw new AppError('firmwareNotDownloaded', { tag });
  return join(dir, zip);
}

export async function flashMethod(p: Paths, tag: string, board: string): Promise<FlashMethod> {
  const name = (await zipNames(await firmwareZip(p, tag))).find((n) => boardFile(board).test(n));
  if (!name) throw new AppError('noFirmwareFor', { board, tag });
  return methodOf(name);
}

// The flash method before a version is chosen: from the newest downloaded stable version, or else from the
// first other one (older stable ones, then release candidates) with a file for this radio.
export async function knownMethod(p: Paths, versions: { tag: string; prerelease?: boolean }[], board: string): Promise<FlashMethod | undefined> {
  for (const v of [...versions.filter((x) => !x.prerelease), ...versions.filter((x) => x.prerelease)]) {
    const method = await flashMethod(p, v.tag, board).catch(() => undefined);
    if (method) return method;
  }
  return undefined;
}

// The firmware file of one radio type from the downloaded firmware zip.
export async function firmwareFile(p: Paths, tag: string, board: string): Promise<{ name: string; data: Buffer }> {
  const re = boardFile(board);
  for (const [name, data] of await readZip(await firmwareZip(p, tag))) {
    if (re.test(name)) return { name: name.slice(name.lastIndexOf('/') + 1), data };
  }
  throw new AppError('noFirmwareFor', { board, tag });
}

// UF2 blocks of 512 bytes: magic words at 0 and 4, payload size at 16, payload from 32.
function uf2Payload(data: Buffer): Buffer | undefined {
  if (data.length < 512 || data.readUInt32LE(0) !== 0x0a324655 || data.readUInt32LE(4) !== 0x9e5d5157) return undefined;
  const parts: Buffer[] = [];
  for (let at = 0; at + 512 <= data.length; at += 512) parts.push(data.subarray(at + 32, at + 32 + Math.min(data.readUInt32LE(at + 16), 476)));
  return Buffer.concat(parts);
}

// The identification EdgeTX builds into every firmware, e.g. "edgetx-tx16s-v2.12.5 (0ebe2e98)";
// "x9e-hall" stays whole because the version must follow the radio type.
export function firmwareId(data: Buffer): { board: string; version: string } | undefined {
  const text = (uf2Payload(data) ?? data).toString('latin1');
  const m = text.match(/edgetx-([a-z0-9]+(?:-[a-z0-9]+)*?)-v?(\d+\.\d+\.\d+[^\s()\0]*)/);
  return m ? { board: m[1]!, version: `v${m[2]!}` } : undefined;
}

export interface FirmwareFileCheck {
  method: FlashMethod;
  board?: string; // from the identification; without it the file can't be checked
  version?: string;
}

// A firmware file chosen by the user: .uf2 or .bin as the radio needs it (method, when known), and built for this radio.
export function checkFirmwareFile(name: string, data: Buffer, board: string, method?: FlashMethod): FirmwareFileCheck {
  const ext = name.toLowerCase().match(/\.(uf2|bin)$/)?.[1];
  if (!ext) throw new AppError('notFirmwareFile', { file: name });
  const fileMethod = methodOf(`.${ext}`);
  if (method && fileMethod !== method) throw new AppError('wrongFirmwareType', { file: name, ext: method === 'uf2' ? '.uf2' : '.bin' });
  if (fileMethod === 'uf2' && !uf2Payload(data)) throw new AppError('notFirmwareFile', { file: name });
  const id = firmwareId(data);
  if (id && id.board !== board) throw new AppError('wrongFirmwareBoard', { file: name, fileBoard: id.board, board });
  return { method: fileMethod, ...id };
}

export interface CatalogEntry {
  tag: string;
  name?: string;
  published: string;
  prerelease: boolean;
  boards: string[]; // radio types the firmware zip has a file for
}

// "v2.13.0-rc1"; EdgeTX's other pre-release, the rolling "nightly", is left out.
export const isReleaseCandidate = (tag: string) => /-rc\d+$/i.test(tag);

// Firmware releases on GitHub from MIN_EDGETX on, with prereleases also the release candidates, each with the radio types it supports.
// The types come from the zip's file list, read from GitHub without downloading the zip, and are kept
// in catalog.json next to the downloads: a release doesn't change.
export async function firmwareCatalog(p: Paths, source: Source, fetchFn: FetchFn = fetch, prereleases = false): Promise<CatalogEntry[]> {
  const file = join(p.packages, source.name, 'catalog.json');
  const known = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, string[]>;
  const candidates = prereleases ? (await listReleases(source.repo, fetchFn, true)).filter((r) => isReleaseCandidate(r.tag)) : [];
  const releases = [...(await listReleases(source.repo, fetchFn)), ...candidates].filter((r) => !isBelowMin(r.tag.replace(/^v/, ''), MIN_EDGETX));
  let added = false;
  const entries = await Promise.all(
    releases.map(async (r): Promise<CatalogEntry | undefined> => {
      if (!known[r.tag]) {
        const zip = r.assets.find((a) => /^edgetx-firmware-.*\.zip$/.test(a.name));
        if (!zip) return undefined;
        const names = await remoteZipNames(zip.url, zip.size, fetchFn).catch(() => undefined);
        if (!names) return undefined;
        known[r.tag] = [...new Set(names.map((n) => n.match(/^(?:.*\/)?(.+)-[0-9a-f]+\.(?:uf2|bin)$/)?.[1]).filter((b): b is string => !!b))];
        added = true;
      }
      return { tag: r.tag, ...(r.name ? { name: r.name } : {}), published: r.published, prerelease: r.prerelease, boards: known[r.tag]! };
    }),
  );
  if (added) {
    await mkdir(join(p.packages, source.name), { recursive: true });
    await writeFile(file, `${JSON.stringify(known, null, 2)}\n`);
  }
  return entries.filter((e): e is CatalogEntry => !!e);
}

export interface Uf2Drive {
  volume: string;
  board?: string;
  bootloader?: string;
}

// INFO_UF2.TXT of the bootloader drive, e.g. "UF2 Bootloader v1.0", "Board-ID: tx16smk3".
export function parseUf2Info(text: string): { board?: string; bootloader?: string } {
  const line = (label: string) => text.split(/\r?\n/).find((l) => l.startsWith(label))?.slice(label.length).trim();
  return { board: line('Board-ID:'), bootloader: line('UF2 Bootloader') };
}

export async function findUf2Drive(volumes: string[]): Promise<Uf2Drive | undefined> {
  for (const volume of volumes) {
    const text = await readFile(join(volume, 'INFO_UF2.TXT'), 'utf8').catch(() => undefined);
    if (text !== undefined) return { volume, ...parseUf2Info(text) };
  }
  return undefined;
}

// Writes the firmware as firmware.uf2; the bootloader flashes it and restarts the radio.
export async function flashUf2(drive: Uf2Drive, board: string, data: Buffer): Promise<void> {
  if (drive.board && drive.board !== board) throw new AppError('wrongRadio', { connected: drive.board, board });
  await writeFile(join(drive.volume, 'firmware.uf2'), data);
}

export interface DfuDevice {
  id: string;
  name: string;
}

// STM32 boot ROM in DFU mode, as listed by "dfu-util -l".
export function parseDfuList(text: string): DfuDevice[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('Found DFU:') && l.includes('[0483:df11]') && /alt=0\b/.test(l))
    .map((l) => ({ id: '0483:df11', name: l.match(/name="([^"]*)"/)?.[1] ?? '' }));
}

function run(cmd: string, args: string[], onOutput?: (chunk: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    const take = (b: Buffer) => {
      out += b.toString();
      onOutput?.(b.toString());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

export async function dfuUtilAvailable(dfuUtil = 'dfu-util'): Promise<boolean> {
  return run(dfuUtil, ['--version']).then(
    (r) => r.code === 0,
    () => false,
  );
}

export async function listDfu(dfuUtil = 'dfu-util'): Promise<DfuDevice[]> {
  return parseDfuList((await run(dfuUtil, ['-l']).catch(() => ({ out: '' }))).out);
}

// Radios in DFU mode whose internal flash can be written.
export async function dfuRadios(dfuUtil = 'dfu-util'): Promise<DfuDevice[]> {
  return (await listDfu(dfuUtil)).filter((d) => d.name.includes('Internal Flash'));
}

// Writes the .bin to the start of the internal flash and leaves DFU mode; devices when already listed.
export async function flashDfu(data: Buffer, onPercent: (pct: number) => void = () => {}, dfuUtil = 'dfu-util', devices?: DfuDevice[]): Promise<void> {
  devices ??= await dfuRadios(dfuUtil);
  if (devices.length === 0) throw new AppError('noDfuRadio');
  if (devices.length > 1) throw new AppError('severalDfu');
  const dir = await mkdtemp(join(tmpdir(), 'radio-manager-dfu-'));
  const file = join(dir, 'firmware.bin');
  try {
    await writeFile(file, data);
    // progress lines end in \r or \n and may span chunks; only "Download", the erase before it has its own bar
    let line = '';
    const r = await run(dfuUtil, ['-d', '0483:df11', '-a', '0', '-s', '0x08000000:leave', '-D', file], (chunk) => {
      const parts = (line + chunk).split(/[\r\n]/);
      line = parts.at(-1)!;
      for (const part of parts) {
        const m = part.match(/^Download\b.*?(\d{1,3})%/);
        if (m) onPercent(Number(m[1]));
      }
    });
    // dfu-util may report an error after ":leave" when the radio has already restarted
    if (r.code !== 0 && !/File downloaded successfully|Download done/i.test(r.out)) {
      throw new AppError('dfuFailed', { detail: r.out.trim().split('\n').pop() ?? '' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Polls until check() returns something; gives up on abort or after timeoutMs.
export async function waitFor<T>(check: () => Promise<T | undefined>, signal?: AbortSignal, timeoutMs = 5 * 60_000, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new AppError('cancelled');
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new AppError('radioTimeout');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export interface FlashProgress {
  step: 'waiting' | 'writing';
  text: string;
  file: string;
  pct?: number;
}

export interface FlashOptions {
  volumes: () => Promise<string[]>;
  signal?: AbortSignal;
  onProgress?: (pr: FlashProgress) => void;
  dfuUtil?: string;
  timeoutMs?: number;
}

// Waits for the radio in its bootloader (UF2 drive) or DFU mode, then writes the firmware of a downloaded release.
export async function flashFirmware(p: Paths, board: string, tag: string, o: FlashOptions): Promise<{ method: FlashMethod; file: string }> {
  return flashFile(board, await firmwareFile(p, tag, board), o);
}

// The same for any firmware file; checkFirmwareFile comes first for one the user chose.
export async function flashFile(board: string, fw: { name: string; data: Buffer }, o: FlashOptions): Promise<{ method: FlashMethod; file: string }> {
  const say = o.onProgress ?? (() => {});
  // looks once before saying it waits, so a radio that is already connected goes straight to writing
  const find = async <T>(check: () => Promise<T | undefined>, text: string): Promise<T> => {
    const found = await check();
    if (found !== undefined) return found;
    say({ step: 'waiting', text, file: fw.name });
    return waitFor(check, o.signal, o.timeoutMs);
  };
  const method = methodOf(fw.name.toLowerCase());
  if (method === 'uf2') {
    const drive = await find(async () => findUf2Drive(await o.volumes()), 'Waiting for the bootloader drive …');
    say({ step: 'writing', text: `Writing ${fw.name} to ${drive.volume} …`, file: fw.name });
    await flashUf2(drive, board, fw.data);
  } else {
    const dfuUtil = o.dfuUtil ?? 'dfu-util';
    if (!(await dfuUtilAvailable(dfuUtil))) throw new AppError('dfuUtilMissing');
    const devices = await find(async () => {
      const found = await dfuRadios(dfuUtil);
      return found.length > 0 ? found : undefined;
    }, 'Waiting for the radio in DFU mode …');
    say({ step: 'writing', text: `Writing ${fw.name} …`, file: fw.name, pct: 0 });
    await flashDfu(fw.data, (pct) => say({ step: 'writing', text: `Writing ${fw.name} …`, file: fw.name, pct }), dfuUtil, devices);
  }
  return { method, file: fw.name };
}
