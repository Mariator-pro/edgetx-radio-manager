import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RadioCard } from './card.ts';
import type { Paths } from './paths.ts';

export type SourceKind = 'firmware' | 'sdcard' | 'sounds' | 'project';

export interface Source {
  name: string; // folder under Packages/
  repo: string; // GitHub owner/repo
  kind: SourceKind;
  sdDir?: string; // folder inside the release that maps to the SD card root
  localDir?: string; // local git checkout, optional
}

export interface Choice {
  on: boolean;
  origin: 'release' | 'local';
}

export interface RadioSettings {
  language?: string; // from radio.yml, refreshed on every detection
  sounds?: string[]; // sound packs, one per language, e.g. ["de", "en_gb-ryan"]; first taken from the card
  sources?: Record<string, Choice>; // what goes on this radio; set on first detection
  newSources?: string[]; // added after the first detection, not decided yet
  firmware?: string; // last seen on the card
  installed?: Record<string, string>; // package -> version, last seen on the card
}

export interface Settings {
  sources: Source[];
  radios: Record<string, RadioSettings>;
  backupsToKeep: number;
  keptBackups: Record<string, string[]>; // board -> backup folder names never pruned
  lastCheck?: string; // last download run
}

export const DEFAULT_SOURCES: readonly Source[] = [
  { name: 'edgetx-firmware', repo: 'EdgeTX/edgetx', kind: 'firmware' },
  { name: 'edgetx-sdcard', repo: 'EdgeTX/edgetx-sdcard', kind: 'sdcard' },
  { name: 'edgetx-sounds', repo: 'EdgeTX/edgetx-sdcard-sounds', kind: 'sounds' },
  { name: 'flight-wingman', repo: 'Mariator-pro/edgetx-flight-wingman', kind: 'project', sdDir: 'src' },
  { name: 'lipo-nanny', repo: 'Mariator-pro/edgetx-lipo-nanny', kind: 'project', sdDir: 'src' },
  { name: 'link-sentinel', repo: 'Mariator-pro/elrs-link-sentinel', kind: 'project', sdDir: 'src' },
  { name: 'gps-homer', repo: 'Mariator-pro/edgetx-gps-homer', kind: 'project', sdDir: 'src' },
];

export function defaultSettings(): Settings {
  return { sources: DEFAULT_SOURCES.map((s) => ({ ...s })), radios: {}, backupsToKeep: 10, keptBackups: {} };
}

export async function loadSettings(p: Paths): Promise<Settings> {
  const text = await readFile(p.settings, 'utf8').catch(() => undefined);
  if (text === undefined) return defaultSettings();
  const s = { ...defaultSettings(), ...(JSON.parse(text) as Partial<Settings>) };
  // earlier settings had one "voice" per radio
  for (const r of Object.values(s.radios) as (RadioSettings & { voice?: string })[]) {
    if (r.voice && !r.sounds) r.sounds = [r.voice];
    delete r.voice;
  }
  return s;
}

export async function saveSettings(p: Paths, s: Settings): Promise<void> {
  await mkdir(dirname(p.settings), { recursive: true });
  const tmp = `${p.settings}.tmp`;
  await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`);
  await rename(tmp, p.settings);
}

// Notes what a detected radio has (language, firmware, installed versions); true when settings changed.
export function rememberRadio(s: Settings, card: RadioCard): boolean {
  if (!card.board) return false;
  const r = (s.radios[card.board] ??= {});
  const before = JSON.stringify(r);
  if (card.language) r.language = card.language;
  if (!r.sounds) {
    const langs = new Set([...(card.soundLanguages ?? []), ...(card.language ? [card.language] : [])]);
    if (langs.size > 0) r.sounds = [...langs].sort();
  }
  if (card.firmware) r.firmware = card.firmware;
  if (card.installed) r.installed = Object.fromEntries(Object.entries(card.installed.packages).map(([n, v]) => [n, v.version]));
  return JSON.stringify(r) !== before;
}

// Checkouts of the own projects next to this tool's repo (e.g. ../edgetx-lipo-nanny).
export function findLocalRepos(s: Settings, parentDir: string): boolean {
  let changed = false;
  for (const src of s.sources) {
    if (src.kind !== 'project' || src.localDir) continue;
    const dir = join(parentDir, src.repo.split('/')[1] ?? src.name);
    if (existsSync(join(dir, '.git'))) {
      src.localDir = dir;
      changed = true;
    }
  }
  return changed;
}

// Sound packs of a radio; before the first detection the radio's language.
export function soundsOf(r: RadioSettings | undefined): string[] {
  return r?.sounds ?? (r?.language ? [r.language] : []);
}

// "en_gb-ryan" -> "en": the folder under SOUNDS/ the pack goes to.
export function voiceLanguage(id: string): string {
  return id.split(/[_-]/)[0]!;
}
