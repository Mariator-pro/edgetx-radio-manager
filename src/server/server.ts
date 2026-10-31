import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { applyPlan, type Resolution } from '../core/apply.ts';
import { backupCard, deleteBackup, isBackupName, listBackups, pruneBackups } from '../core/backup.ts';
import { findCards, readCard, type RadioCard } from '../core/card.ts';
import { diffModels } from '../core/modeldiff.ts';
import {
  applyCopy,
  applyDelete,
  backupModels,
  backupOrigin,
  doesntFit,
  exportName,
  modelImage,
  planCopy,
  planDelete,
  readCardState,
  readImport,
  sameNamed,
  type CopyRequest,
  type ImportedFile,
  type ModelCache,
  type ModelFile,
  type ModelOrigin,
} from '../core/models.ts';
import { downloadAll, downloadMain, downloadSource, downloadTag, soundPackPattern, type DownloadEvent } from '../core/download.ts';
import { AppError, errorInfo, type ErrorArgs, type ErrorCode } from '../core/errors.ts';
import {
  checkFirmwareFile,
  dfuUtilAvailable,
  firmwareCatalog,
  flashFile,
  flashFirmware,
  knownMethod,
  type CatalogEntry,
  type FirmwareFileCheck,
  type FlashOptions,
} from '../core/firmware.ts';
import { deleteVersion, localVersions, mainInfo, versionDir } from '../core/packages.ts';
import { isSafeKey, isSafeName, type Paths } from '../core/paths.ts';
import { isBelowMin, MIN_EDGETX, radioName, radioTypes } from '../core/radios.ts';
import { applyRestore, planRestore } from '../core/restore.ts';
import { ensureSelection } from '../core/selection.ts';
import {
  findLocalRepos,
  forgetBackups,
  loadSettings,
  MAX_NOTE,
  rememberRadio,
  saveSettings,
  setBackupNote,
  soundsOf,
  voiceLanguage,
  type BackupInfo,
  type Settings,
} from '../core/settings.ts';
import { addSource, checkSource, removeSource } from '../core/sources.ts';
import { prepareUpdate } from '../core/update.ts';
import { listVolumes } from '../platform/volumes.ts';
import {
  TOKEN_HASH,
  TOKEN_HEADER,
  withPageData,
  type AppUpdateView,
  type FirmwareCatalogView,
  type FirmwareFileView,
  type FirmwareView,
  type FlashResultView,
  type ImportView,
  type ModelRef,
  type ModelsResultView,
  type LicensesView,
  type PrefsView,
  type ProgressEvent,
  type RestoreResultView,
  type SourceCheckView,
  type UpdateResultView,
} from './api.ts';
import {
  backupViews,
  copyItemView,
  modelsPlanView,
  modelsView,
  packageViews,
  planView,
  restorePlanView,
  stateView,
  voiceViews,
} from './views.ts';

export interface ServerOptions {
  paths: Paths;
  port: number;
  staticDir?: string; // built interface; without it only /api is served (Vite serves the page)
  licensesFile?: string; // THIRD_PARTY_LICENSES.txt from the build, shown under About
  repoParent?: string; // where the own projects' checkouts are looked for; without it none are looked for
  pollMs?: number;
  appUpdates?: AppUpdates; // desktop app only
}

// The desktop app's own updates: the newer release found, and installing it where the app can do that itself.
export interface AppUpdates {
  view: () => AppUpdateView | undefined;
  onChange: (fn: () => void) => void;
  install: (onProgress: (pct: number) => void) => Promise<void>;
}

