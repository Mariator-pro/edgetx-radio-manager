import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { backupFirmware, listBackups } from '../core/backup.ts';
import { cardLabel, ID_FILE, readIdentity, type CardIdentity, type InstalledList, type RadioCard } from '../core/card.ts';
import { localVersion, sameOnCard, voicesChanged } from '../core/content.ts';
import type { PackageState } from '../core/initialize.ts';
import { folderSize, installedOn, localVersions, mainInfo, mainVersion, versionDir } from '../core/packages.ts';
import type { Paths } from '../core/paths.ts';
import { cardStatus, modelEntries, readModels, type CopyItem, type DeleteItem, type ModelCache, type ModelFile } from '../core/models.ts';
import { countActions, type PlanItem } from '../core/plan.ts';
import { isBelowMin, radioName, radioTypes, type RadioType } from '../core/radios.ts';
import { updateSources } from '../core/selection.ts';
import { soundsOf, voiceLanguage, type Settings } from '../core/settings.ts';
import type { RestorePlan } from '../core/restore.ts';
import type { UpdateSetup } from '../core/update.ts';
import type {
  BackupView,
  CardModelView,
  CopyItemView,
  ModelRef,
  ModelsPlanView,
  ModelsView,
  PackageView,
  PlanFileView,
  PlanView,
  RestorePlanView,
  RadioSourceView,
  RadioView,
  SourceView,
  StateView,
  VoiceView,
} from './api.ts';

export async function sourceViews(p: Paths, s: Settings): Promise<SourceView[]> {
  return Promise.all(
    s.sources.map(async (src) => {
      const [newest] = await localVersions(p, src.name);
      const main = await mainInfo(p, src.name);
      return {
        name: src.name,
        repo: src.repo,
        kind: src.kind,
        localDir: src.localDir,
        newest: newest && { tag: newest.tag, published: newest.published },
        main: main && mainVersion(main),
        local: await localVersion(src),
      };
    }),
  );
}

// Reading a card (checkCard): the packages not done yet, the list as far as it got, and what it found.
export interface CardCheckView {
  running: boolean;
  pending: Set<string>;
  list?: InstalledList;
  states?: PackageState[];
}

// Id and name of the card a backup is from, read again only when its radio.json changes.
const identities = new Map<string, CardIdentity>();
async function backupIdentity(p: Paths, board: string, name: string): Promise<CardIdentity> {
  const dir = join(p.backups, board, name);
  const key = `${dir}|${(await stat(join(dir, ID_FILE)).catch(() => undefined))?.mtimeMs ?? 'none'}`;
  if (!identities.has(key)) identities.set(key, await readIdentity(dir));
  return identities.get(key)!;
}

// The SD cards the app knows of a radio type, from its backups and the connected cards: id -> name.
async function knownCards(p: Paths, board: string, connected: CardIdentity[] = []): Promise<Map<string, string | undefined>> {
  const known = new Map<string, string | undefined>();
  for (const name of await listBackups(p, board)) {
    const id = await backupIdentity(p, board, name);
    if (id.cardId) known.set(id.cardId, id.cardName);
  }
  for (const c of connected) if (c.cardId) known.set(c.cardId, c.cardName);
  return known;
}

export async function radioView(
  p: Paths,
  s: Settings,
  card: RadioCard,
  board: string | undefined,
  sources: SourceView[],
  types: RadioType[],
  check?: CardCheckView,
): Promise<RadioView> {
  const r = board ? s.radios[board] : undefined;
  const sel = r?.sources ?? {};
  const read: RadioCard = { ...card, installed: check?.list ?? card.installed };
  const radioSources: RadioSourceView[] = await Promise.all(updateSources(s).map(async (src) => {
    const view = sources.find((x) => x.name === src.name);
    const choice = sel[src.name] ?? { on: false, origin: 'release' as const };
    const checking = !!check?.running && check.pending.has(src.name);
    const listed = checking ? undefined : read.installed?.packages[src.name]?.version;
    const state = listed ? check?.states?.find((x) => x.name === src.name) : undefined;
    const available = { release: view?.newest?.tag, main: view?.main, local: view?.local }[choice.origin];
    // another label for the same files (e.g. "local abc1234" and "main abc1234") is no update
    const same =
      choice.on && !!listed && !!available && listed !== available && src.kind === 'project' && (await sameOnCard(p, src, read, choice.origin));
    const voices = choice.on && !checking && src.kind === 'sounds' && (!!listed || !!read.soundLanguages) && voicesChanged(read, src.name, soundsOf(r));
    return {
      name: src.name,
      repo: src.repo,
      kind: src.kind,
      on: choice.on,
      origin: choice.origin,
      fixed: src.kind === 'sdcard',
      installed: same ? available : listed,
      ...(checking ? { checking } : {}),
      ...(state?.missing.length ? { missing: state.missing } : {}),
      ...(state?.changed.length ? { changed: state.changed } : {}),
      available,
      ...(voices ? { voicesChanged: true } : {}),
      hasRelease: !!view?.newest,
      hasMain: !!view?.main,
      releaseOnly: !!src.file && !src.file.repoPath,
      hasLocal: !!view?.local,
    };
  }));
  // switched on with a newer version, other voices or files missing; switched off and on the card
  const updates = radioSources
    .filter((x) => !x.checking && ((x.on && ((x.available && x.available !== x.installed) || x.voicesChanged || x.missing)) || (!x.on && x.installed)))
    .map((x) => x.name);
  const backups = board ? await listBackups(p, board) : [];
  const fwSource = sources.find((x) => x.kind === 'firmware');
  const fw = fwSource?.newest?.tag.replace(/^v/, '');
  const fwVersions = fwSource ? await localVersions(p, fwSource.name) : [];
  const type = radioName(types, board);
  const several = !!board && (await knownCards(p, board, [card])).size > 1;
  return {
    volume: card.volume,
    board,
    name: type,
    label: cardLabel(type, card, several),
    ...(card.cardName ? { cardName: card.cardName } : {}),
    firmware: card.firmware,
    firmwareAvailable: fw,
    firmwareNames: Object.fromEntries(fwVersions.filter((v) => v.name).map((v) => [v.tag.replace(/^v/, ''), v.name!])),
    belowMin: !!card.firmware && isBelowMin(card.firmware),
    language: card.language,
    sounds: soundsOf(r),
    sources: radioSources,
    updates,
    checking: !!check?.running,
    lastBackup: backups[0],
    backups: backups.length,
  };
}

