import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse } from 'yaml';
import { makeParent } from './apply.ts';
import { listBackups } from './backup.ts';
import { AppError } from './errors.ts';
import { isSafeName, type Paths } from './paths.ts';
import type { RadioType } from './radios.ts';
import { readZipBuffer } from './zip.ts';

// EdgeTX reads only MODELS/model<digits>.yml; anything else in MODELS/ is not a model to it.
const MODEL_FILE = /^model\d+\.yml$/i;
export const isModelFile = (name: string) => MODEL_FILE.test(name);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export interface ModelModule {
  type?: string; // e.g. TYPE_CROSSFIRE, missing when the module is off
  id?: number; // receiver number
}

// One model file, with what the lists and checks need from it.
export interface ModelFile {
  file: string; // as on the card, e.g. "model2.yml"
  name: string; // header name; without one, the file name without ".yml" like EdgeTX shows it
  bitmap?: string; // file under IMAGES/
  labels: string[];
  semver?: string; // EdgeTX version that saved it
  sha: string;
  data: Buffer;
  doc: Record<string, unknown>;
}

// Labels are a comma separated list; EdgeTX writes "/c" for a comma and "//" for a slash inside a label.
const labelList = (csv: string) =>
  csv
    .split(',')
    .map((l) => l.replace(/\/([/c])/g, (_, c: string) => (c === 'c' ? ',' : '/')))
    .filter(Boolean);

export function parseModel(file: string, data: Buffer): ModelFile {
  let doc: unknown;
  try {
    doc = parse(data.toString('utf8'));
  } catch {
    doc = undefined;
  }
  const d = isObject(doc) ? doc : {};
  const h = isObject(d.header) ? d.header : {};
  const name = str(h.name).trim() || file.replace(/\.yml$/i, '');
  const bitmap = str(h.bitmap).trim();
  return {
    file,
    name,
    ...(bitmap ? { bitmap } : {}),
    labels: labelList(str(h.labels)),
    ...(d.semver !== undefined ? { semver: str(d.semver) } : {}),
    sha: sha256(data),
    data,
    doc: d,
  };
}

// Module type and receiver number per module slot (0 internal, 1 external).
export function modulesOf(m: ModelFile): ModelModule[] {
  const h = isObject(m.doc.header) ? m.doc.header : {};
  const ids = isObject(h.modelId) ? h.modelId : {};
  const mods = isObject(m.doc.moduleData) ? m.doc.moduleData : {};
  const out: ModelModule[] = [];
  for (const i of [0, 1]) {
    const mod = mods[i];
    const idEntry = ids[i];
    const type = isObject(mod) && mod.type && mod.type !== 'TYPE_NONE' ? str(mod.type) : undefined;
    const id = isObject(idEntry) ? Number(idEntry.val) : NaN;
    out.push({ ...(type ? { type } : {}), ...(Number.isFinite(id) && id > 0 ? { id } : {}) });
  }
  return out;
}

// The model files in a card or backup folder, by file name.
export async function readModels(root: string): Promise<ModelFile[]> {
  const dir = join(root, 'MODELS');
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile() && isModelFile(e.name)).map((e) => e.name);
  const models = await Promise.all(names.map(async (n) => parseModel(n, await readFile(join(dir, n)))));
  return models.sort((a, b) => fileNumber(a.file) - fileNumber(b.file));
}

const fileNumber = (file: string) => parseInt(file.replace(/\D/g, ''), 10) || 0;

// What a radio has, from its RADIO/radio.yml.
export interface RadioHardware {
  board?: string;
  firmware?: string;
  language?: string; // voice output, the folder under SOUNDS/ for the model's sounds
  controls: string[]; // switches, pots and sliders; type NONE means not fitted
  internalModule?: string;
  currentModel?: string; // the model file the radio has loaded
}

