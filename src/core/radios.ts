import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localVersions, versionDir } from './packages.ts';
import type { Paths } from './paths.ts';
import type { Settings } from './settings.ts';

// Radios come from sdcard.json of the EdgeTX SD content release, so new radios need no change here.
// `board` is the firmware flavour EdgeTX writes to RADIO/radio.yml, `sdPackage` the zip without ".zip".
export interface RadioType {
  board: string;
  name: string;
  sdPackage: string;
}

export const MIN_EDGETX = '2.12';

// sdcard.json: { "targets": [["FrSky Horus X10", "x10-", "c480x272"], ...] }
export function parseRadioTypes(text: string): RadioType[] {
  const targets = (JSON.parse(text) as { targets?: unknown[] }).targets ?? [];
  return targets
    .filter((t): t is [string, string, string] => Array.isArray(t) && t.length >= 3 && t.every((x) => typeof x === 'string'))
    .map(([name, prefix, sdPackage]) => ({ board: prefix.replace(/-$/, ''), name, sdPackage }));
}

// The radios of one downloaded SD content version; none when its sdcard.json is missing.
export async function radioTypesIn(dir: string): Promise<RadioType[]> {
  const text = await readFile(join(dir, 'sdcard.json'), 'utf8').catch(() => undefined);
  return text === undefined ? [] : parseRadioTypes(text);
}

// The radios of the newest downloaded SD content; none before the first download.
export async function radioTypes(p: Paths, s: Settings): Promise<RadioType[]> {
  const src = s.sources.find((x) => x.kind === 'sdcard');
  const [newest] = src ? await localVersions(p, src.name) : [];
  return src && newest ? radioTypesIn(versionDir(p, src.name, newest.tag)) : [];
}

export function radioName(types: readonly RadioType[], board: string | undefined): string {
  return types.find((r) => r.board === board)?.name ?? board ?? 'unknown radio';
}

// Compares major.minor only; patch and suffixes don't matter for the minimum.
export function isBelowMin(version: string, min = MIN_EDGETX): boolean {
  const [a = 0, b = 0] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const [c = 0, d = 0] = min.split('.').map((n) => parseInt(n, 10) || 0);
  return a < c || (a === c && b < d);
}
