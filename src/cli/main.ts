#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyPlan, type Resolution } from '../core/apply.ts';
import { backupCard, listBackups, pruneBackups } from '../core/backup.ts';
import { findCards, readCard, type RadioCard } from '../core/card.ts';
import { localVersion } from '../core/content.ts';
import { flashFirmware, flashMethod } from '../core/firmware.ts';
import { downloadAll } from '../core/download.ts';
import { AppError } from '../core/errors.ts';
import { localVersions } from '../core/packages.ts';
import { paths, type Paths } from '../core/paths.ts';
import { countActions, type PlanItem } from '../core/plan.ts';
import { isBelowMin, MIN_EDGETX, radioName, radioTypes } from '../core/radios.ts';
import { applyRestore, planRestore } from '../core/restore.ts';
import { updateSources } from '../core/selection.ts';
import { findLocalRepos, loadSettings, rememberRadio, saveSettings, soundsOf, type Settings } from '../core/settings.ts';
import { addSource, checkSource, removeSource } from '../core/sources.ts';
import { prepareUpdate } from '../core/update.ts';
import { listVolumes } from '../platform/volumes.ts';
import { FLASH_STEPS } from '../server/api.ts';
import { startServer } from '../server/server.ts';

const HELP = `Usage: radio-manager <command> [options]

Commands:
  status     connected radio, installed and downloaded versions
  download   check all sources for new releases and download them
  backup     copy the whole SD card of the connected radio
  update     show the plan, then back up the card and update it
  restore    list the backups of the connected radio; "restore <backup>" brings the card back to one
  flash      flash firmware: "flash" for the newest download, "flash v2.12.5" for another
  sources    list sources; "sources add <owner/repo>", "sources remove <name>"
  ui         open the browser interface

Options:
  --volume <path>   use this drive instead of detecting the radio
  --board <id>      radio type when the card has no RADIO/radio.yml, e.g. tx16s
  --no-backup       restore without backing up the card first
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
  await runBackup(p, s, card, board);
}

// alsoKeep: the backup being restored, which the clean-up must not delete
async function runBackup(p: Paths, s: Settings, card: RadioCard, board: string, alsoKeep?: string): Promise<void> {
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
  const removed = await pruneBackups(p, board, s.backupsToKeep, [...(s.keptBackups[board] ?? []), ...(alsoKeep ? [alsoKeep] : [])]);
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
    await applyPlan(card.volume, setup.plan, setup.contents);
    console.log('\nNothing to change: the SD card is already up to date.');
    return;
  }
  const resolutions = await resolveConflicts(setup.plan.filter((i) => i.action === 'conflict'));
  if ((await ask('\nBack up the card and update it? [y/N] ')) !== 'y') {
    console.log('Nothing changed.');
    return;
  }
  await runBackup(p, s, card, board);
  console.log('Updating ...');
  const r = await applyPlan(card.volume, setup.plan, setup.contents, resolutions, (pr) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${pr.done}/${pr.total}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done: ${r.written} files written, ${r.deleted} deleted, ${r.kept} kept.`);
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
    for (const n of names) console.log(`  ${n}${s.keptBackups[board]?.includes(n) ? '  kept' : ''}`);
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
  if (!noBackup) await runBackup(p, s, card, board, name);
  console.log('Restoring ...');
  const r = await applyRestore(card.volume, plan, (pr) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${pr.done}/${pr.total}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  console.log(`Done: ${r.written} files written, ${r.deleted} deleted.`);
}

const REPO_ROOT = resolve(import.meta.dirname, '../..');

async function flash(p: Paths, s: Settings, tagArg?: string, volume?: string, boardOpt?: string): Promise<void> {
  const cards = await connectedCards(volume);
  const board = boardOpt ?? (cards.length === 1 ? cards[0]!.board : undefined);
  if (!board) throw new UserError('Which radio? Connect it in "USB Storage" mode first, or pass --board.');
  const tag = tagArg ?? (await localVersions(p, 'edgetx-firmware'))[0]?.tag;
  if (!tag) throw new UserError('No firmware downloaded. Run "download" first.');
  const method = await flashMethod(p, tag, board).catch((e: Error) => {
    throw new UserError(e.message);
  });
  console.log(`Flashing EdgeTX ${tag} to the ${radioName(await radioTypes(p, s), board)} (was ${s.radios[board]?.firmware ?? 'unknown'}).\n`);
  FLASH_STEPS[method].forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log('\nWaiting for the radio (Ctrl+C to cancel) ...');
  let last = '';
  const r = await flashFirmware(p, board, tag, {
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
  console.log(`Done: ${r.file} written. The radio restarts with EdgeTX ${tag}.`);
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

async function ui(p: Paths): Promise<void> {
  const staticDir = join(REPO_ROOT, 'dist', 'ui');
  if (!existsSync(join(staticDir, 'index.html'))) throw new UserError('Build the interface first: npm run build');
  const server = await startServer({ paths: p, port: 5174, staticDir, repoParent: dirname(REPO_ROOT) }).catch((e: NodeJS.ErrnoException) => {
    throw new UserError(e.code === 'EADDRINUSE' ? 'Port 5174 is in use; is radio-manager already running?' : e.message);
  });
  console.log(`Radio Manager runs at ${server.url} (Ctrl+C to stop)`);
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', server.url]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url]);
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { volume: { type: 'string' }, board: { type: 'string' }, 'no-backup': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
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
    case 'ui':
      return ui(p);
    case 'flash':
      return flash(p, s, positionals[1], values.volume, values.board);
    default:
      throw new UserError(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof UserError || e instanceof AppError ? e.message : e);
  process.exitCode = 1;
});
