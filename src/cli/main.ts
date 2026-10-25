#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyPlan, type Resolution } from '../core/apply.ts';
import { backupCard, backupFirmware, listBackups, pruneBackups } from '../core/backup.ts';
import { findCards, readCard, type RadioCard } from '../core/card.ts';
import { localVersion } from '../core/content.ts';
import { checkFirmwareFile, firmwareFile, flashFile, flashMethod, knownMethod, type FlashMethod } from '../core/firmware.ts';
import { downloadAll, downloadTag } from '../core/download.ts';
import { AppError } from '../core/errors.ts';
import { diffModels, type DiffArea } from '../core/modeldiff.ts';
import {
  applyCopy,
  applyDelete,
  backupModels,
  backupOrigin,
  cardStatus,
  doesntFit,
  exportName,
  modelEntries,
  planCopy,
  planDelete,
  readCardState,
  readImport,
  sameNamed,
  type CardState,
  type CopyItem,
  type CopyRequest,
  type DeleteItem,
  type ModelFile,
} from '../core/models.ts';
import { localVersions } from '../core/packages.ts';
import { paths, type Paths } from '../core/paths.ts';
import { countActions, type PlanItem } from '../core/plan.ts';
import { isBelowMin, MIN_EDGETX, radioName, radioTypes } from '../core/radios.ts';
import { applyRestore, planRestore } from '../core/restore.ts';
import { updateSources } from '../core/selection.ts';
import {
  findLocalRepos,
  forgetBackups,
  loadSettings,
  rememberRadio,
  saveSettings,
  soundsOf,
  type BackupInfo,
  type PackageChange,
  type Settings,
} from '../core/settings.ts';
import { addSource, checkSource, removeSource } from '../core/sources.ts';
import { prepareUpdate } from '../core/update.ts';
import { listVolumes } from '../platform/volumes.ts';
import { FLASH_STEPS } from '../server/api.ts';
import { noteServer, runningServer } from '../server/running.ts';
import { startServer } from '../server/server.ts';

const HELP = `Usage: radio-manager <command> [options]

Commands:
  status     connected radio, installed and downloaded versions
  download   check all sources for new releases and download them
  backup     copy the whole SD card of the connected radio
  update     show the plan, then back up the card and update it
  restore    list the backups of the connected radio; "restore <backup>" brings the card back to one
  models     list the models in the backups of the connected radio (or --board); then:
             "models copy <model> ..."   newest version onto the connected card (--from <radio>[/<backup>])
             "models delete <model> ..." move models on the card to MODELS/DELETED
             "models export <model> ..." save as <model>.yml (--from, --out <folder>)
             "models import <file> [<model> ...]" from a .yml or .etx file onto the card
             "models diff <model> [<backup> [<backup>|card]]" differences, newest version against the card
  flash      flash firmware: "flash" for the newest download, "flash v2.12.2" or "flash v2.13.0-rc1" for another (downloaded first), "flash --file <path>" for an own .uf2 or .bin
  sources    list sources; "sources add <owner/repo>", "sources remove <name>"
  ui         open the browser interface

Options:
  --volume <path>   use this drive instead of detecting the radio
  --board <id>      radio type when the card has no RADIO/radio.yml, e.g. tx16s
  --no-backup       restore or change models without backing up the card first
  --force           flash an own file that has no EdgeTX identification; copy models that do not fully fit
  --add             models copy/import: add as new models instead of replacing those of the same name
  --from <radio>[/<backup>]  models copy/export/diff: take the models from these backups
  --out <folder>    models export: where the files go (default: current folder)
`;

class UserError extends Error {}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function connectedCards(volume?: string): Promise<RadioCard[]> {
  if (volume) {
    const card = await readCard(volume);
    if (!card) throw new UserError(`${volume} is not an EdgeTX SD card (no RADIO/ and MODELS/)`);
    return [card];
  }
  return findCards(await listVolumes());
}