class HttpError<C extends ErrorCode> extends AppError<C> {
  status: number;
  constructor(status: number, code: C, ...args: ErrorArgs<C>) {
    super(code, ...args);
    this.status = status;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

// The page loads only its own files, and no other site may show it in a frame of its own, where it
// could be clicked unseen.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// The names this computer's browser reaches the server by, on any port (Vite forwards from its own).
const LOCAL_NAMES = ['localhost', '127.0.0.1'];

// The name in a Host header, without the port; empty when there is none or it cannot be read.
function hostName(host: string | undefined): string {
  try {
    return host ? new URL(`http://${host}`).hostname : '';
  } catch {
    return '';
  }
}

// A JSON request; the page sends a few KB at most.
const MAX_BODY = 1024 * 1024;

async function body<T>(req: IncomingMessage): Promise<T> {
  const data = await rawBody(req, MAX_BODY);
  try {
    return (data.length ? JSON.parse(data.toString('utf8')) : {}) as T;
  } catch {
    throw new HttpError(400, 'invalidRequest', { what: 'JSON' });
  }
}

const CATALOG_MS = 10 * 60_000;

// A firmware file at most; firmware is a few MB.
const MAX_UPLOAD = 32 * 1024 * 1024;
// An imported model file; a whole radio as .etx is well below.
const MAX_IMPORT = 8 * 1024 * 1024;

async function rawBody(req: IncomingMessage, max = MAX_UPLOAD): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'invalidRequest', { what: 'file too large' });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

// A file instead of JSON: a model picture, an exported model.
class FileAnswer {
  data: Buffer;
  type: string;
  download?: string; // file name to save it under
  constructor(data: Buffer, type: string, download?: string) {
    this.data = data;
    this.type = type;
    this.download = download;
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data ?? null));
}

// One call at a time; a forced call while one runs is made up for right after it instead of dropped.
export function oneAtATime(fn: (force: boolean) => Promise<void>): (force?: boolean) => Promise<void> {
  let running = false;
  let again = false;
  const call = async (force = false): Promise<void> => {
    if (running) {
      again ||= force;
      return;
    }
    running = true;
    try {
      await fn(force);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      await call(true);
    }
  };
  return call;
}

function openFolder(dir: string): void {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [dir], () => {});
}

export interface RunningServer {
  url: string;
  token: string;
  open: string; // the address to open the interface at, with the key behind # (never sent to the server)
  page: (html: string) => string; // the page with this start's key and the stored choices, for Vite in development only
  close: () => void;
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const p = o.paths;
  const token = randomBytes(24).toString('base64url');
  const s: Settings = await loadSettings(p);
  if (o.repoParent && findLocalRepos(s, o.repoParent)) await saveSettings(p, s);

  let cards: RadioCard[] = [];
  const boards = new Map<string, string>(); // volume -> type chosen for a card without radio.yml
  const clients = new Set<ServerResponse>();
  let busy: string | undefined;
  let abort: AbortController | undefined; // stops the running operation, where it can be stopped
  // the firmware file chosen last on the flash page, until it is flashed or another one is chosen
  let customFirmware: { board: string; name: string; data: Buffer; check: FirmwareFileCheck } | undefined;
  // the firmware releases on GitHub, asked for at most every 10 minutes: GitHub allows 60 requests an hour
  let catalog: { at: number; prereleases: boolean; entries: CatalogEntry[] } | undefined;
  // models of the backups, read once; model files imported on the models page, until closed or restarted
  const modelCache: ModelCache = new Map();
  const imports = new Map<string, ImportedFile>();

  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const progress = (e: ProgressEvent) => send('progress', e);
  const downloadProgress = (e: DownloadEvent) =>
    progress({
      op: 'download',
      text: e.type === 'file' ? `${e.source}: ${e.file}` : `Checking ${e.source}`,
      source: e.source,
      file: e.type === 'file' ? e.file : undefined,
    });
  const state = async () => {
    const appUpdate = o.appUpdates?.view();
    return { ...(await stateView(p, s, cards, boards, busy)), ...(appUpdate ? { appUpdate } : {}) };
  };
  const pushState = async () => send('state', await state());
  const boardOf = (c: RadioCard) => c.board ?? boards.get(c.volume);
  const ctxOf = (board: string) => ({ board, voices: soundsOf(s.radios[board]) });

  // Called for every newly seen card: note it and make sure it has a selection.
  const adopt = async (c: RadioCard) => {
    const board = boardOf(c);
    let changed = rememberRadio(s, c);
    if (board) changed = (await ensureSelection(p, s, board, c.volume, ctxOf(board))) || changed;
    if (changed) await saveSettings(p, s);
  };

  let lastKey = '';
  const poll = oneAtATime(async (force) => {
    const now = await findCards(await listVolumes());
    const key = JSON.stringify(now.map((c) => [c.volume, c.board, c.firmware, c.language, c.sdcardVersion, c.installed?.updated]));
    if (key === lastKey && !force) return;
    lastKey = key;
    cards = now;
    for (const c of cards) await adopt(c);
    await pushState();
  });

