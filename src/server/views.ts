import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listBackups } from '../core/backup.ts';
import { installedVersion, type RadioCard } from '../core/card.ts';
import { detectVersion, localVersion, sameOnCard } from '../core/content.ts';
import { latestRelease } from '../core/github.ts';
import { folderSize, installedOn, localVersions, mainInfo, mainVersion, versionDir } from '../core/packages.ts';
import type { Paths } from '../core/paths.ts';
import { countActions, type PlanItem } from '../core/plan.ts';
import { isBelowMin, radioName, radioTypes, type RadioType } from '../core/radios.ts';
import { updateSources } from '../core/selection.ts';
import { soundsOf, voiceLanguage, type Settings } from '../core/settings.ts';
import type { UpdateSetup } from '../core/update.ts';
import type {
  BackupView,
  PackageView,
  PlanFileView,
  PlanView,
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

export async function radioView(
  p: Paths,
  s: Settings,
  card: RadioCard,
  board: string | undefined,
  sources: SourceView[],
  types: RadioType[],
): Promise<RadioView> {
  const r = board ? s.radios[board] : undefined;
  const sel = r?.sources ?? {};
  const radioSources: RadioSourceView[] = await Promise.all(updateSources(s).map(async (src) => {
    const view = sources.find((x) => x.name === src.name);
    const choice = sel[src.name] ?? { on: false, origin: 'release' as const };
    const listed = installedVersion(card, src.name, src.kind);
    // a project copied by hand: its version comes from comparing the card with the downloads
    const found = !listed && src.kind === 'project' ? await detectVersion(p, src, card.volume, choice.origin) : undefined;
    const available = { release: view?.newest?.tag, main: view?.main, local: view?.local }[choice.origin];
    // another label for the same files (e.g. "local abc1234" and "main abc1234") is no update
    const same =
      choice.on && !!listed && !!available && listed !== available && src.kind === 'project' && (await sameOnCard(p, src, card, choice.origin));
    return {
      name: src.name,
      repo: src.repo,
      kind: src.kind,
      on: choice.on,
      origin: choice.origin,
      isNew: r?.newSources?.includes(src.name) ?? false,
      fixed: src.kind === 'sdcard',
      installed: same ? available : (listed ?? found?.version),
      found: found?.version ? ('match' as const) : found?.onCard ? ('unknown' as const) : undefined,
      available,
      hasRelease: !!view?.newest,
      hasMain: !!view?.main,
      releaseOnly: !!src.file && !src.file.repoPath,
      hasLocal: !!view?.local,
    };
  }));
  // switched off and on the card: listed by the tool, or copied by hand as an exact downloaded version
  const updates = radioSources
    .filter((x) => (x.on && x.available && x.available !== x.installed) || (!x.on && x.installed))
    .map((x) => x.name);
  const backups = board ? await listBackups(p, board) : [];
  const fw = sources.find((x) => x.kind === 'firmware')?.newest?.tag.replace(/^v/, '');
  return {
    volume: card.volume,
    board,
    name: radioName(types, board),
    firmware: card.firmware,
    firmwareAvailable: fw,
    belowMin: !!card.firmware && isBelowMin(card.firmware),
    language: card.language,
    sounds: soundsOf(r),
    sources: radioSources,
    updates,
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
): Promise<StateView> {
  const sources = await sourceViews(p, s);
  const types = await radioTypes(p, s);
  const radios = await Promise.all(cards.map((c) => radioView(p, s, c, c.board ?? boards.get(c.volume), sources, types)));
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

export async function backupViews(p: Paths, s: Settings): Promise<BackupView[]> {
  const types = await radioTypes(p, s);
  const boards = (await readdir(p.backups, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  return Promise.all(
    boards.sort().map(async (board) => {
      const kept = s.keptBackups[board] ?? [];
      const names = await listBackups(p, board);
      const items = await Promise.all(
        names.map(async (name) => ({ name, bytes: await folderSize(join(p.backups, board, name)), kept: kept.includes(name) })),
      );
      return { board, radio: radioName(types, board), items };
    }),
  );
}

const SOUND_ZIP = /^edgetx-sdcard-sounds-(.+)-\d[\d.]*\.zip$/;

// All sound packs: from the newest sounds release on GitHub, offline from the downloaded zips.
export async function voiceViews(p: Paths, s: Settings): Promise<VoiceView[]> {
  const src = s.sources.find((x) => x.kind === 'sounds');
  let names: string[] = [];
  try {
    names = src ? ((await latestRelease(src.repo))?.assets.map((a) => a.name) ?? []) : [];
  } catch {
    // offline: what was downloaded
  }
  if (names.length === 0 && src) {
    for (const v of await localVersions(p, src.name)) names.push(...(await readdir(versionDir(p, src.name, v.tag))));
  }
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