async function oneCard(volume?: string): Promise<RadioCard> {
  const cards = await connectedCards(volume);
  if (cards.length === 0) throw new UserError('No radio connected. Connect it via USB in "USB Storage" mode.');
  if (cards.length > 1) {
    throw new UserError(`Several radios connected, pick one with --volume:\n${cards.map((c) => `  ${c.volume}`).join('\n')}`);
  }
  return cards[0]!;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

async function askBoard(p: Paths, s: Settings): Promise<string> {
  const types = await radioTypes(p, s);
  if (types.length === 0) throw new UserError('The list of radios comes with the SD content. Run "download" first.');
  console.log('This SD card has no RADIO/radio.yml yet. Which radio is it?');
  types.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}  ${r.name}`));
  const type = types[parseInt(await ask('Number: '), 10) - 1];
  if (!type) throw new UserError('No radio chosen.');
  return type.board;
}

async function remember(p: Paths, s: Settings, cards: RadioCard[]): Promise<void> {
  if (cards.map((c) => rememberRadio(s, c)).some(Boolean)) await saveSettings(p, s);
}

async function status(p: Paths, s: Settings, volume?: string): Promise<void> {
  const cards = await connectedCards(volume);
  await remember(p, s, cards);
  if (cards.length === 0) console.log('No radio connected.');
  const types = await radioTypes(p, s);
  for (const c of cards) {
    console.log(`${radioName(types, c.board)}${c.board ? ` (${c.board})` : ''} at ${c.volume}`);
    const fw = c.firmware ?? 'unknown';
    const low = c.firmware && isBelowMin(c.firmware) ? `  below EdgeTX ${MIN_EDGETX}, flash first` : '';
    console.log(`  Firmware   ${fw}${low}`);
    if (c.board) console.log(`  Sounds     ${soundsOf(s.radios[c.board]).join(', ') || 'unknown'}`);
    const installed = Object.entries(c.installed?.packages ?? {});
    if (installed.length === 0) {
      console.log(`  Installed  nothing recorded yet${c.sdcardVersion ? ` (SD content ${c.sdcardVersion} per edgetx.sdcard.version)` : ''}`);
    }
    for (const [name, v] of installed) console.log(`  Installed  ${name.padEnd(16)} ${v.version}`);
  }
  console.log('\nDownloaded packages:');
  for (const src of s.sources) {
    const [newest] = await localVersions(p, src.name);
    console.log(`  ${src.name.padEnd(16)} ${newest ? `${newest.tag}  (${newest.published.slice(0, 10)})` : 'none'}`);
  }
}

async function download(p: Paths, s: Settings): Promise<void> {
  const results = await downloadAll(p, s, fetch, (e) => {
    if (e.type === 'file') console.log(`  ${e.source}: ${e.file}${e.size ? ` (${mb(e.size)})` : ''}`);
  });
  console.log('');
  for (const r of results) {
    const what = {
      new: `${r.tag} downloaded`,
      current: `${r.tag} up to date`,
      'no-release': 'no release yet',
      skipped: `${r.tag ?? ''} skipped: ${r.message ?? ''}`,
      error: `error: ${r.message ?? ''}`,
    }[r.status];
    console.log(`  ${r.source.padEnd(16)} ${what}`);
  }
  if (results.some((r) => r.status === 'error')) process.exitCode = 1;
}

async function cardAndBoard(p: Paths, s: Settings, volume?: string, boardOpt?: string): Promise<[RadioCard, string]> {
  const card = await oneCard(volume);
  await remember(p, s, [card]);
  return [card, card.board ?? boardOpt ?? (await askBoard(p, s))];
}

async function backup(p: Paths, s: Settings, volume?: string, boardOpt?: string): Promise<void> {
  const [card, board] = await cardAndBoard(p, s, volume, boardOpt);
  await runBackup(p, s, card, board, { reason: 'manual' });
}

// info: why the backup is made; alsoKeep: the backup being restored, which the clean-up must not delete
async function runBackup(p: Paths, s: Settings, card: RadioCard, board: string, info: BackupInfo, alsoKeep?: string): Promise<void> {
  console.log(`Backing up ${radioName(await radioTypes(p, s), board)} from ${card.volume} ...`);
  let shown = -1;
  const result = await backupCard(card.volume, board, p, new Date(), (pr) => {
    const pct = pr.bytesTotal > 0 ? Math.floor((pr.bytesDone / pr.bytesTotal) * 100) : 100;
    if (pct === shown) return;
    shown = pct;
    if (process.stdout.isTTY) process.stdout.write(`\r  ${pct}%  ${pr.done}/${pr.total} files`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done: ${result.files} files, ${mb(result.bytes)} in ${result.dir}`);
  (s.backupInfo[board] ??= {})[result.name] = info;
  const removed = await pruneBackups(p, board, s.backupsToKeep, [...(s.keptBackups[board] ?? []), ...(alsoKeep ? [alsoKeep] : [])]);
  forgetBackups(s, board, removed);
  await saveSettings(p, s);
  if (removed.length > 0) console.log(`Removed old backups: ${removed.join(', ')}`);
}

