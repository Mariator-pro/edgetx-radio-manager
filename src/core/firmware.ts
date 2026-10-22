import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from './errors.ts';
import { versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import { readZip, zipNames } from './zip.ts';

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

// The firmware file of one radio type from the downloaded firmware zip.
export async function firmwareFile(p: Paths, tag: string, board: string): Promise<{ name: string; data: Buffer }> {
  const re = boardFile(board);
  for (const [name, data] of await readZip(await firmwareZip(p, tag))) {
    if (re.test(name)) return { name: name.slice(name.lastIndexOf('/') + 1), data };
  }
  throw new AppError('noFirmwareFor', { board, tag });
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

// Writes the .bin to the start of the internal flash and leaves DFU mode, like Companion.
export async function flashDfu(data: Buffer, onPercent: (pct: number) => void = () => {}, dfuUtil = 'dfu-util'): Promise<void> {
  const devices = (await listDfu(dfuUtil)).filter((d) => d.name.includes('Internal Flash'));
  if (devices.length === 0) throw new AppError('noDfuRadio');
  if (devices.length > 1) throw new AppError('severalDfu');
  const dir = await mkdtemp(join(tmpdir(), 'radio-manager-dfu-'));
  const file = join(dir, 'firmware.bin');
  try {
    await writeFile(file, data);
    const r = await run(dfuUtil, ['-d', '0483:df11', '-a', '0', '-s', '0x08000000:leave', '-D', file], (chunk) => {
      for (const m of chunk.matchAll(/(\d{1,3})%/g)) onPercent(Number(m[1]));
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

// Waits for the radio in its bootloader (UF2 drive) or DFU mode, then writes the firmware.
export async function flashFirmware(p: Paths, board: string, tag: string, o: FlashOptions): Promise<{ method: FlashMethod; file: string }> {
  const say = o.onProgress ?? (() => {});
  const fw = await firmwareFile(p, tag, board);
  const method = methodOf(fw.name);
  if (method === 'uf2') {
    say({ step: 'waiting', text: 'Waiting for the bootloader drive …', file: fw.name });
    const drive = await waitFor(async () => findUf2Drive(await o.volumes()), o.signal, o.timeoutMs);
    say({ step: 'writing', text: `Writing ${fw.name} to ${drive.volume} …`, file: fw.name });
    await flashUf2(drive, board, fw.data);
  } else {
    const dfuUtil = o.dfuUtil ?? 'dfu-util';
    if (!(await dfuUtilAvailable(dfuUtil))) throw new AppError('dfuUtilMissing');
    say({ step: 'waiting', text: 'Waiting for the radio in DFU mode …', file: fw.name });
    await waitFor(async () => (await listDfu(dfuUtil)).find((d) => d.name.includes('Internal Flash')), o.signal, o.timeoutMs);
    say({ step: 'writing', text: `Writing ${fw.name} …`, file: fw.name, pct: 0 });
    await flashDfu(fw.data, (pct) => say({ step: 'writing', text: `Writing ${fw.name} …`, file: fw.name, pct }), dfuUtil);
  }
  return { method, file: fw.name };
}
