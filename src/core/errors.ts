// Errors the interface translates: a code with its values. The English text here is what the
// CLI prints and what the interface shows in English.
export const ERRORS = {
  busy: (p: { op: string }) => `Another task is still running (${p.op}). Try again when it’s done.`,
  notFound: () => 'Not found.',
  invalidRequest: (p: { what: string }) => `The request isn’t valid: ${p.what}`,
  noConnection: () => 'Can’t reach GitHub. Check your internet connection.',
  rateLimit: (p: { reset?: string } = {}) =>
    p.reset
      ? `GitHub takes no more requests for now. Try again after ${new Date(p.reset).toTimeString().slice(0, 5)}.`
      : 'GitHub takes no more requests for now. Try again later.',
  githubStatus: (p: { status: number }) => `GitHub responded with error ${p.status}. Try again later.`,
  downloadFailed: (p: { status: number; url: string }) => `Couldn’t download ${p.url} (error ${p.status}).`,

  radioNotConnected: () => 'The radio is no longer connected.',
  chooseRadioType: () => 'Choose the radio type first.',
  unknownRadioType: (p: { board: string }) => `Unknown radio type: ${p.board}`,
  unknownRadioOrSource: () => 'Unknown radio or source.',
  oneVoicePerLanguage: () => 'Choose only one voice per language.',
  firmwareTooOld: (p: { version: string; min: string }) => `EdgeTX ${p.version} is older than ${p.min}. Flash the firmware first.`,

  backupNotFound: (p: { name: string }) => `Can’t find the backup ${p.name}.`,
  wrongRadioForBackup: (p: { connected: string; board: string }) => `The connected radio is a ${p.connected}, but the backup is from a ${p.board}.`,
  restoreInterrupted: () => 'The SD card was disconnected during the restore. Connect it again and restore the backup once more.',

  modelNotFound: (p: { name: string }) => `Can’t find the model ${p.name}.`,
  notModelFile: (p: { file: string }) => `${p.file} isn’t a model file (.yml or .etx).`,
  importGone: () => 'The imported file isn’t loaded any more. Choose it again.',
  modelsDontFit: (p: { names: string }) => `Some models don’t fully fit this radio (${p.names}). To copy them anyway, choose “Copy anyway”.`,
  modelsInterrupted: (p: { done: string }) =>
    `The SD card was disconnected while the models were being written${p.done ? ` (done: ${p.done})` : ''}. Connect it again and start once more.`,

  repoFormat: () => 'Enter the repo as owner/name.',
  alreadySource: (p: { name: string }) => `${p.name} is already a source.`,
  noRelease: (p: { repo: string }) => `${p.repo} has no release yet.`,
  noCommit: (p: { repo: string }) => `${p.repo} has no commit yet.`,
  noSdFolder: (p: { repo: string; tag: string }) => `${p.repo} ${p.tag} has no SCRIPTS/ or WIDGETS/ folder.`,
  onlyProjectsRemovable: () => 'You can only remove project sources.',
  installedOn: (p: { name: string; tag: string; radios: string }) => `${p.name} ${p.tag} is installed on ${p.radios}, so you can’t delete it.`,

  firmwareNotDownloaded: (p: { tag: string }) => `Firmware ${p.tag} isn’t downloaded yet.`,
  noFirmwareFor: (p: { board: string; tag: string }) => `EdgeTX ${p.tag} has no firmware for ${p.board}.`,
  notFirmwareFile: (p: { file: string }) => `${p.file} isn’t a firmware file (.uf2 or .bin).`,
  wrongFirmwareType: (p: { file: string; ext: string }) => `${p.file} doesn’t fit this radio. It needs ${p.ext} files.`,
  wrongFirmwareBoard: (p: { file: string; fileBoard: string; board: string }) => `${p.file} is built for ${p.fileBoard}, not for ${p.board}.`,
  unknownFirmwareFile: (p: { file: string }) => `${p.file} has no EdgeTX identification. To flash it anyway, choose “Flash anyway”.`,
  wrongRadio: (p: { connected: string; board: string }) => `The connected radio is a ${p.connected}, but the firmware is for ${p.board}.`,
  dfuUtilMissing: () => 'dfu-util isn’t installed. On macOS, install it with “brew install dfu-util”.',
  noDfuRadio: () => 'Can’t find a radio in DFU mode.',
  severalDfu: () => 'More than one device is in DFU mode. Connect only the radio.',
  dfuFailed: (p: { detail: string }) => `dfu-util failed: ${p.detail}`,
  cancelled: () => 'Cancelled.',
  updateCancelled: (p: { backup?: string }) =>
    p.backup
      ? `SD update cancelled. The files written so far stay on the SD card. Backup ${p.backup} holds the state from before.`
      : 'SD update cancelled during the backup. Nothing on the SD card changed.',
  radioTimeout: () => 'The radio didn’t show up in time. Check the steps and try again.',

  appUpdateFailed: () => 'Couldn’t download the app update. Check your internet connection and try again.',
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