const REASONS = {
  modified: 'changed on the card since the last update',
  unknown: 'a file no package delivered is in the way',
  'removed-modified': 'no longer in any package, but changed on the card',
};

// Asks per conflict; Enter keeps the card's file.
async function resolveConflicts(conflicts: PlanItem[]): Promise<Map<string, Resolution>> {
  const res = new Map<string, Resolution>();
  for (const c of conflicts) {
    console.log(`\nConflict: ${c.path}\n  ${REASONS[c.reason!]} (${c.pkg})`);
    const q = c.wanted ? '  Keep file on radio [k] or overwrite with update [w]? (k) ' : "  Keep it [k] or delete it [d]? (k) ";
    const a = await ask(q);
    res.set(c.path, a === 'w' || a === 'd' ? 'apply' : 'keep');
  }
  return res;
}

async function update(p: Paths, s: Settings, volume?: string, boardOpt?: string): Promise<void> {
  const [card, board] = await cardAndBoard(p, s, volume, boardOpt);
  if (card.firmware && isBelowMin(card.firmware)) {
    throw new UserError(`EdgeTX ${card.firmware} is below ${MIN_EDGETX}. Flash the firmware first.`);
  }
  const setup = await prepareUpdate(p, s, card, board);
  if (setup.selectionChanged) await saveSettings(p, s);
  const choices = s.radios[board]!.sources!;

  console.log(`${radioName(await radioTypes(p, s), board)} at ${card.volume}\n\nSources on this radio:`);
  for (const src of updateSources(s)) {
    const c = choices[src.name]!;
    const content = setup.contents.find((x) => x.name === src.name);
    const isNew = s.radios[board]!.newSources?.includes(src.name) ? '  new' : '';
    console.log(`  ${c.on ? '[x]' : '[ ]'} ${src.name.padEnd(16)} ${c.origin.padEnd(8)} ${content?.version ?? ''}${isNew}`);
  }
  if (setup.missing.length > 0) {
    console.log(`\nNot available (run "download", or no local checkout): ${setup.missing.join(', ')}`);
  }

  const n = countActions(setup.plan);
  console.log(`\nPlan: ${n.add} new, ${n.replace} replaced, ${n.delete} deleted, ${n.conflict} conflicts, ${n.unchanged} unchanged`);
  for (const c of setup.contents) {
    const mine = setup.plan.filter((i) => i.pkg === c.name && (i.action === 'add' || i.action === 'replace'));
    if (mine.length > 0) console.log(`  ${c.name.padEnd(16)} ${mine.length} files to write`);
  }
  for (const d of setup.plan.filter((i) => i.action === 'delete')) console.log(`  delete  ${d.path}  (${d.pkg})`);

  if (n.add + n.replace + n.delete + n.conflict === 0) {
    await applyPlan(card.volume, setup);
    console.log('\nNothing to change: the SD card is already up to date.');
    return;
  }
  const resolutions = await resolveConflicts(setup.plan.filter((i) => i.action === 'conflict'));
  if ((await ask('\nBack up the card and update it? [y/N] ')) !== 'y') {
    console.log('Nothing changed.');
    return;
  }
  await runBackup(p, s, card, board, { reason: 'update', changes: setup.changes });
  console.log('Updating ...');
  const r = await applyPlan(card.volume, setup, resolutions, (pr) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${pr.done}/${pr.total}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done: ${r.written} files written, ${r.deleted} deleted, ${r.kept} kept.`);
}

const changeText = (c: PackageChange) => (!c.from ? `${c.name} ${c.to} new` : !c.to ? `${c.name} ${c.from} removed` : `${c.name} ${c.from} -> ${c.to}`);

// "EdgeTX 2.12.3 · before update: edgetx-sdcard v2.12.3 -> v2.12.5"
function backupDetails(firmware?: string, info?: BackupInfo): string {
  const reason =
    info?.reason === 'manual'
      ? 'made by hand'
      : info?.reason === 'update'
        ? `before update${info.changes?.length ? `: ${info.changes.map(changeText).join(', ')}` : ''}`
        : info?.reason === 'restore'
          ? `before restoring ${info.restoredFrom}`
          : info?.reason === 'models'
            ? `before copying models: ${info.models?.join(', ') ?? ''}`
            : info?.reason === 'deleteModels'
              ? `before deleting models: ${info.models?.join(', ') ?? ''}`
              : undefined;
  return [firmware && `EdgeTX ${firmware}`, reason].filter(Boolean).join(' · ');
}

async function restore(p: Paths, s: Settings, name?: string, noBackup = false, volume?: string, boardOpt?: string): Promise<void> {
  const [card, board] = await cardAndBoard(p, s, volume, boardOpt);
  const radio = radioName(await radioTypes(p, s), board);
  if (!name) {
    const names = await listBackups(p, board);
    if (names.length === 0) {
      console.log(`No backups of the ${radio} yet.`);
      return;
    }
    console.log(`Backups of the ${radio}:`);
    for (const n of names) {
      const info = s.backupInfo[board]?.[n];
      console.log(`  ${n}${s.keptBackups[board]?.includes(n) ? '  kept' : ''}`);
      const details = backupDetails(await backupFirmware(join(p.backups, board, n)), info);
      if (details) console.log(`      ${details}`);
      if (info?.note) console.log(`      Note: ${info.note}`);
    }
    console.log('\nRestore one with "restore <backup>".');
    return;
  }
  const plan = await planRestore(card.volume, p, board, name);
  const count = (a: string) => plan.items.filter((i) => i.action === a).length;
  console.log(`${radio} at ${card.volume}, back to the backup ${name}\n`);
  console.log(`Plan: ${count('add')} back, ${count('replace')} replaced, ${count('delete')} deleted, ${plan.unchanged} unchanged`);
  for (const d of plan.items.filter((i) => i.action === 'delete')) console.log(`  delete  ${d.path}`);
  if (plan.firmware && card.firmware && plan.firmware !== card.firmware) {
    console.log(`\nNote: the backup was made with EdgeTX ${plan.firmware}, the radio runs ${card.firmware}.`);
    console.log('Models and scripts from the backup may not fully work with this firmware.');
  }
  if (plan.items.length === 0) {
    console.log('\nNothing to change: the SD card already matches the backup.');
    return;
  }
  const q = noBackup
    ? '\nRestore without a backup first? Files added since then are gone for good. [y/N] '
    : '\nBack up the card and restore? [y/N] ';
  if ((await ask(q)) !== 'y') {
    console.log('Nothing changed.');
    return;
  }
  if (!noBackup) await runBackup(p, s, card, board, { reason: 'restore', restoredFrom: name }, name);
  console.log('Restoring ...');
  const r = await applyRestore(card.volume, plan, (pr) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${pr.done}/${pr.total}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done: ${r.written} files written, ${r.deleted} deleted.`);
}