  // One long operation at a time; the state shows which one runs.
  const op = async <T>(name: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, 'busy', { op: busy });
    busy = name;
    abort = new AbortController();
    await pushState();
    try {
      return await fn(abort.signal);
    } finally {
      busy = undefined;
      abort = undefined;
      await poll(true);
    }
  };

  const cardAt = async (volume: string): Promise<[RadioCard, string]> => {
    const c = cards.find((x) => x.volume === volume) ? await readCard(volume) : undefined;
    if (!c) throw new HttpError(404, 'radioNotConnected');
    const board = boardOf(c);
    if (!board) throw new HttpError(400, 'chooseRadioType');
    return [c, board];
  };

  // A backup goes back only onto a radio of its own type.
  const restoreCardAt = async (volume: string, board: string): Promise<RadioCard> => {
    const [c, connected] = await cardAt(volume);
    if (connected !== board) {
      const types = await radioTypes(p, s);
      throw new HttpError(400, 'wrongRadioForBackup', { connected: radioName(types, connected), board: radioName(types, board) });
    }
    return c;
  };

  // a later backup can get the name of a deleted one, so its models are read again
  const dropBackups = (board: string, names: string[]) => {
    forgetBackups(s, board, names);
    for (const n of names) modelCache.delete(join(p.backups, board, n));
  };

  // info: why the backup is made; alsoKeep: the backup being restored, which the clean-up must not delete
  const runBackup = async (c: RadioCard, board: string, info: BackupInfo, alsoKeep?: string, signal?: AbortSignal) => {
    let shown = -1;
    const r = await backupCard(
      c.volume,
      board,
      p,
      new Date(),
      (pr) => {
        const pct = pr.bytesTotal > 0 ? Math.floor((pr.bytesDone / pr.bytesTotal) * 100) : 100;
        if (pct !== shown) progress({ op: busy ?? 'backup', step: 'backup', text: pr.file, done: (shown = pct), total: 100 });
      },
      signal,
    );
    (s.backupInfo[board] ??= {})[r.name] = info;
    dropBackups(board, await pruneBackups(p, board, s.backupsToKeep, [...(s.keptBackups[board] ?? []), ...(alsoKeep ? [alsoKeep] : [])]));
    await saveSettings(p, s);
    return r;
  };

  // A model and where its image, checklist and scripts come from.
  const resolveModel = async (ref: ModelRef): Promise<{ model: ModelFile; origin: ModelOrigin; board?: string }> => {
    if ('import' in ref) {
      const f = imports.get(ref.import);
      if (!f) throw new HttpError(404, 'importGone');
      const model = f.models.find((m) => m.file === ref.file);
      if (!model) throw new HttpError(404, 'modelNotFound', { name: ref.file || f.name });
      return { model, origin: f.origin, board: f.board };
    }
    if (!isSafeName(ref.board) || !isBackupName(ref.backup)) throw new HttpError(400, 'invalidRequest', { what: 'backup' });
    const origin = await backupOrigin(p, ref.board, ref.backup);
    const model = (await backupModels(p, ref.board, ref.backup, modelCache)).find((m) => m.file === ref.file);
    if (!model) throw new HttpError(404, 'modelNotFound', { name: ref.file });
    return { model, origin, board: ref.board };
  };

  type ModelsBody = { volume: string; copy?: { ref: ModelRef; mode?: 'replace' | 'add' }[]; delete?: string[] };

  const modelsPlan = async ({ volume, copy = [], delete: del = [] }: ModelsBody) => {
    const [c, board] = await cardAt(volume);
    const card = await readCardState(c.volume);
    const requests: CopyRequest[] = [];
    for (const r of copy) requests.push({ ...(await resolveModel(r.ref)), ...(r.mode ? { mode: r.mode } : {}) });
    const items = await planCopy(card, requests, await radioTypes(p, s));
    const deletes = await planDelete(card, del);
    return { c, board, items, deletes, refs: copy.map((r) => r.ref) };
  };

  const firmwareView = async (board: string): Promise<FirmwareView> => {
    const all = await localVersions(p, 'edgetx-firmware', !!s.firmwarePrereleases);
    const method = await knownMethod(p, all, board);
    const view: FirmwareView = {
      board,
      method,
      installed: s.radios[board]?.firmware,
      versions: all.map((v) => v.tag),
      prereleases: all.filter((v) => v.prerelease).map((v) => v.tag),
      names: Object.fromEntries(all.filter((v) => v.name).map((v) => [v.tag, v.name!])),
      includePrereleases: !!s.firmwarePrereleases,
    };
    if (method === 'dfu') view.dfuUtil = await dfuUtilAvailable();
    return view;
  };

  const flashWith = async (fn: (o: FlashOptions) => Promise<FlashResultView>): Promise<FlashResultView> =>
    op('flash', (signal) =>
      fn({
        volumes: listVolumes,
        signal,
        onProgress: (pr) =>
          progress({ op: 'flash', step: pr.step === 'waiting' ? 'waiting' : 'flash', text: pr.text, file: pr.file, done: pr.pct, total: 100 }),
      }),
    );

  const routes: Record<string, (req: IncomingMessage, q: URLSearchParams) => Promise<unknown>> = {
    'GET /api/state': state,
    'GET /api/boards': async () => (await radioTypes(p, s)).map((r) => ({ board: r.board, name: r.name })),
    'POST /api/radio/board': async (req) => {
      const { volume, board } = await body<{ volume: string; board: string }>(req);
      if (!(await radioTypes(p, s)).some((r) => r.board === board)) throw new HttpError(400, 'unknownRadioType', { board });
      boards.set(volume, board);
      const c = cards.find((x) => x.volume === volume);
      if (c) await adopt(c);
      await pushState();
    },
    'POST /api/radio/selection': async (req) => {
      const { board, source, on, origin } = await body<{ board: string; source: string; on?: boolean; origin?: 'release' | 'main' | 'local' }>(req);
      const r = s.radios[board];
      const choice = r?.sources?.[source];
      const src = s.sources.find((x) => x.name === source);
      if (!r || !choice || !src) throw new HttpError(404, 'unknownRadioOrSource');
      const noMain = origin === 'main' && src.file && !src.file.repoPath;
      if (src.file && (origin === 'local' || noMain)) throw new HttpError(400, 'invalidRequest', { what: 'origin' });
      const save = async () => {
        if (on !== undefined && src.kind !== 'sdcard') choice.on = on;
        if (origin) choice.origin = origin;
        r.newSources = r.newSources?.filter((n) => n !== source);
        await saveSettings(p, s);
      };
      // Switching to main fetches the newest commit first when it isn't downloaded yet.
      if (origin === 'main' && src.kind === 'project' && !(await mainInfo(p, source))) {
        return op('download', async () => {
          const result = await downloadMain(p, src, fetch, downloadProgress);
          if (!result) throw new HttpError(404, 'noCommit', { repo: src.repo });
          await save();
        });
      }
      await save();
      await pushState();
    },
    'POST /api/radio/sounds': async (req) => {
      const { board, sounds } = await body<{ board: string; sounds: string[] }>(req);
      if (typeof board !== 'string' || !isSafeKey(board)) throw new HttpError(400, 'invalidRequest', { what: 'board' });
      if (!Array.isArray(sounds) || sounds.some((id) => !/^[a-z]{2,3}([_-][a-z0-9-]+)?$/i.test(id))) throw new HttpError(400, 'invalidRequest', { what: 'sounds' });
      const langs = sounds.map(voiceLanguage);
      if (new Set(langs).size !== langs.length) throw new HttpError(400, 'oneVoicePerLanguage');
      (s.radios[board] ??= {}).sounds = [...sounds].sort();
      await saveSettings(p, s);
      // a newly chosen voice is downloaded right away, so the next update has it
      const src = s.sources.find((x) => x.kind === 'sounds');
      const newest = src && (await localVersions(p, src.name))[0];
      const have = newest ? await readdir(versionDir(p, src.name, newest.tag)).catch(() => []) : [];
      if (src && sounds.some((v) => !have.some((n) => soundPackPattern(v).test(n)))) {
        return op('download', () => downloadSource(p, s, src, fetch, downloadProgress));
      }
      await pushState();
    },
    'GET /api/voices': async () => voiceViews(p, s),
    'POST /api/download': () =>
      op('download', async () => {
        const results = await downloadAll(p, s, fetch, downloadProgress);
        s.lastCheck = new Date().toISOString();
        await saveSettings(p, s);
        return results;
      }),
    'POST /api/backup': async (req) => {
      const { volume } = await body<{ volume: string }>(req);
      const [c, board] = await cardAt(volume);
      return op('backup', async () => (await runBackup(c, board, { reason: 'manual' })).name);
    },
    'POST /api/update/plan': async (req) => {
      const { volume } = await body<{ volume: string }>(req);
      const [c, board] = await cardAt(volume);
      const setup = await prepareUpdate(p, s, c, board);
      if (setup.selectionChanged) await saveSettings(p, s);
      return planView(p, volume, board, c, setup);
    },
    'POST /api/update/run': async (req) => {
      const { volume, resolutions } = await body<{ volume: string; resolutions: Record<string, Resolution> }>(req);
      const [c, board] = await cardAt(volume);
      if (c.firmware && isBelowMin(c.firmware)) throw new HttpError(400, 'firmwareTooOld', { version: c.firmware, min: MIN_EDGETX });
      return op('update', async (signal): Promise<UpdateResultView> => {
        const setup = await prepareUpdate(p, s, c, board);
        // cancelled: during the backup the card is untouched; while writing, the backup holds the state before
        const cancelled = (backup?: string) => (e: unknown) => {
          throw e instanceof AppError && e.code === 'cancelled' ? new AppError('updateCancelled', { backup }) : e;
        };
        const b = await runBackup(c, board, { reason: 'update', changes: setup.changes }, undefined, signal).catch(cancelled());
        const r = await applyPlan(
          c.volume,
          setup,
          new Map(Object.entries(resolutions ?? {})),
          (pr) => progress({ op: 'update', step: 'write', text: pr.path, done: pr.done, total: pr.total }),
          signal,
        ).catch(cancelled(b.name));
        return { ...r, backup: b.name };
      });
    },
    'POST /api/restore/plan': async (req) => {
      const { volume, board, name } = await body<{ volume: string; board: string; name: string }>(req);
      const c = await restoreCardAt(volume, board);
      return restorePlanView(p, c, board, name, await planRestore(c.volume, p, board, name));
    },
    'POST /api/restore/run': async (req) => {
      const { volume, board, name, backupFirst } = await body<{ volume: string; board: string; name: string; backupFirst: boolean }>(req);
      const c = await restoreCardAt(volume, board);
      return op('restore', async (): Promise<RestoreResultView> => {
        const plan = await planRestore(c.volume, p, board, name);
        const b = backupFirst ? await runBackup(c, board, { reason: 'restore', restoredFrom: name }, name) : undefined;
        const r = await applyRestore(c.volume, plan, (pr) =>
          progress({ op: 'restore', step: 'write', text: pr.path, done: pr.done, total: pr.total }),
        );
        return { ...r, backup: b?.name };
      });
    },
    'GET /api/models': async (_req, q) => {
      const board = q.get('board') ?? '';
      if (board && !isSafeName(board)) throw new HttpError(400, 'invalidRequest', { what: 'board' });
      const volume = q.get('volume');
      const c = volume ? cards.find((x) => x.volume === volume) : undefined;
      return modelsView(p, s, board, c && { volume: c.volume, board: boardOf(c) }, modelCache);
    },
    'GET /api/models/image': async (_req, q) => {
      const img = await modelImage(p, q.get('board') ?? '', q.get('backup') ?? '', q.get('file') ?? '');
      return new FileAnswer(img.data, img.type);
    },
    'GET /api/models/export': async (_req, q) => {
      const { model } = await resolveModel({ board: q.get('board') ?? '', backup: q.get('backup') ?? '', file: q.get('file') ?? '' });
      return new FileAnswer(model.data, 'application/x-yaml', exportName(model));
    },
    'POST /api/models/import': async (req, q) => {
      const name = q.get('name') ?? '';
      if (!isSafeName(name)) throw new HttpError(400, 'invalidRequest', { what: 'file' });
      const f = await readImport(name, await rawBody(req, MAX_IMPORT));
      const id = randomBytes(9).toString('base64url');
      imports.set(id, f);
      // only the last few stay in memory
      for (const old of [...imports.keys()].slice(0, -5)) imports.delete(old);
      const view: ImportView = {
        id,
        name,
        ...(f.board ? { board: f.board, radio: radioName(await radioTypes(p, s), f.board) } : {}),
        models: f.models.map((m) => ({ name: m.name, file: m.file, ...(m.semver ? { semver: m.semver } : {}), labels: m.labels })),
      };
      return view;
    },
    'POST /api/models/import/close': async (req) => {
      const { id } = await body<{ id: string }>(req);
      imports.delete(id);
    },
    'POST /api/models/plan': async (req) => {
      const { c, board, items, deletes, refs } = await modelsPlan(await body<ModelsBody>(req));
      return modelsPlanView(p, c.volume, board, items.map((i, n) => copyItemView(i, refs[n]!)), deletes, items.some(doesntFit));
    },
    'POST /api/models/run': async (req) => {
      const b = await body<ModelsBody & { backupFirst: boolean; force?: boolean }>(req);
      const { c, board, items, deletes } = await modelsPlan(b);
      const misfits = items.filter(doesntFit);
      if (misfits.length > 0 && !b.force) throw new HttpError(400, 'modelsDontFit', { names: misfits.map((i) => i.name).join(', ') });
      return op('models', async (): Promise<ModelsResultView> => {
        const names = [...items.map((i) => i.name), ...deletes.map((d) => d.name)];
        const info: BackupInfo = items.length > 0 ? { reason: 'models', models: names } : { reason: 'deleteModels', models: names };
        const backup = b.backupFirst ? await runBackup(c, board, info) : undefined;
        const onProgress = (pr: { path: string; done: number; total: number }) =>
          progress({ op: 'models', step: 'write', text: pr.path, done: pr.done, total: pr.total });
        const copied = await applyCopy(c.volume, items, onProgress);
        const moved = await applyDelete(c.volume, deletes, onProgress);
        return { written: items.length > 0 ? copied.written : 0, moved: deletes.length > 0 ? moved.moved : 0, backup: backup?.name };
      });
    },
    'POST /api/models/diff': async (req) => {
      const { a, b, volume } = await body<{ a: ModelRef; b?: ModelRef; volume?: string }>(req);
      const left = (await resolveModel(a)).model;
      let right: ModelFile | undefined;
      if (b) right = (await resolveModel(b)).model;
      else {
        const c = cards.find((x) => x.volume === volume);
        if (!c) throw new HttpError(404, 'radioNotConnected');
        const card = await readCardState(c.volume);
        right = sameNamed(card.models, left.name, left.file);
        if (!right) throw new HttpError(404, 'modelNotFound', { name: left.name });
      }
      return diffModels(left.doc, right.doc);
    },
    'GET /api/firmware': (_req, q) => firmwareView(q.get('board') ?? ''),
    'GET /api/firmware/catalog': async (_req, q) => {
      const board = q.get('board') ?? '';
      const src = s.sources.find((x) => x.kind === 'firmware');
      const have = new Set((await localVersions(p, 'edgetx-firmware', true)).map((v) => v.tag));
      const prereleases = !!s.firmwarePrereleases;
      if (src && (!catalog || catalog.prereleases !== prereleases || Date.now() - catalog.at > CATALOG_MS)) {
        catalog = { at: Date.now(), prereleases, entries: await firmwareCatalog(p, src, fetch, prereleases) };
      }
      const entries = catalog?.entries ?? [];
      const view: FirmwareCatalogView = {
        versions: entries
          .filter((e) => e.boards.includes(board) && !have.has(e.tag))
          .map((e) => ({ tag: e.tag, ...(e.name ? { name: e.name } : {}), ...(e.prerelease ? { prerelease: true } : {}) })),
      };
      return view;
    },
    // Release candidates in the list or not; like any other version they are downloaded when flashed.
    'POST /api/firmware/prereleases': async (req) => {
      const { board, on } = await body<{ board: string; on: boolean }>(req);
      s.firmwarePrereleases = on;
      await saveSettings(p, s);
      return firmwareView(board);
    },
    'POST /api/firmware/file': async (req, q) => {
      const board = q.get('board') ?? '';
      const name = q.get('name') ?? '';
      if (!board || !isSafeName(name)) throw new HttpError(400, 'invalidRequest', { what: 'file' });
      customFirmware = undefined;
      const data = await rawBody(req);
      const check = checkFirmwareFile(name, data, board, (await firmwareView(board)).method);
      customFirmware = { board, name, data, check };
      const view: FirmwareFileView = { name, size: data.length, ...check };
      return view;
    },
    'POST /api/firmware/flash': async (req) => {
      const { board, tag, file, force } = await body<{ board: string; tag?: string; file?: boolean; force?: boolean }>(req);
      if (!file) {
        if (tag !== undefined && !isSafeName(tag)) throw new HttpError(400, 'invalidRequest', { what: 'tag' });
        return flashWith(async (fo) => {
          // a version from the catalog is downloaded first, and then stays like any other download
          const src = s.sources.find((x) => x.kind === 'firmware');
          if (tag && src && !(await localVersions(p, src.name, true)).some((v) => v.tag === tag)) {
            progress({ op: 'flash', step: 'download', text: `Downloading ${tag}`, file: tag });
            const r = await downloadTag(p, s, src, tag);
            if (r.status === 'no-release') throw new AppError('noRelease', { repo: `${src.repo} ${tag}` });
          }
          return { ...(await flashFirmware(p, board, tag ?? '', fo)), version: tag };
        });
      }
      const fw = customFirmware;
      if (!fw || fw.board !== board) throw new HttpError(400, 'invalidRequest', { what: 'file' });
      if (!fw.check.board && !force) throw new HttpError(400, 'unknownFirmwareFile', { file: fw.name });
      return flashWith(async (fo) => {
        const r = await flashFile(board, fw, fo);
        customFirmware = undefined;
        return { ...r, version: fw.check.version };
      });
    },
    'POST /api/cancel': async () => {
      abort?.abort();
    },
    'GET /api/packages': () => packageViews(p, s),
    'POST /api/packages/delete': async (req) => {
      const { name, tag } = await body<{ name: string; tag: string }>(req);
      await deleteVersion(p, s, name, tag);
    },
    'GET /api/backups': () => backupViews(p, s),
    'POST /api/backups/keep': async (req) => {
      const { board, name, keep } = await body<{ board: string; name: string; keep: boolean }>(req);
      if (typeof board !== 'string' || !isSafeKey(board) || !isBackupName(name)) throw new HttpError(400, 'invalidRequest', { what: 'backup' });
      const list = (s.keptBackups[board] ?? []).filter((n) => n !== name);
      s.keptBackups[board] = keep ? [...list, name] : list;
      await saveSettings(p, s);
    },
    'POST /api/backups/delete': async (req) => {
      const { board, name } = await body<{ board: string; name: string }>(req);
      if (typeof board !== 'string' || !isSafeKey(board)) throw new HttpError(400, 'invalidRequest', { what: 'backup' });
      await deleteBackup(p, board, name);
      s.keptBackups[board] = (s.keptBackups[board] ?? []).filter((n) => n !== name);
      dropBackups(board, [name]);
      await saveSettings(p, s);
      await pushState();
    },
    'POST /api/backups/note': async (req) => {
      const { board, name, note } = await body<{ board: string; name: string; note: string }>(req);
      if (!isSafeKey(board) || !isBackupName(name) || typeof note !== 'string' || note.trim().length > MAX_NOTE) {
        throw new HttpError(400, 'invalidRequest', { what: 'note' });
      }
      if (!(await listBackups(p, board)).includes(name)) throw new HttpError(404, 'backupNotFound', { name });
      setBackupNote(s, board, name, note);
      await saveSettings(p, s);
    },
    'GET /api/licenses': async (): Promise<LicensesView> => {
      const text = o.licensesFile ? await readFile(o.licensesFile, 'utf8').catch(() => undefined) : undefined;
      if (text === undefined) throw new HttpError(404, 'licensesMissing');
      return { text };
    },
    'POST /api/open-folder': async () => openFolder(p.root),
    'POST /api/backups/open': async (req) => {
      const { board, name } = await body<{ board?: string; name?: string }>(req);
      if ((board && !isSafeName(board)) || (name && !isSafeName(name))) throw new HttpError(400, 'invalidRequest', { what: 'backup' });
      openFolder(join(p.backups, ...(board ? [board] : []), ...(name ? [name] : [])));
    },
    'POST /api/sources/check': async (req) => {
      const { repo } = await body<{ repo: string }>(req);
      return op('source', async (): Promise<SourceCheckView> => {
        const r = await checkSource(p, s, repo.trim());
        return { repo: r.source.repo, name: r.source.name, tag: r.tag, sdDir: r.source.sdDir, files: r.files, sample: r.sample };
      });
    },
    'POST /api/sources/add': async (req) => {
      const v = await body<SourceCheckView & { board?: string }>(req);
      if (s.sources.some((x) => x.name === v.name)) throw new HttpError(400, 'alreadySource', { name: v.name });
      addSource(s, { name: v.name, repo: v.repo, kind: 'project', ...(v.sdDir ? { sdDir: v.sdDir } : {}) }, v.board);
      for (const c of cards) await adopt(c);
      await saveSettings(p, s);
      await pushState();
    },
    'POST /api/app-update': async () => {
      const u = o.appUpdates;
      if (!u?.view()?.installable) throw new HttpError(400, 'invalidRequest', { what: 'app update' });
      return op('appUpdate', () =>
        u.install((pct) => progress({ op: 'appUpdate', step: 'download', text: `App update ${pct} %`, done: pct, total: 100 })).catch((e: unknown) => {
          console.error(e);
          throw new AppError('appUpdateFailed');
        }),
      );
    },
    'POST /api/prefs': async (req) => {
      const { lang, theme } = await body<PrefsView>(req);
      if ((lang !== undefined && !/^[a-z]{2}$/.test(lang)) || (theme !== undefined && theme !== 'light' && theme !== 'dark')) {
        throw new HttpError(400, 'invalidRequest', { what: 'prefs' });
      }
      s.ui = { ...s.ui, ...(lang ? { lang } : {}), ...(theme ? { theme } : {}) };
      await saveSettings(p, s);
    },
    'POST /api/sources/remove': async (req) => {
      const { name } = await body<{ name: string }>(req);
      if (!removeSource(s, name)) throw new HttpError(400, 'onlyProjectsRemovable');
      await saveSettings(p, s);
      await pushState();
    },
  };

  const page = (html: string) => withPageData(html, s.ui ?? {}, token);

  const serveStatic = async (res: ServerResponse, urlPath: string) => {
    const root = o.staticDir!;
    let file = normalize(join(root, decodeURIComponent(urlPath)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(404, 'notFound');
    if (!(await stat(file).catch(() => undefined))?.isFile()) file = join(root, 'index.html');
    if (extname(file) !== '.html') {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
    // without the key, which comes behind # in the address: any program on this computer, also one of
    // another user, can fetch the page; never cached, it carries the stored choices
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    res.end(withPageData(await readFile(file, 'utf8'), s.ui ?? {}));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      // only under its own name: another site whose name was pointed at this computer (DNS rebinding)
      // would count as the same site to the browser and could read the key from the page
      if (!LOCAL_NAMES.includes(hostName(req.headers.host))) throw new HttpError(403, 'invalidRequest', { what: 'host' });
      if (url.pathname.startsWith('/api/') && (req.headers[TOKEN_HEADER] ?? url.searchParams.get('token')) !== token) {
        throw new HttpError(403, 'invalidRequest', { what: 'token' });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.write(`event: state\ndata: ${JSON.stringify(await state())}\n\n`);
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const answer = await route(req, url.searchParams);
        if (!(answer instanceof FileAnswer)) return json(res, answer);
        const headers: Record<string, string> = { 'Content-Type': answer.type, 'Cache-Control': 'no-store' };
        if (answer.download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(answer.download)}`;
        res.writeHead(200, headers);
        res.end(answer.data);
        return;
      }
      if (url.pathname.startsWith('/api/') || !o.staticDir) throw new HttpError(404, 'notFound');
      await serveStatic(res, url.pathname);
    } catch (e) {
      // coded errors are the user's to fix (400 unless said otherwise), anything else is a bug
      const status = e instanceof HttpError ? e.status : e instanceof AppError ? 400 : 500;
      const { message, ...coded } = errorInfo(e);
      json(res, { error: message, ...coded }, status);
    }
  });

  o.appUpdates?.onChange(() => void pushState());
  await poll(true);
  const timer = setInterval(() => void poll().catch(() => {}), o.pollMs ?? 2000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://localhost:${typeof address === 'object' && address ? address.port : o.port}`;
  return {
    url,
    token,
    open: `${url}/#${TOKEN_HASH}=${token}`,
    page,
    close: () => {
      clearInterval(timer);
      for (const c of clients) c.end();
      server.close();
    },
  };
}
