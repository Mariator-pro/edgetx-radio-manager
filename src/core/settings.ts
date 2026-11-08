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
  // one file put on the card at this path: the release asset, and on main the file at repoPath; no local checkout
  file?: { asset: string; card: string; repoPath?: string };
}

export interface Choice {
  on: boolean;
  origin: 'release' | 'main' | 'local';
}

export interface RadioSettings {
  language?: string; // from radio.yml, refreshed on every detection
  sounds?: string[]; // sound packs, one per language, e.g. ["de", "en_gb-ryan"]; taken from the card when it is read
  sources?: Record<string, Choice>; // what goes on this radio; taken from the card when it is read
  firmware?: string; // last seen on the card
  installed?: Record<string, string>; // package -> version, last seen on the card
}

// A package whose version on the card an update changes; without from it is new, without to removed.
export interface PackageChange {
  name: string;
  from?: string;
  to?: string;
}

// Why a backup was made, and the user's own note on it.
export interface BackupInfo {
  reason?: 'manual' | 'update' | 'restore' | 'models' | 'deleteModels';
  changes?: PackageChange[]; // update: what it changed
  restoredFrom?: string; // restore: the backup put back afterwards
  models?: string[]; // models, deleteModels: the models copied to or deleted from the card
  note?: string;
}

export const MAX_NOTE = 200;

export interface Settings {
  sources: Source[];
  radios: Record<string, RadioSettings>;
  backupsToKeep: number;
  keptBackups: Record<string, string[]>; // board -> backup folder names never pruned
  backupInfo: Record<string, Record<string, BackupInfo>>; // board -> backup folder name -> reason and note
  lastCheck?: string; // last download run
  firmwarePrereleases?: boolean; // flash page also offers the firmware release candidates
  knownDefaults?: string[]; // default sources already offered; a removed one isn't added again
  ui?: { lang?: string; theme?: 'light' | 'dark' }; // interface language and theme as last chosen
  localRepos?: string; // folder with the local checkouts of the own projects, chosen on the sources page
}

export const DEFAULT_SOURCES: readonly Source[] = [
  { name: 'edgetx-firmware', repo: 'EdgeTX/edgetx', kind: 'firmware' },
  { name: 'edgetx-sdcard', repo: 'EdgeTX/edgetx-sdcard', kind: 'sdcard' },
  { name: 'edgetx-sounds', repo: 'EdgeTX/edgetx-sdcard-sounds', kind: 'sounds' },
  { name: 'flight-wingman', repo: 'Mariator-pro/edgetx-flight-wingman', kind: 'project', sdDir: 'src' },
  { name: 'lipo-nanny', repo: 'Mariator-pro/edgetx-lipo-nanny', kind: 'project', sdDir: 'src' },
  { name: 'link-sentinel', repo: 'Mariator-pro/elrs-link-sentinel', kind: 'project', sdDir: 'src' },
  { name: 'gps-homer', repo: 'Mariator-pro/edgetx-gps-homer', kind: 'project', sdDir: 'src' },
  { name: 'elrs-lua', repo: 'ExpressLRS/ExpressLRS', kind: 'project', file: { asset: 'elrs.lua', card: 'SCRIPTS/TOOLS/elrs.lua', repoPath: 'src/lua/elrs.lua' } },
];

export function defaultSettings(): Settings {
  return {
    sources: DEFAULT_SOURCES.map((s) => ({ ...s })),
    radios: {},
    backupsToKeep: 10,
    keptBackups: {},
    backupInfo: {},
    knownDefaults: DEFAULT_SOURCES.map((s) => s.name),
  };
}