interface ModelOpts {
  volume?: string;
  board?: string;
  from?: string;
  add?: boolean;
  force?: boolean;
  noBackup?: boolean;
  out?: string;
}

const AREAS: Record<DiffArea, string> = {
  setup: 'Model setup',
  flightModes: 'Flight modes',
  inputs: 'Inputs',
  mixes: 'Mixes',
  outputs: 'Outputs',
  curves: 'Curves',
  logicalSwitches: 'Logical switches',
  specialFunctions: 'Special functions',
  telemetry: 'Telemetry',
  customScripts: 'Custom scripts',
  screens: 'Screens',
  other: 'Other',
};

const matches = (m: { name: string; file: string }, want: string) => m.name.toLowerCase() === want.toLowerCase() || m.file.toLowerCase() === want.toLowerCase();

// "tx16smk3" or "tx16smk3/2026-10-23_1849": the radio, and a backup or the newest one with the model.
function parseFrom(from: string | undefined, board: string): { board: string; backup?: string } {
  if (!from) return { board };
  const [b, backup] = from.split('/');
  if (!b || (backup !== undefined && !backup)) throw new UserError('Use --from <radio> or --from <radio>/<backup>.');
  return { board: b, ...(backup ? { backup } : {}) };
}

// A model in the backups: from the given backup, else the newest one that has it.
async function backupModel(p: Paths, board: string, want: string, backup?: string): Promise<{ model: ModelFile; backup: string }> {
  for (const b of backup ? [backup] : await listBackups(p, board)) {
    const model = (await backupModels(p, board, b)).find((m) => matches(m, want));
    if (model) return { model, backup: b };
  }
  throw new UserError(`No model "${want}" in the backups of ${board}${backup ? `/${backup}` : ''}.`);
}

