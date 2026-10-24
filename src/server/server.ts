import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { applyPlan, type Resolution } from '../core/apply.ts';
import { backupCard, deleteBackup, isBackupName, listBackups, pruneBackups } from '../core/backup.ts';
import { findCards, readCard, type RadioCard } from '../core/card.ts';
import { downloadAll, downloadMain, downloadSource, downloadTag, soundPackPattern, type DownloadEvent } from '../core/download.ts';
import { AppError, errorInfo, type ErrorArgs, type ErrorCode } from '../core/errors.ts';
import {
  checkFirmwareFile,
  dfuUtilAvailable,
  firmwareCatalog,
  flashFile,
  flashFirmware,
  flashMethod,
  type CatalogEntry,
  type FirmwareFileCheck,
  type FlashOptions,
} from '../core/firmware.ts';
import { deleteVersion, localVersions, mainInfo, versionDir } from '../core/packages.ts';
import { isSafeName, type Paths } from '../core/paths.ts';
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
import type { FirmwareCatalogView, FirmwareFileView, FirmwareView, FlashResultView, ProgressEvent, RestoreResultView, SourceCheckView, UpdateResultView } from './api.ts';
import { backupViews, packageViews, planView, restorePlanView, stateView, voiceViews } from './views.ts';

export interface ServerOptions {
  paths: Paths;
  port: number;
  staticDir?: string; // built interface; without it only /api is served (Vite serves the page)
  repoParent?: string; // where the own projects' checkouts are looked for; without it none are looked for
  pollMs?: number;
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

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T;
}

const CATALOG_MS = 10 * 60_000;

// A firmware file at most; firmware is a few MB.
const MAX_UPLOAD = 32 * 1024 * 1024;

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_UPLOAD) throw new HttpError(413, 'invalidRequest', { what: 'file too large' });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data ?? null));
}

function openFolder(dir: string): void {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [dir], () => {});
}