export function parseHardware(text: string | undefined): RadioHardware {
  let doc: unknown;
  try {
    doc = text === undefined ? undefined : parse(text);
  } catch {
    doc = undefined;
  }
  const d = isObject(doc) ? doc : {};
  const fitted = (v: unknown) =>
    isObject(v) ? Object.entries(v).filter(([, c]) => !isObject(c) || str(c.type).toUpperCase() !== 'NONE').map(([n]) => n) : [];
  const opt = (v: unknown) => (str(v) ? str(v) : undefined);
  const hw: RadioHardware = { controls: [...fitted(d.switchConfig), ...fitted(d.potsConfig)] };
  if (opt(d.board)) hw.board = opt(d.board);
  if (opt(d.semver)) hw.firmware = opt(d.semver);
  if (opt(d.ttsLanguage)) hw.language = opt(d.ttsLanguage);
  if (opt(d.internalModule) && d.internalModule !== 'TYPE_NONE') hw.internalModule = opt(d.internalModule);
  if (opt(d.currModelFilename)) hw.currentModel = opt(d.currModelFilename);
  return hw;
}

export async function readHardware(root: string): Promise<RadioHardware> {
  return parseHardware(await readFile(join(root, 'RADIO', 'radio.yml'), 'utf8').catch(() => undefined));
}

// --- Models across backups ---

export interface ModelVersion {
  sha: string;
  file: string;
  backup: string; // newest backup with this content
  since: string; // oldest backup with this content
  semver?: string;
  bitmap?: string;
  labels: string[];
}

export interface ModelEntry {
  name: string;
  file?: string; // set when a backup has more than one model of this name
  versions: ModelVersion[]; // newest first
}

// Backups never change, so their models are read once.
export type ModelCache = Map<string, ModelFile[]>;

export async function backupModels(p: Paths, board: string, name: string, cache?: ModelCache): Promise<ModelFile[]> {
  const dir = join(p.backups, board, name);
  const hit = cache?.get(dir);
  if (hit) return hit;
  const models = await readModels(dir);
  cache?.set(dir, models);
  return models;
}

// Grouped by name, each distinct content one version; two models of the same name in a backup stay apart.
export async function modelEntries(p: Paths, board: string, cache?: ModelCache): Promise<ModelEntry[]> {
  const entries = new Map<string, ModelEntry>();
  let newer: string | undefined; // the backup read just before, one step newer
  for (const backup of await listBackups(p, board)) {
    const models = await backupModels(p, board, backup, cache);
    const count = new Map<string, number>();
    for (const m of models) count.set(m.name, (count.get(m.name) ?? 0) + 1);
    for (const m of models) {
      const twin = (count.get(m.name) ?? 0) > 1;
      const key = twin ? `${m.name}\u0000${m.file}` : m.name;
      const entry = entries.get(key) ?? { name: m.name, ...(twin ? { file: m.file } : {}), versions: [] };
      entries.set(key, entry);
      const v = entry.versions.find((x) => x.sha === m.sha);
      // backups come newest first: the first one seen is the newest; "since" moves back only while
      // the content was in every backup in between, so another version or a gap ends it
      if (v) {
        if (v.since === newer) v.since = backup;
      } else
        entry.versions.push({
          sha: m.sha,
          file: m.file,
          backup,
          since: backup,
          ...(m.semver ? { semver: m.semver } : {}),
          ...(m.bitmap ? { bitmap: m.bitmap } : {}),
          labels: m.labels,
        });
    }
    newer = backup;
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || str(a.file).localeCompare(str(b.file)));
}

export type CardStatus = 'same' | 'changed' | 'missing';

// The card's model of the same name; with several, the one with the same file name first.
export function sameNamed(card: ModelFile[], name: string, file?: string): ModelFile | undefined {
  const named = card.filter((m) => m.name === name);
  return named.find((m) => m.file.toLowerCase() === file?.toLowerCase()) ?? named[0];
}