async function modelsList(p: Paths, s: Settings, o: ModelOpts): Promise<void> {
  const cards = await connectedCards(o.volume);
  const card = cards.length === 1 ? cards[0] : undefined;
  const board = o.board ?? card?.board;
  if (!board) throw new UserError('Which radio? Connect it in "USB Storage" mode, or pass --board.');
  const radio = radioName(await radioTypes(p, s), board);
  const entries = await modelEntries(p, board);
  if (entries.length === 0) {
    console.log(`No models in the backups of the ${radio} yet.`);
    return;
  }
  const onCard = card ? (await readCardState(card.volume)).models : undefined;
  console.log(`Models in the backups of the ${radio}${onCard ? `, compared with the card at ${card!.volume}` : ''}:`);
  const STATUS = { same: 'on the card', changed: 'on the card, changed', missing: 'not on the card' };
  for (const e of entries) {
    const st = onCard ? `  ${STATUS[cardStatus(e, onCard).status]}` : '';
    console.log(`  ${e.name}${e.file ? ` (${e.file})` : ''}${st}`);
    for (const v of e.versions) {
      const since = v.since !== v.backup ? ` (since ${v.since})` : '';
      console.log(`      ${v.backup}${since}  ${v.file}${v.semver ? `  EdgeTX ${v.semver}` : ''}${v.labels.length ? `  ${v.labels.join(', ')}` : ''}`);
    }
  }
  if (onCard && card?.board === board) {
    const only = onCard.filter((m) => !entries.some((e) => e.name === m.name));
    if (only.length > 0) console.log(`
Only on the card: ${only.map((m) => `${m.name} (${m.file})`).join(', ')}`);
  }
}

function printCopy(items: CopyItem[], from: (i: CopyItem) => string): void {
  for (const i of items) {
    console.log(`\n${i.name} (${from(i)}): ${i.mode === 'replace' ? `replaces ${i.target}` : `new as ${i.target}`}`);
    if (i.image) console.log(`  ${i.image.path} (${i.image.action === 'add' ? 'new' : 'replaced'})`);
    if (i.checklist) console.log(`  ${i.checklist.path} (${i.checklist.action === 'add' ? 'new' : 'replaced'})`);
    for (const f of i.missing) console.log(`  Not copied, missing on the card: ${f.path}${f.pkg ? ` (turn on ${f.pkg} for this radio)` : ''}`);
    if (i.controls.length) console.log(`  Not on this radio: ${i.controls.join(', ')}`);
    if (i.module) console.log(`  Internal module: the model uses ${i.module.model}, the radio has ${i.module.radio ?? 'none'}`);
    if (i.screen) console.log(`  Screen: made for ${i.screen.model}, the radio has ${i.screen.radio}`);
    if (i.newer) console.log(`  Saved with EdgeTX ${i.newer.model}, the radio runs ${i.newer.radio}`);
    if (i.receiver) console.log(`  Receiver number ${i.receiver.id} is also used by ${i.receiver.models.join(', ')}`);
  }
}

function printDelete(items: DeleteItem[]): void {
  for (const d of items) {
    console.log(`\n${d.name}: ${d.moves.map((f) => `MODELS/${f}`).join(', ')} -> MODELS/DELETED/`);
    if (d.active) console.log('  The radio has this model loaded and switches to another one.');
  }
}

// Shows the plan, asks, backs up and writes; the same for copying, importing and deleting.
async function runModels(p: Paths, s: Settings, card: RadioCard, board: string, copy: CopyItem[], del: DeleteItem[], o: ModelOpts): Promise<void> {
  const misfits = copy.filter(doesntFit);
  if (misfits.length > 0 && !o.force) {
    throw new UserError(`\nNot everything fits this radio (${misfits.map((i) => i.name).join(', ')}). Pass --force to copy anyway.`);
  }
  const what = copy.length > 0 ? 'copy' : 'delete';
  const q = o.noBackup ? `\n${what === 'copy' ? 'Copy' : 'Delete'} without a backup first? [y/N] ` : `\nBack up the card and ${what}? [y/N] `;
  if ((await ask(q)) !== 'y') {
    console.log('Nothing changed.');
    return;
  }
  const names = [...copy.map((i) => i.name), ...del.map((d) => d.name)];
  if (!o.noBackup) await runBackup(p, s, card, board, { reason: copy.length > 0 ? 'models' : 'deleteModels', models: names });
  await applyCopy(card.volume, copy);
  await applyDelete(card.volume, del);
  console.log(
    copy.length > 0
      ? `Done: ${copy.length} ${copy.length === 1 ? 'model' : 'models'} on the card. The radio picks up the change once USB is disconnected.`
      : `Done: ${del.length} ${del.length === 1 ? 'model' : 'models'} moved to MODELS/DELETED.`,
  );
}