export async function stateView(
  p: Paths,
  s: Settings,
  cards: RadioCard[],
  boards: Map<string, string>,
  busy?: string,
  checks?: Map<string, CardCheckView>,
): Promise<StateView> {
  const sources = await sourceViews(p, s);
  const types = await radioTypes(p, s);
  const radios = await Promise.all(cards.map((c) => radioView(p, s, c, c.board ?? boards.get(c.volume), sources, types, checks?.get(c.volume))));
  return { radios, sources, busy, lastCheck: s.lastCheck, backupsToKeep: s.backupsToKeep };
}

function fileView(item: PlanItem): PlanFileView {
  const others = item.wanted?.from.filter((n) => n !== item.wanted!.written) ?? [];
  return { path: item.path, action: item.action, pkg: item.pkg, reason: item.reason, others: others.length > 0 ? others : undefined };
}

// "/Users/me/Library/…" -> "~/Library/…"; Windows paths stay as they are, "~" means nothing there.
function shortHome(path: string): string {
  const home = homedir();
  return process.platform !== 'win32' && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export async function planView(p: Paths, volume: string, board: string, card: RadioCard, setup: UpdateSetup): Promise<PlanView> {
  const changed = setup.plan.filter((i) => i.action !== 'unchanged');
  const names = [...new Set(changed.map((i) => i.pkg))];
  const groups = names.map((name) => ({
    name,
    from: card.installed?.packages[name]?.version,
    to: setup.contents.find((c) => c.name === name)?.version,
    files: changed.filter((i) => i.pkg === name).map(fileView),
  }));
  let luac = 0;
  for (const i of changed) {
    if (i.path.endsWith('.lua') && (await stat(join(volume, `${i.path}c`)).catch(() => undefined))) luac++;
  }
  return {
    volume,
    board,
    counts: countActions(setup.plan),
    groups,
    conflicts: changed.filter((i) => i.action === 'conflict').map(fileView),
    missing: setup.missing,
    luac,
    backupDir: shortHome(join(p.backups, board)),
  };
}

// Whether a backup is from this SD card, another one, or from before cards had an id.
export async function restoreOrigin(p: Paths, card: RadioCard, board: string, name: string): Promise<RestorePlanView['origin']> {
  const from = (await backupIdentity(p, board, name)).cardId;
  return !from ? 'unknown' : from === card.cardId ? 'same' : 'other';
}

export async function restorePlanView(p: Paths, card: RadioCard, board: string, name: string, plan: RestorePlan): Promise<RestorePlanView> {
  const count = (a: string) => plan.items.filter((i) => i.action === a).length;
  return {
    origin: await restoreOrigin(p, card, board, name),
    volume: card.volume,
    board,
    name,
    counts: { add: count('add'), replace: count('replace'), delete: count('delete') },
    unchanged: plan.unchanged,
    files: plan.items,
    backupFirmware: plan.firmware,
    cardFirmware: card.firmware,
    backupDir: shortHome(join(p.backups, board)),
  };
}

export async function packageViews(p: Paths, s: Settings): Promise<PackageView[]> {
  return Promise.all(
    s.sources.map(async (src) => ({
      name: src.name,
      kind: src.kind,
      versions: await Promise.all(
        (await localVersions(p, src.name)).map(async (v) => ({
          tag: v.tag,
          published: v.published,
          bytes: await folderSize(versionDir(p, src.name, v.tag)),
          installedOn: installedOn(s, src.name, v.tag),
        })),
      ),
    })),
  );
}

// connected: the cards connected now, by radio type, to mark the backups that are from them.
export async function backupViews(p: Paths, s: Settings, connected: (CardIdentity & { board?: string })[] = []): Promise<BackupView[]> {
  const types = await radioTypes(p, s);
  const boards = (await readdir(p.backups, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  return Promise.all(
    boards.sort().map(async (board) => {
      const kept = s.keptBackups[board] ?? [];
      const names = await listBackups(p, board);
      const here = connected.filter((c) => c.board === board);
      const known = await knownCards(p, board, here);
      const type = radioName(types, board);
      const items = await Promise.all(
        names.map(async (name) => {
          const id = await backupIdentity(p, board, name);
          // the name the card has now, else the one it had in the backup
          const card = id.cardId ? { ...id, cardName: known.get(id.cardId) ?? id.cardName } : undefined;
          return {
            name,
            bytes: await folderSize(join(p.backups, board, name)),
            kept: kept.includes(name),
            firmware: await backupFirmware(join(p.backups, board, name)),
            ...s.backupInfo[board]?.[name],
            ...(card ? { card: cardLabel(type, card, known.size > 1) } : {}),
            ...(card && here.some((c) => c.cardId === card.cardId) ? { thisCard: true } : {}),
          };
        }),
      );
      return { board, radio: radioName(types, board), items };
    }),
  );
}

const cardModelView = (m: ModelFile): CardModelView => ({ name: m.name, file: m.file, ...(m.semver ? { semver: m.semver } : {}), labels: m.labels });

// The models of a radio from its backups, compared with the connected card (card: its volume and type).
export async function modelsView(
  p: Paths,
  s: Settings,
  board: string,
  card: { volume: string; board?: string } | undefined,
  cache: ModelCache,
): Promise<ModelsView> {
  const types = await radioTypes(p, s);
  const dirs = (await readdir(p.backups, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  const boards = [];
  for (const b of dirs.sort()) if ((await listBackups(p, b)).length > 0) boards.push({ board: b, radio: radioName(types, b) });
  const entries = await modelEntries(p, board, cache);
  const onCard = card ? await readModels(card.volume) : [];
  const view: ModelsView = {
    board,
    radio: radioName(types, board),
    boards,
    entries: entries.map((e) => {
      const { versions, ...rest } = e;
      const st = card ? cardStatus(e, onCard) : undefined;
      return {
        ...rest,
        versions: versions.map(({ sha: _sha, ...v }) => v),
        ...(st ? { card: st.status } : {}),
        ...(st?.version !== undefined ? { cardVersion: st.version } : {}),
      };
    }),
    onlyOnCard:
      card && card.board === board ? onCard.filter((m) => !entries.some((e) => e.name === m.name)).map(cardModelView) : [],
  };
  if (card) view.card = { volume: card.volume, ...(card.board ? { board: card.board } : {}), radio: radioName(types, card.board), models: onCard.map(cardModelView) };
  return view;
}

export function copyItemView(i: CopyItem, ref: ModelRef): CopyItemView {
  const { model: _m, origin: _o, image, checklist, ...rest } = i;
  return {
    ...rest,
    ref,
    ...(image ? { image: { path: image.path, action: image.action } } : {}),
    ...(checklist ? { checklist: { path: checklist.path, action: checklist.action } } : {}),
  };
}

export function modelsPlanView(p: Paths, volume: string, board: string, copy: CopyItemView[], del: DeleteItem[], confirm: boolean): ModelsPlanView {
  return { volume, board, copy, delete: del, confirm, backupDir: shortHome(join(p.backups, board)) };
}

const SOUND_ZIP = /^edgetx-sdcard-sounds-(.+)-\d[\d.]*\.zip$/;

// All sound packs: from the file list of the newest sounds release as the last check for updates found it,
// for older downloads without that list from the downloaded zips.
export async function voiceViews(p: Paths, s: Settings): Promise<VoiceView[]> {
  const src = s.sources.find((x) => x.kind === 'sounds');
  const versions = src ? await localVersions(p, src.name) : [];
  const names = versions[0]?.assets ?? [];
  if (names.length === 0) for (const v of versions) names.push(...(await readdir(versionDir(p, src!.name, v.tag))));
  const ids = new Set(names.map((n) => n.match(SOUND_ZIP)?.[1]).filter((id): id is string => !!id));
  for (const r of Object.values(s.radios)) for (const id of soundsOf(r)) ids.add(id);
  const label = (id: string) => {
    if (!/[_-]/.test(id)) return 'Standard';
    const [region, ...voice] = id.split('-');
    const nice = voice.join(' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return nice ? `${nice} (${region})` : region!;
  };
  return [...ids]
    .map((id) => ({ id, language: voiceLanguage(id), label: label(id) }))
    .sort((a, b) => a.language.localeCompare(b.language) || (a.id === a.language ? -1 : b.id === b.language ? 1 : a.id.localeCompare(b.id)));
}