export function cardStatus(entry: ModelEntry, card: ModelFile[]): { status: CardStatus; version?: number } {
  const m = sameNamed(card, entry.name, entry.file ?? entry.versions[0]?.file);
  if (!m) return { status: 'missing' };
  const version = entry.versions.findIndex((v) => v.sha === m.sha);
  if (version === 0) return { status: 'same', version };
  return version > 0 ? { status: 'changed', version } : { status: 'changed' };
}

// --- Where a model comes from ---

// Files next to the model (image, checklist, scripts): a backup folder, or the files of an imported .etx.
export interface ModelOrigin {
  board?: string;
  hardware?: RadioHardware;
  read: (path: string) => Promise<Buffer | undefined>;
  list: (dir: string) => Promise<string[]>; // folder names below dir
  listed?: Record<string, { from: string[]; written: string }>; // the packages list of a backup, for "comes with"
  isBackup: boolean;
}

export async function backupOrigin(p: Paths, board: string, name: string): Promise<ModelOrigin> {
  if (!isSafeName(board) || !isSafeName(name)) throw new AppError('invalidRequest', { what: 'backup' });
  const root = join(p.backups, board, name);
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new AppError('backupNotFound', { name });
  return folderOrigin(root, board, true);
}

export async function folderOrigin(root: string, board: string | undefined, isBackup: boolean): Promise<ModelOrigin> {
  const listedText = await readFile(join(root, '.radio-manager', 'installed.json'), 'utf8').catch(() => undefined);
  let listed: ModelOrigin['listed'];
  try {
    const files = listedText ? (JSON.parse(listedText) as { files?: unknown }).files : undefined;
    if (isObject(files)) listed = files as ModelOrigin['listed'];
  } catch {
    listed = undefined;
  }
  return {
    board,
    hardware: await readHardware(root),
    read: (path) => readFile(join(root, path)).catch(() => undefined),
    list: async (dir) => (await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name),
    ...(listed ? { listed } : {}),
    isBackup,
  };
}

export interface ImportedFile {
  name: string;
  board?: string;
  models: ModelFile[];
  origin: ModelOrigin;
}

// What an .etx may unpack to; a radio's models are a few MB at most.
const MAX_UNPACKED = 64 * 1024 * 1024;

// A model file from elsewhere: a single model as .yml, or a whole radio as .etx (a zip with RADIO/ and MODELS/).
export async function readImport(name: string, data: Buffer): Promise<ImportedFile> {
  const zipped = data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zipped) {
    const files = await readZipBuffer(data, MAX_UNPACKED).catch((e: unknown) => {
      throw e instanceof AppError ? e : new AppError('notModelFile', { file: name });
    });
    const get = (path: string) => [...files].find(([n]) => n.toLowerCase() === path.toLowerCase())?.[1];
    const models = [...files]
      .filter(([n]) => /^MODELS\/model\d+\.yml$/i.test(n))
      .map(([n, d]) => parseModel(n.slice('MODELS/'.length), d))
      .sort((a, b) => fileNumber(a.file) - fileNumber(b.file));
    if (models.length === 0) throw new AppError('notModelFile', { file: name });
    const hardware = parseHardware(get('RADIO/radio.yml')?.toString('utf8'));
    return {
      name,
      ...(hardware.board ? { board: hardware.board } : {}),
      models,
      origin: { board: hardware.board, hardware, read: async (path) => get(path), list: async () => [], isBackup: false },
    };
  }
  const model = parseModel('model1.yml', data);
  if (!isObject(model.doc.header)) throw new AppError('notModelFile', { file: name });
  return { name, models: [{ ...model, file: '' }], origin: { read: async () => undefined, list: async () => [], isBackup: false } };
}

// --- Copying onto the card ---

export interface CopyRequest {
  model: ModelFile;
  origin: ModelOrigin;
  mode?: 'replace' | 'add'; // without: replace when a model of the same name is on the card
}

export type FileAction = 'add' | 'replace';

