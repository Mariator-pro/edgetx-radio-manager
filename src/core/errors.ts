// Errors the interface translates: a code with its values. The English text here is what the
// CLI prints and what the interface shows in English.
export const ERRORS = {
  busy: (p: { op: string }) => `Please wait, another operation is still running (${p.op})`,
  notFound: () => 'Not found',
  invalidRequest: (p: { what: string }) => `Invalid request: ${p.what}`,
  noConnection: () => 'No connection to GitHub. Check the internet connection.',
  rateLimit: (p: { reset?: string } = {}) =>
    p.reset ? `GitHub rate limit reached, try again after ${new Date(p.reset).toTimeString().slice(0, 5)}` : 'GitHub rate limit reached, try again later',
  githubStatus: (p: { status: number }) => `GitHub answered ${p.status}`,
  downloadFailed: (p: { status: number; url: string }) => `Download failed (${p.status}): ${p.url}`,

  radioNotConnected: () => 'Radio not connected',
  chooseRadioType: () => 'Choose the radio type first',
  unknownRadioType: (p: { board: string }) => `Unknown radio type: ${p.board}`,
  unknownRadioOrSource: () => 'Unknown radio or source',
  oneVoicePerLanguage: () => 'Only one voice per language',
  firmwareTooOld: (p: { version: string; min: string }) => `EdgeTX ${p.version} is below ${p.min}. Flash the firmware first.`,

  backupNotFound: (p: { name: string }) => `Backup ${p.name} not found`,
  wrongRadioForBackup: (p: { connected: string; board: string }) => `The connected radio is a ${p.connected}, the backup is from a ${p.board}`,
  restoreInterrupted: () => 'The SD card was removed during the restore. Connect it again and restore once more.',

  modelNotFound: (p: { name: string }) => `Model ${p.name} not found`,
  notModelFile: (p: { file: string }) => `${p.file} is not a model file (.yml or .etx)`,
  importGone: () => 'The imported file is no longer loaded. Choose it again.',
  modelsDontFit: (p: { names: string }) => `Not everything fits this radio (${p.names}); confirm to copy anyway`,
  modelsInterrupted: (p: { done: string }) =>
    `The SD card was removed while writing the models${p.done ? ` (done: ${p.done})` : ''}. Connect it again and start once more.`,

  repoFormat: () => 'Enter the repo as owner/name',
  alreadySource: (p: { name: string }) => `${p.name} is already a source`,
  noRelease: (p: { repo: string }) => `${p.repo} has no release`,
  noCommit: (p: { repo: string }) => `${p.repo} has no commit yet`,
  noSdFolder: (p: { repo: string; tag: string }) => `No SCRIPTS/ or WIDGETS/ folder found in ${p.repo} ${p.tag}`,
  onlyProjectsRemovable: () => 'Only project sources can be removed',
  installedOn: (p: { name: string; tag: string; radios: string }) => `${p.name} ${p.tag} is installed on ${p.radios}`,

  firmwareNotDownloaded: (p: { tag: string }) => `Firmware ${p.tag} is not downloaded`,
  noFirmwareFor: (p: { board: string; tag: string }) => `No firmware for ${p.board} in ${p.tag}`,
  notFirmwareFile: (p: { file: string }) => `${p.file} is not a firmware file (.uf2 or .bin)`,
  wrongFirmwareType: (p: { file: string; ext: string }) => `${p.file} does not fit this radio, it takes ${p.ext} files`,
  wrongFirmwareBoard: (p: { file: string; fileBoard: string; board: string }) => `${p.file} is built for ${p.fileBoard}, not for ${p.board}`,
  unknownFirmwareFile: (p: { file: string }) => `${p.file} has no EdgeTX identification; confirm to flash it anyway`,
  wrongRadio: (p: { connected: string; board: string }) => `The connected radio is a ${p.connected}, the firmware is for ${p.board}`,
  dfuUtilMissing: () => 'dfu-util is not installed (macOS: brew install dfu-util)',
  noDfuRadio: () => 'No radio in DFU mode found',
  severalDfu: () => 'More than one DFU device found',
  dfuFailed: (p: { detail: string }) => `dfu-util failed: ${p.detail}`,
  cancelled: () => 'Cancelled',
  radioTimeout: () => 'The radio did not show up in time',

  appUpdateFailed: () => 'The app update could not be downloaded. Check the internet connection and try again.',
};

export type ErrorCode = keyof typeof ERRORS;
export type ErrorArgs<C extends ErrorCode> = Parameters<(typeof ERRORS)[C]>;

export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  code: C;
  params?: ErrorArgs<C>[0];
  constructor(code: C, ...args: ErrorArgs<C>) {
    super((ERRORS[code] as (...a: ErrorArgs<C>) => string)(...args));
    this.code = code;
    this.params = args[0];
  }
}

// How an error travels to the interface: the English text, and the code when there is one.
export interface ErrorInfo {
  message: string;
  code?: ErrorCode;
  params?: unknown;
}

export function errorInfo(e: unknown): ErrorInfo {
  const message = e instanceof Error ? e.message : String(e);
  return e instanceof AppError ? { message, code: e.code, params: e.params } : { message };
}