export async function loadSettings(p: Paths): Promise<Settings> {
  const text = await readFile(p.settings, 'utf8').catch(() => undefined);
  if (text === undefined) return defaultSettings();
  const saved = JSON.parse(text) as Partial<Settings>;
  const s = { ...defaultSettings(), ...saved };
  // earlier settings had one "voice" per radio
  for (const r of Object.values(s.radios) as (RadioSettings & { voice?: string })[]) {
    if (r.voice && !r.sounds) r.sounds = [r.voice];
    delete r.voice;
  }
  // default sources added in a later version reach existing settings once
  const known = new Set(saved.knownDefaults ?? s.sources.map((x) => x.name));
  for (const d of DEFAULT_SOURCES) {
    const have = s.sources.some((x) => x.name === d.name || x.repo.toLowerCase() === d.repo.toLowerCase());
    if (!known.has(d.name) && !have) s.sources.push({ ...d });
  }
  s.knownDefaults = DEFAULT_SOURCES.map((x) => x.name);
  // one-file sources take their file from the defaults, so a changed mapping reaches saved settings
  for (const src of s.sources) {
    const d = DEFAULT_SOURCES.find((x) => x.name === src.name);
    if (d?.file) src.file = { ...d.file };
  }
  return s;
}

// One save at a time: two at once (reading a card in the background, a choice in the interface) would write the same
// temporary file.
let saving: Promise<void> = Promise.resolve();

export function saveSettings(p: Paths, s: Settings): Promise<void> {
  const run = saving.then(async () => {
    await mkdir(dirname(p.settings), { recursive: true });
    const tmp = `${p.settings}.tmp`;
    await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`);
    await rename(tmp, p.settings);
  });
  saving = run.catch(() => {});
  return run;
}

// Sets a backup's note; an empty one removes it, and with it an entry left with nothing in it.
export function setBackupNote(s: Settings, board: string, name: string, note: string): void {
  const info = { ...s.backupInfo[board]?.[name] };
  const text = note.trim();
  if (text) info.note = text;
  else delete info.note;
  const all = (s.backupInfo[board] ??= {});
  if (Object.keys(info).length > 0) all[name] = info;
  else delete all[name];
}

// Drops what is known about deleted backups.
export function forgetBackups(s: Settings, board: string, names: string[]): void {
  for (const n of names) delete s.backupInfo[board]?.[n];
}

// Each SD card keeps its own settings, so two radios of one type don't share a choice; a card without an id yet
// goes by its type alone.
export const radioKey = (board: string, cardId?: string) => (cardId ? `${board}/${cardId}` : board);
export const boardOfKey = (key: string) => key.split('/')[0]!;

// The settings of one SD card, made when missing.
export function radioOf(s: Settings, board: string, cardId?: string): RadioSettings {
  return (s.radios[radioKey(board, cardId)] ??= {});
}

// The firmware last seen on a radio of this type.
export function lastFirmware(s: Settings, board: string): string | undefined {
  return Object.entries(s.radios).find(([key, r]) => boardOfKey(key) === board && r.firmware)?.[1].firmware;
}

// Notes what a detected radio has (language, firmware, installed versions); true when settings changed.
export function rememberRadio(s: Settings, card: RadioCard): boolean {
  if (!card.board) return false;
  const r = radioOf(s, card.board, card.cardId);
  const before = JSON.stringify(r);
  if (card.language) r.language = card.language;
  if (card.firmware) r.firmware = card.firmware;
  if (card.installed) r.installed = Object.fromEntries(Object.entries(card.installed.packages).map(([n, v]) => [n, v.version]));
  return JSON.stringify(r) !== before;
}

// Checkouts of the own projects in the folder with the local repos, each in a folder named like its repo
// (e.g. edgetx-lipo-nanny). Without a folder no project has one.
export function findLocalRepos(s: Settings, folder: string | undefined): boolean {
  let changed = false;
  for (const src of s.sources) {
    if (src.kind !== 'project' || src.file) continue;
    const dir = folder && join(folder, src.repo.split('/')[1] ?? src.name);
    const found = dir && existsSync(join(dir, '.git')) ? dir : undefined;
    if (found === src.localDir) continue;
    if (found) src.localDir = found;
    else delete src.localDir;
    changed = true;
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