export interface CopyItem {
  name: string;
  model: ModelFile;
  origin: ModelOrigin;
  mode: 'replace' | 'add';
  canReplace: boolean; // a model of the same name is on the card
  target: string; // file under MODELS/
  image?: { path: string; action: FileAction; data: Buffer };
  checklist?: { path: string; action: FileAction; data: Buffer };
  missing: { path: string; pkg?: string }[]; // files the model uses that the card lacks; not copied
  controls: string[]; // switches, pots and sliders the model uses that the radio doesn't have
  module?: { model: string; radio?: string };
  screen?: { model: string; radio: string };
  newer?: { model: string; radio: string };
  receiver?: { id: number; models: string[] };
}

export interface CardState {
  volume: string;
  models: ModelFile[];
  hardware: RadioHardware;
}

export async function readCardState(volume: string): Promise<CardState> {
  return { volume, models: await readModels(volume), hardware: await readHardware(volume) };
}

// Names that look like controls, for a model whose radio is unknown: SA, SW1, P1, SL1, FL1 with a position digit.
const CONTROL_GUESS = /^(SW\d|SL\d|FL\d|P\d|S[A-Z])[0-2]?$/;
const CONTROL_KEYS = new Set(['swtch', 'srcRaw', 'def', 'andsw', 'source', 'thrTraceSrc']);

// Controls a model uses: names of the source radio (or guessed) in the fields that pick a source or a switch,
// with a position digit after a switch name ("SA2", "SW12", "!SB0").
export function controlsUsed(m: ModelFile, names?: string[]): string[] {
  const sorted = names ? [...names].sort((a, b) => b.length - a.length) : undefined;
  const used = new Set<string>();
  const match = (token: string) => {
    if (sorted) return sorted.find((n) => token === n || (token.startsWith(n) && /^[0-2]$/.test(token.slice(n.length))));
    const g = token.match(CONTROL_GUESS);
    return g?.[1];
  };
  const walk = (v: unknown, key?: string) => {
    if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'string' && key && CONTROL_KEYS.has(key)) {
      for (const token of v.split(/[^A-Za-z0-9]+/)) {
        const hit = token && match(token);
        if (hit) used.add(hit);
      }
    }
  };
  walk(m.doc);
  return [...used].sort();
}

const screenOf = (types: RadioType[], board?: string) => types.find((t) => t.board === board)?.sdPackage.replace(/^c/, '');