async function modelsCopy(p: Paths, s: Settings, names: string[], o: ModelOpts): Promise<void> {
  if (names.length === 0) throw new UserError('Name the models to copy, e.g. models copy "Master Copter".');
  const [card, board] = await cardAndBoard(p, s, o.volume, o.board);
  const from = parseFrom(o.from, board);
  const state: CardState = await readCardState(card.volume);
  const requests: CopyRequest[] = [];
  const sources = new Map<CopyRequest, string>();
  for (const n of names) {
    const { model, backup } = await backupModel(p, from.board, n, from.backup);
    const r: CopyRequest = { model, origin: await backupOrigin(p, from.board, backup), ...(o.add ? { mode: 'add' as const } : {}) };
    requests.push(r);
    sources.set(r, `${from.board} ${backup}`);
  }
  const items = await planCopy(state, requests, await radioTypes(p, s));
  console.log(`${radioName(await radioTypes(p, s), board)} at ${card.volume}`);
  printCopy(items, (i) => sources.get(requests[items.indexOf(i)]!)!);
  await runModels(p, s, card, board, items, [], o);
}

async function modelsImport(p: Paths, s: Settings, file: string | undefined, names: string[], o: ModelOpts): Promise<void> {
  if (!file) throw new UserError('Name the file, e.g. models import Copter.yml');
  const data = await readFile(file).catch(() => {
    throw new UserError(`Cannot read ${file}`);
  });
  const f = await readImport(basename(file), data);
  const chosen = names.map((n) => {
    const m = f.models.find((x) => matches(x, n));
    if (!m) throw new UserError(`No model "${n}" in ${file}.`);
    return m;
  });
  if (chosen.length === 0) chosen.push(...f.models);
  const [card, board] = await cardAndBoard(p, s, o.volume, o.board);
  const items = await planCopy(
    await readCardState(card.volume),
    chosen.map((model) => ({ model, origin: f.origin, ...(o.add ? { mode: 'add' as const } : {}) })),
    await radioTypes(p, s),
  );
  console.log(`${radioName(await radioTypes(p, s), board)} at ${card.volume}`);
  printCopy(items, () => basename(file));
  await runModels(p, s, card, board, items, [], o);
}

async function modelsDelete(p: Paths, s: Settings, names: string[], o: ModelOpts): Promise<void> {
  if (names.length === 0) throw new UserError('Name the models to delete, e.g. models delete "Old Glider".');
  const [card, board] = await cardAndBoard(p, s, o.volume, o.board);
  const state = await readCardState(card.volume);
  const files = names.map((n) => {
    const hits = state.models.filter((m) => matches(m, n));
    if (hits.length === 0) throw new UserError(`No model "${n}" on the card.`);
    if (hits.length > 1) throw new UserError(`More than one model "${n}" on the card (${hits.map((m) => m.file).join(', ')}); name the file instead.`);
    return hits[0]!.file;
  });
  const items = await planDelete(state, files);
  console.log(`${radioName(await radioTypes(p, s), board)} at ${card.volume}`);
  printDelete(items);
  await runModels(p, s, card, board, [], items, o);
}

async function modelsExport(p: Paths, names: string[], o: ModelOpts): Promise<void> {
  if (names.length === 0) throw new UserError('Name the models to export, e.g. models export "Master Copter".');
  const cards = await connectedCards(o.volume);
  const board = o.board ?? (cards.length === 1 ? cards[0]!.board : undefined);
  const from = parseFrom(o.from, board ?? '');
  if (!from.board) throw new UserError('Which radio? Connect it, or pass --board or --from.');
  const out = resolve(o.out ?? '.');
  await mkdir(out, { recursive: true });
  for (const n of names) {
    const { model, backup } = await backupModel(p, from.board, n, from.backup);
    const target = join(out, exportName(model));
    await writeFile(target, model.data);
    console.log(`${model.name} (${from.board} ${backup}) -> ${target}`);
  }
}

