import type { ErrorInfo } from '../core/errors.ts';
import type { DiffArea } from '../core/modeldiff.ts';

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

// A newer release of the desktop app.
export interface AppUpdateView {
  version: string; // without "v"
  url: string; // its release page
  installable: boolean; // the app installs it itself (Windows, Linux); macOS only links to the download
  restarting?: boolean; // downloaded, the app is about to restart into it
}

export interface StateView {
  radios: RadioView[];
  sources: SourceView[];
  busy?: string;
  lastCheck?: string;
  backupsToKeep: number;
  appUpdate?: AppUpdateView;
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

export interface ModelVersionView {
  file: string;
  backup: string; // newest backup with this content
  since: string; // oldest backup with this content
  semver?: string;
  bitmap?: string;
  labels: string[];
}

export interface ModelEntryView {
  name: string;
  file?: string; // set when a backup has two models of this name
  versions: ModelVersionView[]; // newest first
  card?: 'same' | 'changed' | 'missing'; // compared with the connected card
  cardVersion?: number; // the version the card's model equals
}

export interface CardModelView {
  name: string;
  file: string;
  semver?: string;
  labels: string[];
}

export interface ModelsView {
  board: string;
  radio: string;
  boards: { board: string; radio: string }[]; // radios with backups
  entries: ModelEntryView[];
  card?: { volume: string; board?: string; radio: string; models: CardModelView[] }; // the connected radio
  onlyOnCard: CardModelView[]; // on the card of this radio type, in no backup
}

// A model in a backup, or in a file imported for the moment.
export type ModelRef = { board: string; backup: string; file: string } | { import: string; file: string };

export interface ImportView {
  id: string;
  name: string; // the file name
  board?: string; // .etx: the radio it is from
  radio?: string;
  models: CardModelView[];
}

export type FileAction = 'add' | 'replace';

export interface CopyItemView {
  name: string;
  ref: ModelRef;
  mode: 'replace' | 'add';
  canReplace: boolean;
  target: string;
  image?: { path: string; action: FileAction };
  checklist?: { path: string; action: FileAction };
  missing: { path: string; pkg?: string }[];
  controls: string[];
  module?: { model: string; radio?: string };
  screen?: { model: string; radio: string };
  newer?: { model: string; radio: string };
  receiver?: { id: number; models: string[] };
}

export interface DeleteItemView {
  name: string;
  file: string;
  moves: string[];
  active: boolean;
}

export interface ModelsPlanView {
  volume: string;
  board: string;
  copy: CopyItemView[];
  delete: DeleteItemView[];
  confirm: boolean; // some models don't fully fit the radio: "Copy anyway" first
  backupDir: string;
}

export interface ModelsResultView {
  written: number;
  moved: number;
  backup?: string;
}

export type { DiffArea };

export interface DiffGroupView {
  area: DiffArea;
  entries: { path: string; from?: string; to?: string }[];
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
  reason?: 'manual' | 'update' | 'restore' | 'models' | 'deleteModels'; // only backups made since the tool notes it
  changes?: PackageChangeView[]; // update: what it changed
  restoredFrom?: string; // restore: the backup put back afterwards
  models?: string[]; // models, deleteModels: the models copied or deleted
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
    'Turn off the radio and unplug the USB cable.',
    'Hold both horizontal trims toward the center and turn on the radio. The bootloader starts.',
    'Connect the USB cable. The radio shows up as a drive, and the app writes the firmware to it.',
  ],
  dfu: [
    'Turn off the radio.',
    'Connect the USB cable while the radio stays off. It starts in DFU mode, and the screen stays dark.',
    'The app writes the firmware over USB, then the radio restarts.',
  ],
};

// A key made for each start of the server: the page gets it, other web pages in the browser don't,
// so they can't use the API. Sent as a header, by the live connection and pictures (no headers there) in the address.
// The page gets it behind # in the address it is opened at, which the browser never sends to the server;
// under Vite in development it is put into the page.
export const TOKEN_HEADER = 'x-radio-manager-token';
export const TOKEN_HASH = 'token';
export const TOKEN_META = 'radio-manager-token';

// Language and theme, kept by the server: the port changes with every start, and the browser keeps
// what a page stores per port, so it would forget them.
export interface PrefsView {
  lang?: string;
  theme?: 'light' | 'dark';
}
export const PREFS_META = 'radio-manager-prefs';

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The page gets the stored choices, so it starts with them, and under Vite the key.
export const withPageData = (html: string, prefs: PrefsView, token?: string) =>
  html.replace(
    '</head>',
    `${token ? `<meta name="${TOKEN_META}" content="${token}" />\n` : ''}<meta name="${PREFS_META}" content="${attr(JSON.stringify(prefs))}" />\n</head>`,
  );
