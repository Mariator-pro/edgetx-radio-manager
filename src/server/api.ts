import type { ErrorInfo } from '../core/errors.ts';

// Shapes the server sends to the browser interface, shared by both sides (and the CLI);
// imports only Node-free code, so the interface's type check doesn't pull in Node code.

export type SourceKind = 'firmware' | 'sdcard' | 'sounds' | 'project';
export type Action = 'add' | 'replace' | 'unchanged' | 'delete' | 'conflict';
export type ConflictReason = 'modified' | 'unknown' | 'removed-modified';

export interface SourceView {
  name: string;
  repo: string;
  kind: SourceKind;
  localDir?: string;
  newest?: { tag: string; published: string };
  main?: string; // "main <hash>", downloaded newest commit of the default branch
  local?: string; // "local <hash>[*]"
}

export interface RadioSourceView {
  name: string;
  repo: string;
  kind: SourceKind;
  on: boolean;
  origin: 'release' | 'main' | 'local';
  isNew: boolean;
  fixed: boolean; // SD content: always on
  installed?: string;
  found?: 'match' | 'unknown'; // copied to the card by hand: version found by comparing files, or not found
  available?: string;
  voicesChanged?: boolean; // sound packs: other languages or voices chosen than are on the card
  hasRelease: boolean;
  hasMain: boolean;
  releaseOnly: boolean; // one file without a path in the repo: no main commit, no local checkout
  hasLocal: boolean;
}

export interface RadioView {
  volume: string;
  board?: string; // undefined: card without radio.yml, the type has to be chosen
  name: string;
  firmware?: string;
  firmwareAvailable?: string;
  firmwareNames: Record<string, string>; // version without "v" -> release title, for the downloaded ones
  belowMin: boolean;
  language?: string; // voice output language set on the radio
  sounds: string[]; // sound packs on this radio, one per language
  sources: RadioSourceView[];
  updates: string[]; // sources whose card state differs from the selection
  lastBackup?: string;
  backups: number;
}

export interface StateView {
  radios: RadioView[];
  sources: SourceView[];
  busy?: string;
  lastCheck?: string;
  backupsToKeep: number;
}

export interface ProgressEvent {
  op: string;
  step?: 'backup' | 'write' | 'download' | 'waiting' | 'flash';
  text: string; // English, for the log; the interface builds its own text from the fields below
  source?: string; // download: the source being checked or loaded
  file?: string; // download: the file being loaded; flash: the firmware file
  done?: number;
  total?: number;
}

export interface PlanFileView {
  path: string;
  action: Action;
  pkg: string;
  reason?: ConflictReason;
  others?: string[]; // other packages that deliver the same path
}

export interface PlanGroupView {
  name: string;
  from?: string;
  to?: string;
  files: PlanFileView[];
}

export interface PlanView {
  volume: string;
  board: string;
  counts: Record<Action, number>;
  groups: PlanGroupView[];
  conflicts: PlanFileView[];
  missing: string[];
  luac: number; // stale .luac files that go away with written or deleted .lua files
  backupDir: string; // where the backup before the update goes, home folder shortened to "~" outside Windows
}

export interface UpdateResultView {
  written: number;
  deleted: number;
  kept: number;
  backup: string;
}

export type RestoreAction = 'add' | 'replace' | 'delete';

export interface RestorePlanView {
  volume: string;
  board: string;
  name: string; // the backup
  counts: Record<RestoreAction, number>;
  unchanged: number;
  files: { path: string; action: RestoreAction }[];
  backupFirmware?: string; // EdgeTX version when the backup was made
  cardFirmware?: string;
  backupDir: string; // where the backup before the restore goes
}

export interface RestoreResultView {
  written: number;
  deleted: number;
  backup?: string; // the backup made first, unless left out
}

export interface PackageVersionView {
  tag: string;
  published: string;
  bytes: number;
  installedOn: string[];
}

export interface PackageView {
  name: string;
  kind: SourceKind;
  versions: PackageVersionView[];
}

export interface PackageChangeView {
  name: string;
  from?: string; // missing: new on the card
  to?: string; // missing: removed from the card
}

export interface BackupItemView {
  name: string;
  bytes: number;
  kept: boolean;
  firmware?: string; // EdgeTX version in the backup's radio.yml
  reason?: 'manual' | 'update' | 'restore'; // only backups made since the tool notes it
  changes?: PackageChangeView[]; // update: what it changed
  restoredFrom?: string; // restore: the backup put back afterwards
  note?: string;
}

export interface BackupView {
  board: string;
  radio: string;
  items: BackupItemView[];
}

export interface VoiceView {
  id: string; // sound pack id, e.g. "de", "en_gb-ryan"
  language: string; // folder under SOUNDS/
  label: string; // "Standard" or the voice name
}

export interface SourceCheckView {
  repo: string;
  name: string;
  tag: string;
  sdDir?: string;
  files: number;
  sample: string[];
}

export interface FirmwareView {
  board: string;
  method?: 'uf2' | 'dfu'; // from the newest downloaded firmware
  installed?: string; // last seen on the card
  versions: string[]; // downloaded, newest first; release candidates only when switched on
  prereleases: string[]; // which of them are release candidates
  names: Record<string, string>; // tag -> release title, e.g. 'EdgeTX "Queen Anne's Revenge" v2.12.5'; missing for older downloads
  includePrereleases: boolean;
  dfuUtil?: boolean; // DFU only: dfu-util installed
}

// Releases on GitHub with a file for the radio that are not downloaded yet; flashing one downloads it first.
export interface FirmwareCatalogView {
  versions: { tag: string; name?: string; prerelease?: boolean }[];
}

// A firmware file the user chose, checked against the radio; without board it has no EdgeTX identification.
export interface FirmwareFileView {
  name: string;
  size: number;
  method: 'uf2' | 'dfu';
  board?: string;
  version?: string;
}

export interface FlashResultView {
  method: 'uf2' | 'dfu';
  file: string;
  version?: string; // the EdgeTX version now on the radio, when known
}

export interface DownloadResultView {
  source: string;
  status: 'new' | 'current' | 'no-release' | 'skipped' | 'error';
  tag?: string;
  files: string[];
  message?: string;
  error?: ErrorInfo;
}

// How a radio gets ready for flashing; the trim combo is BOOTLOADER_KEYS in EdgeTX.
export const FLASH_STEPS: Record<'uf2' | 'dfu', string[]> = {
  uf2: [
    'Switch the radio off and unplug the USB cable.',
    'Hold both horizontal trims towards the middle and switch the radio on: the bootloader starts.',
    'Connect the USB cable. The radio shows up as a drive and gets the firmware.',
  ],
  dfu: [
    'Switch the radio off.',
    'Connect the USB cable while the radio stays off: it starts in DFU mode, the screen stays dark.',
    'The firmware is written over USB; the radio restarts when done.',
  ],
};