async function modelsDiff(p: Paths, name: string | undefined, a: string | undefined, b: string | undefined, o: ModelOpts): Promise<void> {
  if (!name) throw new UserError('Name the model, e.g. models diff "Master Copter".');
  const cards = await connectedCards(o.volume);
  const card = cards.length === 1 ? cards[0] : undefined;
  const from = parseFrom(o.from, o.board ?? card?.board ?? '');
  if (!from.board) throw new UserError('Which radio? Connect it, or pass --board or --from.');
  const left = await backupModel(p, from.board, name, a ?? from.backup);
  let right: ModelFile;
  let label: string;
  if (b && b !== 'card') {
    right = (await backupModel(p, from.board, name, b)).model;
    label = b;
  } else {
    if (!card) throw new UserError('Connect the radio to compare with its card, or name a second backup.');
    const m = sameNamed((await readCardState(card.volume)).models, left.model.name, left.model.file);
    if (!m) throw new UserError(`No model "${left.model.name}" on the card.`);
    right = m;
    label = 'the card';
  }
  console.log(`${left.model.name}: ${from.board} ${left.backup} against ${label}`);
  const groups = diffModels(left.model.doc, right.doc);
  if (groups.length === 0) console.log('\nNo differences.');
  for (const g of groups) {
    console.log(`\n${AREAS[g.area]}`);
    for (const e of g.entries) {
      const change = e.from === undefined ? `added ${e.to}` : e.to === undefined ? `removed (was ${e.from})` : `${e.from} -> ${e.to}`;
      console.log(`  ${e.path}: ${change}`);
    }
  }
}

async function models(p: Paths, s: Settings, args: string[], o: ModelOpts): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return modelsList(p, s, o);
    case 'copy':
      return modelsCopy(p, s, rest, o);
    case 'delete':
      return modelsDelete(p, s, rest, o);
    case 'export':
      return modelsExport(p, rest, o);
    case 'import':
      return modelsImport(p, s, rest[0], rest.slice(1), o);
    case 'diff':
      return modelsDiff(p, rest[0], rest[1], rest[2], o);
    default:
      throw new UserError('Use "models", "models copy", "models delete", "models export", "models import" or "models diff".');
  }
}

const REPO_ROOT = resolve(import.meta.dirname, '../..');

async function flash(p: Paths, s: Settings, tagArg?: string, volume?: string, boardOpt?: string): Promise<void> {
  const cards = await connectedCards(volume);
  const board = boardOpt ?? (cards.length === 1 ? cards[0]!.board : undefined);
  if (!board) throw new UserError('Which radio? Connect it in "USB Storage" mode first, or pass --board.');
  const tag = tagArg ?? (await localVersions(p, 'edgetx-firmware'))[0]?.tag;
  if (!tag) throw new UserError('No firmware downloaded. Run "download" first.');
  // any other release is downloaded first, like on the flash page
  const src = s.sources.find((x) => x.kind === 'firmware');
  if (src && !(await localVersions(p, src.name, true)).some((v) => v.tag === tag)) {
    console.log(`Downloading EdgeTX ${tag} ...`);
    if ((await downloadTag(p, s, src, tag)).status === 'no-release') throw new UserError(`EdgeTX has no release ${tag}.`);
  }
  const method = await flashMethod(p, tag, board).catch((e: Error) => {
    throw new UserError(e.message);
  });
  console.log(`Flashing EdgeTX ${tag} to the ${radioName(await radioTypes(p, s), board)} (was ${s.radios[board]?.firmware ?? 'unknown'}).\n`);
  const file = await flashAndReport(board, await firmwareFile(p, tag, board), method);
  console.log(`Done: ${file} written. The radio restarts with EdgeTX ${tag}.`);
}