// "2.12.5" above "2.12.2"; parts that are missing count as 0.
export function versionAbove(a: string, b: string): boolean {
  const x = a.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const y = b.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// Widget names as the widgets' main.lua set them: name = "Flights", or name = app_name with local app_name = "Flights".
export function widgetName(lua: string): string | undefined {
  const all = [...lua.matchAll(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_]\w*))/g)];
  const last = all.at(-1);
  if (!last) return undefined;
  if (last[1] !== undefined || last[2] !== undefined) return last[1] ?? last[2];
  const v = lua.match(new RegExp(`\\blocal\\s+${last[3]}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return v ? (v[1] ?? v[2]) : undefined;
}

async function widgetFolders(list: (dir: string) => Promise<string[]>, read: (path: string) => Promise<Buffer | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const dir of await list('WIDGETS')) {
    const lua = await read(`WIDGETS/${dir}/main.lua`);
    const name = lua && widgetName(lua.toString('utf8'));
    if (name && !out.has(name)) out.set(name, dir);
  }
  return out;
}

const cardRead = (volume: string) => (path: string) => readFile(join(volume, path)).catch(() => undefined);
const cardList = (volume: string) => async (dir: string) =>
  (await readdir(join(volume, dir), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
const exists = async (volume: string, path: string) => !!(await stat(join(volume, path)).catch(() => undefined));

// Files the model refers to by name: mix and function scripts, sounds, widgets.
async function missingFiles(m: ModelFile, origin: ModelOrigin, card: CardState): Promise<CopyItem['missing']> {
  const out: CopyItem['missing'] = [];
  const pkgOf = (path: string) => {
    const hit = origin.listed && Object.entries(origin.listed).find(([f]) => f.toLowerCase() === path.toLowerCase() || f.toLowerCase().startsWith(path.toLowerCase()));
    return hit?.[1].written ?? hit?.[1].from[0];
  };
  const note = async (path: string, alt: string[] = []) => {
    if (out.some((x) => x.path === path)) return;
    for (const p of [path, ...alt]) if (await exists(card.volume, p)) return;
    // from a backup only what it has; an import has no files, so whatever the card lacks
    if (origin.isBackup) {
      let there = false;
      for (const p of [path, ...alt]) if (await origin.read(p)) there = true;
      if (!there) return;
    }
    const pkg = pkgOf(path);
    out.push({ path, ...(pkg ? { pkg } : {}) });
  };
  const scripts = isObject(m.doc.scriptsData) ? Object.values(m.doc.scriptsData) : [];
  for (const sc of scripts) {
    const f = isObject(sc) ? str(sc.file).trim() : '';
    if (f) await note(`SCRIPTS/MIXES/${f}.lua`, [`SCRIPTS/MIXES/${f}.luac`]);
  }
  const fns = isObject(m.doc.customFn) ? Object.values(m.doc.customFn) : [];
  for (const fn of fns) {
    if (!isObject(fn)) continue;
    const arg = str(fn.def).split(',')[0]!.trim();
    if (!arg) continue;
    if (fn.func === 'PLAY_SCRIPT') await note(`SCRIPTS/FUNCTIONS/${arg}.lua`, [`SCRIPTS/FUNCTIONS/${arg}.luac`]);
    if ((fn.func === 'PLAY_TRACK' || fn.func === 'BACKGND') && card.hardware.language) {
      const path = `SOUNDS/${card.hardware.language}/${arg}.wav`;
      const from = `SOUNDS/${origin.hardware?.language ?? card.hardware.language}/${arg}.wav`;
      if (!(await exists(card.volume, path)) && !out.some((x) => x.path === path)) {
        if (!origin.isBackup || (await origin.read(from))) {
          const pkg = pkgOf(from);
          out.push({ path, ...(pkg ? { pkg } : {}) });
        }
      }
    }
  }
  if (origin.isBackup) {
    const names = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObject(v)) {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'widgetName' && typeof x === 'string') names.add(x);
          else walk(x);
        }
      }
    };
    walk(m.doc.screenData);
    walk(m.doc.topbarData);
    if (names.size > 0) {
      const theirs = await widgetFolders(origin.list, origin.read);
      const ours = await widgetFolders(cardList(card.volume), cardRead(card.volume));
      for (const n of [...names].sort()) {
        const dir = theirs.get(n);
        if (dir && !ours.has(n)) {
          const pkg = pkgOf(`WIDGETS/${dir}/`);
          out.push({ path: `WIDGETS/${dir}/`, ...(pkg ? { pkg } : {}) });
        }
      }
    }
  }
  return out;
}

// The checklist EdgeTX shows for a model: MODELS/<name>.txt, with "_" for spaces, or MODELS/<file>.txt.
export function checklistNames(name: string, file: string): string[] {
  const base = file.replace(/\.yml$/i, '');
  return [...new Set([`${name}.txt`, `${name.replaceAll(' ', '_')}.txt`, ...(base ? [`${base}.txt`] : [])])];
}

async function fileAction(volume: string, path: string, data: Buffer): Promise<FileAction | undefined> {
  const now = await readFile(join(volume, path)).catch(() => undefined);
  if (!now) return 'add';
  return now.equals(data) ? undefined : 'replace';
}

const nextFree = (taken: Set<string>) => {
  for (let n = 1; ; n++) if (!taken.has(`model${n}.yml`)) return `model${n}.yml`;
};

export async function planCopy(card: CardState, requests: CopyRequest[], types: RadioType[] = []): Promise<CopyItem[]> {
  const taken = new Set(card.models.map((m) => m.file.toLowerCase()));
  const replaced = new Set<string>();
  const items: CopyItem[] = [];
  for (const r of requests) {
    const m = r.model;
    const twin = sameNamed(card.models.filter((x) => !replaced.has(x.file)), m.name, m.file);
    const mode = r.mode === 'add' || !twin ? 'add' : 'replace';
    const target = mode === 'replace' ? twin!.file : nextFree(taken);
    taken.add(target.toLowerCase());
    if (mode === 'replace') replaced.add(target);
    const item: CopyItem = { name: m.name, model: m, origin: r.origin, mode, canReplace: !!twin, target, missing: [], controls: [] };

    if (m.bitmap && isSafeName(m.bitmap)) {
      const data = await r.origin.read(`IMAGES/${m.bitmap}`);
      const action = data && (await fileAction(card.volume, `IMAGES/${m.bitmap}`, data));
      if (data && action) item.image = { path: `IMAGES/${m.bitmap}`, action, data };
    }
    for (const n of checklistNames(m.name, m.file)) {
      const data = isSafeName(n) ? await r.origin.read(`MODELS/${n}`) : undefined;
      if (!data) continue;
      // named after the file: it follows the model to its new number
      const to = n === `${m.file.replace(/\.yml$/i, '')}.txt` ? `MODELS/${target.replace(/\.yml$/i, '')}.txt` : `MODELS/${n}`;
      const action = await fileAction(card.volume, to, data);
      if (action) item.checklist = { path: to, action, data };
      break;
    }

    item.missing = await missingFiles(m, r.origin, card);
    const hw = card.hardware;
    if (hw.controls.length > 0) {
      const names = r.origin.hardware?.controls.length ? r.origin.hardware.controls : undefined;
      item.controls = controlsUsed(m, names).filter((c) => !hw.controls.includes(c));
    }
    const [internal] = modulesOf(m);
    if (internal?.type && internal.type !== hw.internalModule) item.module = { model: internal.type, ...(hw.internalModule ? { radio: hw.internalModule } : {}) };
    const from = screenOf(types, r.origin.board);
    const to = screenOf(types, hw.board);
    if (from && to && from !== to) item.screen = { model: from, radio: to };
    if (m.semver && hw.firmware && versionAbove(m.semver, hw.firmware)) item.newer = { model: m.semver, radio: hw.firmware };
    const mods = modulesOf(m);
    for (const [i, mod] of mods.entries()) {
      if (!mod.type || !mod.id) continue;
      const others = card.models.filter((x) => x.file !== target && modulesOf(x)[i]?.type === mod.type && modulesOf(x)[i]?.id === mod.id);
      if (others.length > 0) {
        item.receiver = { id: mod.id, models: others.map((x) => x.name) };
        break;
      }
    }
    items.push(item);
  }
  return items;
}

// Whether the user has to confirm: the model uses hardware the radio may not have.
export const doesntFit = (i: CopyItem) => i.controls.length > 0 || !!i.module || !!i.screen;

export interface ModelsResult {
  written: number;
  moved: number;
}

const interrupted = async (volume: string, done: string[], e: unknown) => {
  if (!(await stat(volume).catch(() => undefined))) throw new AppError('modelsInterrupted', { done: done.join(', ') });
  throw e;
};

// Model files with their content as it is and the current time, so the radio's labels.yml no longer matches
// and it reads them again; labels.yml and radio.yml are never written.
export async function applyCopy(
  volume: string,
  items: CopyItem[],
  onProgress: (pr: { path: string; done: number; total: number }) => void = () => {},
): Promise<ModelsResult> {
  const writes: { path: string; data: Buffer }[] = [];
  for (const i of items) writes.push({ path: `MODELS/${i.target}`, data: i.model.data });
  for (const i of items) {
    if (i.image) writes.push(i.image);
    if (i.checklist) writes.push(i.checklist);
  }
  const done: string[] = [];
  try {
    for (const [n, w] of writes.entries()) {
      await makeParent(volume, w.path);
      await writeFile(join(volume, w.path), w.data);
      if (w.path.startsWith('MODELS/') && w.path.endsWith('.yml')) done.push(items.find((i) => `MODELS/${i.target}` === w.path)!.name);
      onProgress({ path: w.path, done: n + 1, total: writes.length });
    }
  } catch (e) {
    await interrupted(volume, done, e);
  }
  return { written: writes.length, moved: 0 };
}

// --- Deleting from the card ---

export interface DeleteItem {
  name: string;
  file: string;
  moves: string[]; // paths below MODELS/ that go to MODELS/DELETED/: the model file, its checklist
  active: boolean; // the model the radio has loaded
}

// Like the radio does it: the files go to MODELS/DELETED/, where EdgeTX no longer sees them.
export async function planDelete(card: CardState, files: string[]): Promise<DeleteItem[]> {
  const items: DeleteItem[] = [];
  // a file is moved once, also when two deleted models of one name share a checklist
  const moving = new Set<string>();
  for (const f of new Set(files)) {
    const m = card.models.find((x) => x.file === f);
    if (!m) throw new AppError('modelNotFound', { name: f });
    const moves = [m.file];
    const twins = card.models.filter((x) => x.name === m.name && !files.includes(x.file));
    for (const n of checklistNames(m.name, m.file)) {
      const byFile = n === `${m.file.replace(/\.yml$/i, '')}.txt`;
      // named after the model: it stays while another model of that name stays
      if ((byFile || twins.length === 0) && isSafeName(n) && (await exists(card.volume, `MODELS/${n}`))) moves.push(n);
    }
    const own = moves.filter((x) => !moving.has(x));
    for (const x of own) moving.add(x);
    items.push({ name: m.name, file: m.file, moves: own, active: card.hardware.currentModel === m.file });
  }
  return items;
}

export async function applyDelete(
  volume: string,
  items: DeleteItem[],
  onProgress: (pr: { path: string; done: number; total: number }) => void = () => {},
): Promise<ModelsResult> {
  const moves = items.flatMap((i) => i.moves);
  if (moves.length === 0) return { written: 0, moved: 0 };
  const done: string[] = [];
  try {
    await mkdir(join(volume, 'MODELS', 'DELETED'), { recursive: true });
    for (const [n, f] of moves.entries()) {
      const to = join(volume, 'MODELS', 'DELETED', f);
      await rm(to, { force: true });
      await rename(join(volume, 'MODELS', f), to);
      const item = items.find((i) => i.file === f);
      if (item) done.push(item.name);
      onProgress({ path: `MODELS/${f}`, done: n + 1, total: moves.length });
    }
  } catch (e) {
    await interrupted(volume, done, e);
  }
  return { written: 0, moved: moves.length };
}

// --- Export ---

// A file name from the model name; characters file systems refuse become "_".
export function exportName(m: ModelFile): string {
  // oxlint-disable-next-line no-control-regex
  const base = m.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/^\.+/, '');
  return `${base || m.file.replace(/\.yml$/i, '') || 'model'}.yml`;
}

// Image types EdgeTX shows, for serving a model's picture.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.bmp': 'image/bmp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export async function modelImage(p: Paths, board: string, backup: string, file: string): Promise<{ data: Buffer; type: string }> {
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type || !isSafeName(board) || !isSafeName(backup) || !isSafeName(file)) throw new AppError('invalidRequest', { what: 'image' });
  const data = await readFile(join(p.backups, board, backup, 'IMAGES', file)).catch(() => undefined);
  if (!data) throw new AppError('notFound');
  return { data, type };
}
