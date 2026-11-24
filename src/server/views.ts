import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupFirmware, cardBackups, listBackups } from '../core/backup.ts';
import { cardLabel, shortId, type InstalledList, type RadioCard } from '../core/card.ts';
import { backupBoards, backupIdentity, backupsWithoutId, knownRadios, labelOfKey, type ConnectedCard, type KnownRadio } from '../core/known-radios.ts';
import { localVersion, sameOnCard, voicesChanged } from '../core/content.ts';
import type { PackageState } from '../core/initialize.ts';
import { folderSize, installedOn, localVersions, mainInfo, mainVersion, versionDir } from '../core/packages.ts';
import type { Paths } from '../core/paths.ts';
import { cardStatus, modelEntries, readModels, type CopyItem, type DeleteItem, type ModelCache, type ModelFile } from '../core/models.ts';
import { countActions, type PlanItem } from '../core/plan.ts';
import { isBelowMin, radioName, radioTypes, type RadioType } from '../core/radios.ts';
import { updateSources } from '../core/selection.ts';
import { radioKey, soundsOf, voiceLanguage, type Settings } from '../core/settings.ts';
import type { RestorePlan } from '../core/restore.ts';
import type { UpdateSetup } from '../core/update.ts';
import type {
  BackupItemView,
  BackupView,
  KnownRadioView,
  RadioChoiceView,
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

async function sourceViews(p: Paths, s: Settings): Promise<SourceView[]> {
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

export async function radioView(
  p: Paths,
  s: Settings,
  card: RadioCard,
  board: string | undefined,
  sources: SourceView[],
  types: RadioType[],
  check?: CardCheckView,
): Promise<RadioView> {
  const r = board ? s.radios[radioKey(board, card.cardId)] : undefined;
  const sel = r?.sources ?? {};
  const read: RadioCard = { ...card, installed: check?.list ?? card.installed };
  const reading = check?.running ?? !!board; // a card with a type is read right after it shows up
  const radioSources: RadioSourceView[] = await Promise.all(updateSources(s).map(async (src) => {
    const view = sources.find((x) => x.name === src.name);
    // while the card is read, what is on it so far: the selection follows the card once reading is done
    const onCard = reading ? read.installed?.packages[src.name] : undefined;
    const choice = reading
      ? { on: src.kind === 'sdcard' || !!onCard, origin: onCard?.origin ?? sel[src.name]?.origin ?? ('release' as const) }
      : (sel[src.name] ?? { on: false, origin: 'release' as const });
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
      ...(reading ? { reading } : {}),
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
    .filter((x) => !x.reading && ((x.on && ((x.available && x.available !== x.installed) || x.voicesChanged || x.missing)) || (!x.on && x.installed)))
    .map((x) => x.name);
  // this card's backups: its own and those from before cards had an id
  const backups: string[] = [];
  for (const name of board ? await listBackups(p, board) : []) {
    const id = (await backupIdentity(p, board!, name)).cardId;
    if (!id || id === card.cardId) backups.push(name);
  }
  const fwSource = sources.find((x) => x.kind === 'firmware');
  const fw = fwSource?.newest?.tag.replace(/^v/, '');
  const fwVersions = fwSource ? await localVersions(p, fwSource.name) : [];
  const type = radioName(types, board);
  return {
    volume: card.volume,
    board,
    name: type,
    label: cardLabel(type, card),
    ...(card.cardName ? { cardName: card.cardName } : {}),
    ...(card.cardPilot ? { cardPilot: card.cardPilot } : {}),
    firmware: card.firmware,
    firmwareAvailable: fw,
    firmwareNames: Object.fromEntries(fwVersions.filter((v) => v.name).map((v) => [v.tag.replace(/^v/, ''), v.name!])),
    belowMin: !!card.firmware && isBelowMin(card.firmware),
    language: card.language,
    sounds: soundsOf(r),
    sources: radioSources,
    updates,
    checking: reading,
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

export async function planView(volume: string, board: string, card: RadioCard, setup: UpdateSetup): Promise<PlanView> {
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
  };
}

export async function packageViews(p: Paths, s: Settings): Promise<PackageView[]> {
  const types = await radioTypes(p, s);
  return Promise.all(
    s.sources.map(async (src) => ({
      name: src.name,
      kind: src.kind,
      versions: await Promise.all(
        (await localVersions(p, src.name)).map(async (v) => ({
          tag: v.tag,
          published: v.published,
          bytes: await folderSize(versionDir(p, src.name, v.tag)),
          installedOn: installedOn(s, src.name, v.tag).map((key) => labelOfKey(s, types, key)),
        })),
      ),
    })),
  );
}

const choiceOf = (r: KnownRadio): RadioChoiceView => ({
  key: r.key,
  board: r.board,
  type: r.type,
  ...(r.name ? { name: r.name } : {}),
  ...(r.cardId ? { cardId: r.cardId, idShort: shortId(r.cardId) } : {}),
  ...(r.volume ? { volume: r.volume } : {}),
  ...(r.test ? { test: true } : {}),
});

// The entries of the "Radio" choice, in the order of the radios page: each SD card with backups or connected now,
// then per type the backups from before cards had an id. backups: the backup folders each entry shows.
async function radioChoices(p: Paths, s: Settings, connected: ConnectedCard[]): Promise<(RadioChoiceView & { backups: string[] })[]> {
  const radios = await knownRadios(p, s, connected);
  const out = radios.filter((r) => r.cardId && (r.backups.length > 0 || r.volume)).map((r) => ({ ...choiceOf(r), backups: r.backups }));
  const types = await radioTypes(p, s);
  for (const board of await backupBoards(p)) {
    const names = await backupsWithoutId(p, board);
    if (names.length > 0) out.push({ key: board, board, type: radioName(types, board), unknown: true, backups: names });
  }
  return out;
}

// The radios page: every radio in the settings or connected now; one known only from its backups was forgotten.
export async function radiosView(p: Paths, s: Settings, connected: ConnectedCard[]): Promise<KnownRadioView[]> {
  return (await knownRadios(p, s, connected))
    .filter((r) => r.inSettings || r.volume)
    .map((r) => ({
      ...choiceOf(r),
      ...(r.pilot ? { pilot: r.pilot } : {}),
      ...(r.seen ? { seen: r.seen } : {}),
      ...(r.firmware ? { firmware: r.firmware } : {}),
      packages: Object.entries(r.installed).map(([name, version]) => ({ name, version })),
      backups: r.backups.length,
      kept: r.kept.length,
    }));
}

// The backups page: one entry per SD card, in the order of the radios page, each with only its own backups.
export async function backupViews(p: Paths, s: Settings, connected: ConnectedCard[] = []): Promise<BackupView[]> {
  return Promise.all(
    (await radioChoices(p, s, connected)).map(async ({ backups, ...choice }) => {
      const kept = s.keptBackups[choice.board] ?? [];
      const items = await Promise.all(
        backups.map(async (name): Promise<BackupItemView> => ({
          name,
          bytes: await folderSize(join(p.backups, choice.board, name)),
          kept: kept.includes(name),
          firmware: await backupFirmware(join(p.backups, choice.board, name)),
          ...s.backupInfo[choice.board]?.[name],
        })),
      );
      return { ...choice, items };
    }),
  );
}

const cardModelView = (m: ModelFile): CardModelView => ({ name: m.name, file: m.file, ...(m.semver ? { semver: m.semver } : {}), labels: m.labels });

// The models of an SD card (or of the backups of a type without an id) from its backups, compared with the radio
// chosen in the app (card). Without a source asked for, the chosen radio's own; else the first, which is the one
// connected last.
export async function modelsView(
  p: Paths,
  s: Settings,
  wanted: string | undefined,
  card: ConnectedCard | undefined,
  cache: ModelCache,
  connected: ConnectedCard[] = [],
): Promise<ModelsView> {
  const types = await radioTypes(p, s);
  const choices = await radioChoices(p, s, connected);
  const sources = choices.map(({ backups: _b, ...c }) => c);
  const own = card?.board ? radioKey(card.board, card.cardId) : undefined;
  const source = sources.find((x) => x.key === wanted) ?? (wanted ? undefined : (sources.find((x) => x.key === own) ?? sources[0]));
  const board = source?.board ?? '';
  // a card's models come from its own backups and those from before cards had an id
  const names = source ? (source.cardId ? await cardBackups(p, board, source.cardId) : choices.find((c) => c.key === source.key)!.backups) : [];
  const entries = source ? await modelEntries(p, board, cache, names) : [];
  const onCard = card ? await readModels(card.volume) : [];
  const view: ModelsView = {
    board,
    source: source?.key ?? '',
    radio: source ? (source.name ?? source.type) : radioName(types, board),
    sources,
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

export function modelsPlanView(volume: string, board: string, copy: CopyItemView[], del: DeleteItem[], confirm: boolean): ModelsPlanView {
  return { volume, board, copy, delete: del, confirm };
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