// Prints the bootloader steps, waits for the radio and writes the firmware.
async function flashAndReport(board: string, fw: { name: string; data: Buffer }, method: FlashMethod): Promise<string> {
  FLASH_STEPS[method].forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log('\nWaiting for the radio (Ctrl+C to cancel) ...');
  let last = '';
  const r = await flashFile(board, fw, {
    volumes: listVolumes,
    onProgress: (pr) => {
      const line = pr.pct !== undefined ? `${pr.text} ${pr.pct}%` : pr.text;
      if (line === last) return;
      last = line;
      if (process.stdout.isTTY) process.stdout.write(`\r  ${line}`.padEnd(70));
      else console.log(`  ${line}`);
    },
  }).catch((e: Error) => {
    throw new UserError(`\n${e.message}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  return r.file;
}

async function flashOwnFile(p: Paths, s: Settings, path: string, force: boolean, volume?: string, boardOpt?: string): Promise<void> {
  const cards = await connectedCards(volume);
  const board = boardOpt ?? (cards.length === 1 ? cards[0]!.board : undefined);
  if (!board) throw new UserError('Which radio? Connect it in "USB Storage" mode first, or pass --board.');
  const data = await readFile(path).catch(() => {
    throw new UserError(`Cannot read ${path}`);
  });
  const name = basename(path);
  const known = await knownMethod(p, await localVersions(p, 'edgetx-firmware', !!s.firmwarePrereleases), board);
  const check = checkFirmwareFile(name, data, board, known);
  if (!check.board && !force) throw new UserError(`${name} has no EdgeTX identification, so it cannot be checked. Pass --force to flash it anyway.`);
  const what = check.version ? `EdgeTX ${check.version} (${name})` : name;
  console.log(`Flashing ${what} to the ${radioName(await radioTypes(p, s), board)} (was ${s.radios[board]?.firmware ?? 'unknown'}).\n`);
  const file = await flashAndReport(board, { name, data }, check.method);
  console.log(`Done: ${file} written. The radio restarts${check.version ? ` with EdgeTX ${check.version}` : ''}.`);
}

async function sources(p: Paths, s: Settings, args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === 'add' && arg) {
    console.log(`Checking ${arg} ...`);
    const r = await checkSource(p, s, arg).catch((e: Error) => {
      throw new UserError(e.message);
    });
    console.log(`${r.source.name} ${r.tag}: ${r.files} files for the SD card, SD folder ${r.source.sdDir ?? '(zip root)'}`);
    for (const f of r.sample) console.log(`  ${f}`);
    if ((await ask('Add this source? [y/N] ')) !== 'y') return;
    const cards = await findCards(await listVolumes());
    addSource(s, r.source, cards.length === 1 ? cards[0]!.board : undefined);
    await saveSettings(p, s);
    console.log(`Added ${r.source.name}.`);
    return;
  }
  if (sub === 'remove' && arg) {
    if (!removeSource(s, arg)) throw new UserError(`${arg} is not a project source.`);
    await saveSettings(p, s);
    console.log(`Removed ${arg}. Downloaded versions stay in ${p.packages}.`);
    return;
  }
  if (sub) throw new UserError('Use "sources", "sources add <owner/repo>" or "sources remove <name>".');
  for (const src of s.sources) {
    const [newest] = await localVersions(p, src.name);
    const local = await localVersion(src);
    console.log(`  ${src.name.padEnd(16)} ${src.repo.padEnd(36)} ${(newest?.tag ?? '-').padEnd(10)} ${local ?? ''}`);
  }
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

async function ui(p: Paths): Promise<void> {
  const staticDir = join(REPO_ROOT, 'dist', 'ui');
  if (!existsSync(join(staticDir, 'index.html'))) throw new UserError('Build the interface first: npm run build');
  const running = await runningServer(p.server);
  if (running) {
    console.log(`Radio Manager already runs at ${running}`);
    openBrowser(running);
    return;
  }
  // a free port; a second start finds this one through the note
  const server = await startServer({ paths: p, port: 0, staticDir, repoParent: dirname(REPO_ROOT) });
  const forget = await noteServer(p.server, server.url);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void forget().finally(() => process.exit(0)));
  console.log(`Radio Manager runs at ${server.url} (Ctrl+C to stop)`);
  openBrowser(server.url);
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      volume: { type: 'string' },
      board: { type: 'string' },
      'no-backup': { type: 'boolean' },
      file: { type: 'string' },
      force: { type: 'boolean' },
      add: { type: 'boolean' },
      from: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const p = paths();
  const s = await loadSettings(p);
  if (findLocalRepos(s, dirname(REPO_ROOT))) await saveSettings(p, s);
  switch (command) {
    case 'status':
      return status(p, s, values.volume);
    case 'download':
      return download(p, s);
    case 'backup':
      return backup(p, s, values.volume, values.board);
    case 'update':
      return update(p, s, values.volume, values.board);
    case 'restore':
      return restore(p, s, positionals[1], values['no-backup'], values.volume, values.board);
    case 'sources':
      return sources(p, s, positionals.slice(1));
    case 'models':
      return models(p, s, positionals.slice(1), {
        volume: values.volume,
        board: values.board,
        from: values.from,
        add: values.add,
        force: values.force,
        noBackup: values['no-backup'],
        out: values.out,
      });
    case 'ui':
      return ui(p);
    case 'flash':
      return values.file ? flashOwnFile(p, s, values.file, !!values.force, values.volume, values.board) : flash(p, s, positionals[1], values.volume, values.board);
    default:
      throw new UserError(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof UserError || e instanceof AppError ? e.message : e);
  process.exitCode = 1;
});