export async function startServer(o: ServerOptions): Promise<{ url: string; close: () => void }> {
  const p = o.paths;
  const s: Settings = await loadSettings(p);
  if (o.repoParent && findLocalRepos(s, o.repoParent)) await saveSettings(p, s);

  let cards: RadioCard[] = [];
  const boards = new Map<string, string>(); // volume -> type chosen for a card without radio.yml
  const clients = new Set<ServerResponse>();
  let busy: string | undefined;
  let flashAbort: AbortController | undefined;
  // the firmware file chosen last on the flash page, until it is flashed or another one is chosen
  let customFirmware: { board: string; name: string; data: Buffer; check: FirmwareFileCheck } | undefined;
  // the firmware releases on GitHub, asked for at most every 10 minutes: GitHub allows 60 requests an hour
  let catalog: { at: number; prereleases: boolean; entries: CatalogEntry[] } | undefined;

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
  const pushState = async () => send('state', await stateView(p, s, cards, boards, busy));
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
  let polling = false;
  const poll = async (force = false) => {
    if (polling) return;
    polling = true;
    try {
      const now = await findCards(await listVolumes());
      const key = JSON.stringify(now.map((c) => [c.volume, c.board, c.firmware, c.language, c.sdcardVersion, c.installed?.updated]));
      if (key === lastKey && !force) return;
      lastKey = key;
      cards = now;
      for (const c of cards) await adopt(c);
      await pushState();
    } finally {
      polling = false;
    }
  };

  // One long operation at a time; the state shows which one runs.
  const op = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, 'busy', { op: busy });
    busy = name;
    await pushState();
    try {
      return await fn();
    } finally {
      busy = undefined;
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

  // info: why the backup is made; alsoKeep: the backup being restored, which the clean-up must not delete
  const runBackup = async (c: RadioCard, board: string, info: BackupInfo, alsoKeep?: string) => {
    let shown = -1;
    const r = await backupCard(c.volume, board, p, new Date(), (pr) => {
      const pct = pr.bytesTotal > 0 ? Math.floor((pr.bytesDone / pr.bytesTotal) * 100) : 100;
      if (pct !== shown) progress({ op: busy ?? 'backup', step: 'backup', text: pr.file, done: (shown = pct), total: 100 });
    });
    (s.backupInfo[board] ??= {})[r.name] = info;
    forgetBackups(s, board, await pruneBackups(p, board, s.backupsToKeep, [...(s.keptBackups[board] ?? []), ...(alsoKeep ? [alsoKeep] : [])]));
    await saveSettings(p, s);
    return r;
  };

  const firmwareView = async (board: string): Promise<FirmwareView> => {
    const all = await localVersions(p, 'edgetx-firmware', !!s.firmwarePrereleases);
    const stable = all.find((v) => !v.prerelease)?.tag;
    const method = stable ? await flashMethod(p, stable, board) : undefined;
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
    op('flash', async () => {
      flashAbort = new AbortController();
      try {
        return await fn({
          volumes: listVolumes,
          signal: flashAbort.signal,
          onProgress: (pr) =>
            progress({ op: 'flash', step: pr.step === 'waiting' ? 'waiting' : 'flash', text: pr.text, file: pr.file, done: pr.pct, total: 100 }),
        });
      } finally {
        flashAbort = undefined;
      }
    });

  const routes: Record<string, (req: IncomingMessage, q: URLSearchParams) => Promise<unknown>> = {
    'GET /api/state': () => stateView(p, s, cards, boards, busy),
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
      return op('update', async (): Promise<UpdateResultView> => {
        const setup = await prepareUpdate(p, s, c, board);
        const b = await runBackup(c, board, { reason: 'update', changes: setup.changes });
        const r = await applyPlan(c.volume, setup.plan, setup.contents, new Map(Object.entries(resolutions ?? {})), (pr) =>
          progress({ op: 'update', step: 'write', text: pr.path, done: pr.done, total: pr.total }),
        );
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
        return flashWith(async (fo) => {
          // a version from the catalog is downloaded first, and then stays like any other download
          const src = s.sources.find((x) => x.kind === 'firmware');
          if (tag && src && !(await localVersions(p, src.name, true)).some((v) => v.tag === tag)) {
            progress({ op: 'flash', step: 'download', text: `Downloading ${tag}`, file: tag });
            await downloadTag(p, s, src, tag);
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
    'POST /api/firmware/cancel': async () => {
      flashAbort?.abort();
    },
    'GET /api/packages': () => packageViews(p, s),
    'POST /api/packages/delete': async (req) => {
      const { name, tag } = await body<{ name: string; tag: string }>(req);
      await deleteVersion(p, s, name, tag);
    },
    'GET /api/backups': () => backupViews(p, s),
    'POST /api/backups/keep': async (req) => {
      const { board, name, keep } = await body<{ board: string; name: string; keep: boolean }>(req);
      const list = (s.keptBackups[board] ?? []).filter((n) => n !== name);
      s.keptBackups[board] = keep ? [...list, name] : list;
      await saveSettings(p, s);
    },
    'POST /api/backups/delete': async (req) => {
      const { board, name } = await body<{ board: string; name: string }>(req);
      await deleteBackup(p, board, name);
      s.keptBackups[board] = (s.keptBackups[board] ?? []).filter((n) => n !== name);
      forgetBackups(s, board, [name]);
      await saveSettings(p, s);
      await pushState();
    },
    'POST /api/backups/note': async (req) => {
      const { board, name, note } = await body<{ board: string; name: string; note: string }>(req);
      if (!isSafeName(board) || !isBackupName(name) || typeof note !== 'string' || note.trim().length > MAX_NOTE) {
        throw new HttpError(400, 'invalidRequest', { what: 'note' });
      }
      if (!(await listBackups(p, board)).includes(name)) throw new HttpError(404, 'backupNotFound', { name });
      setBackupNote(s, board, name, note);
      await saveSettings(p, s);
    },
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
    'POST /api/sources/remove': async (req) => {
      const { name } = await body<{ name: string }>(req);
      if (!removeSource(s, name)) throw new HttpError(400, 'onlyProjectsRemovable');
      await saveSettings(p, s);
      await pushState();
    },
  };

  const serveStatic = async (res: ServerResponse, urlPath: string) => {
    const root = o.staticDir!;
    let file = normalize(join(root, decodeURIComponent(urlPath)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(404, 'notFound');
    if (!(await stat(file).catch(() => undefined))?.isFile()) file = join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.write(`event: state\ndata: ${JSON.stringify(await stateView(p, s, cards, boards, busy))}\n\n`);
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return json(res, await route(req, url.searchParams));
      if (url.pathname.startsWith('/api/') || !o.staticDir) throw new HttpError(404, 'notFound');
      await serveStatic(res, url.pathname);
    } catch (e) {
      // coded errors are the user's to fix (400 unless said otherwise), anything else is a bug
      const status = e instanceof HttpError ? e.status : e instanceof AppError ? 400 : 500;
      const { message, ...coded } = errorInfo(e);
      json(res, { error: message, ...coded }, status);
    }
  });

  await poll(true);
  const timer = setInterval(() => void poll().catch(() => {}), o.pollMs ?? 2000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://localhost:${typeof address === 'object' && address ? address.port : o.port}`,
    close: () => {
      clearInterval(timer);
      for (const c of clients) c.end();
      server.close();
    },
  };
}
