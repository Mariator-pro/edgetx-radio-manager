import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listBackups } from '../src/core/backup.ts';
import { isTestId, readIdentity, setCardName, shortId } from '../src/core/card.ts';
import { AppError } from '../src/core/errors.ts';
import { findRadioKey, forgetRadio, knownRadios, labelOfKey, radioLabel } from '../src/core/known-radios.ts';
import { deleteVersion, installedOn } from '../src/core/packages.ts';
import { paths, type Paths } from '../src/core/paths.ts';
import { defaultSettings, markSeen, rememberRadio, type Settings } from '../src/core/settings.ts';
import { tempDir, writeTree } from './helpers.ts';

const RADIO = 'semver: 2.12.5\nboard: tx15\n';

// A backup folder of an SD card: with an id (and name, pilot), or without one like those from before cards had ids.
async function backup(p: Paths, board: string, name: string, id?: { id: string; name?: string; pilot?: string }) {
  await writeTree(join(p.backups, board, name), {
    'RADIO/radio.yml': RADIO,
    'MODELS/model1.yml': 'header: {}\n',
    ...(id ? { '.radio-manager/radio.json': JSON.stringify(id) } : {}),
  });
}

async function setup(): Promise<{ p: Paths; s: Settings }> {
  const p = paths(await tempDir());
  const s = defaultSettings();
  return { p, s };
}

describe('name and pilot on the SD card', () => {
  it('keeps the pilot next to id and name, and leaves it when only the name changes', async () => {
    const card = await tempDir();
    await writeTree(card, { 'RADIO/radio.yml': RADIO, 'MODELS/m.yml': '' });
    await setCardName(card, 'TX15 Wing', 'Alex');
    const first = await readIdentity(card);
    expect(first).toMatchObject({ cardName: 'TX15 Wing', cardPilot: 'Alex', cardId: expect.any(String) });
    expect(JSON.parse(await readFile(join(card, '.radio-manager/radio.json'), 'utf8'))).toEqual({ id: first.cardId, name: 'TX15 Wing', pilot: 'Alex' });
    await setCardName(card, 'Wing'); // without a pilot given, the card keeps its own
    expect(await readIdentity(card)).toEqual({ cardId: first.cardId, cardName: 'Wing', cardPilot: 'Alex' });
    await setCardName(card, 'Wing', ''); // an empty one takes it away
    expect(await readIdentity(card)).toEqual({ cardId: first.cardId, cardName: 'Wing' });
  });

  it('tells test cards by their id', () => {
    expect(isTestId('test-f5226899-85c3')).toBe(true);
    expect(isTestId('5f854692-1665')).toBe(false);
    expect(shortId('test-f5226899-85c3')).toBe('test-f52');
  });
});

describe('what the app notes on connecting', () => {
  it('takes name and pilot from the card and notes the time only for a card with an id', () => {
    const s = defaultSettings();
    rememberRadio(s, { volume: '/v', board: 'tx15', cardId: 'aaaaaaaa', cardName: 'Wing', cardPilot: 'Alex' });
    expect(s.radios['tx15/aaaaaaaa']).toMatchObject({ name: 'Wing', pilot: 'Alex' });
    rememberRadio(s, { volume: '/v', board: 'tx15', cardId: 'aaaaaaaa', cardName: 'Wing' });
    expect(s.radios['tx15/aaaaaaaa']).not.toHaveProperty('pilot');
    markSeen(s, { volume: '/v', board: 'tx15', cardId: 'aaaaaaaa' }, new Date('2026-11-23T10:00:00Z'));
    expect(s.radios['tx15/aaaaaaaa']!.seen).toBe('2026-11-23T10:00:00.000Z');
    markSeen(s, { volume: '/w', board: 'tx15' }, new Date()); // no id yet: no entry by type is made
    expect(Object.keys(s.radios)).toEqual(['tx15/aaaaaaaa']);
  });
});

describe('knownRadios', () => {
  it('puts connected radios first, then by last connected, then by newest backup', async () => {
    const { p, s } = await setup();
    s.radios['tx15/aaaaaaaa'] = { seen: '2026-11-01T10:00:00Z' };
    s.radios['tx15/bbbbbbbb'] = { seen: '2026-11-20T10:00:00Z', name: 'Heli' };
    s.radios['tx15/cccccccc'] = {};
    s.radios['tx16s/dddddddd'] = {};
    await backup(p, 'tx16s', '2026-11-10_1000', { id: 'dddddddd' });
    const radios = await knownRadios(p, s, [{ volume: '/v', board: 'tx15', cardId: 'aaaaaaaa', cardName: 'Wing' }]);
    expect(radios.map((r) => r.key)).toEqual(['tx15/aaaaaaaa', 'tx15/bbbbbbbb', 'tx16s/dddddddd', 'tx15/cccccccc']);
    expect(radios[0]).toMatchObject({ volume: '/v', name: 'Wing' });
    expect(radios[2]!.backups).toEqual(['2026-11-10_1000']);
  });

  it('takes name and pilot of an old entry from its newest backup, and knows forgotten radios only by their backups', async () => {
    const { p, s } = await setup();
    s.radios['tx15/aaaaaaaa'] = { installed: { 'lipo-nanny': 'v2.3.0' } };
    await backup(p, 'tx15', '2026-11-01_1000', { id: 'aaaaaaaa', name: 'Old name' });
    await backup(p, 'tx15', '2026-11-20_1000', { id: 'aaaaaaaa', name: 'TX15 Wing', pilot: 'Alex' });
    await backup(p, 'tx15', '2026-11-21_1000', { id: 'test-f5226899' });
    await backup(p, 'tx15', '2026-10-01_1000'); // from before cards had ids: belongs to no radio here
    const radios = await knownRadios(p, s);
    const wing = radios.find((r) => r.key === 'tx15/aaaaaaaa')!;
    expect(wing).toMatchObject({ name: 'TX15 Wing', pilot: 'Alex', inSettings: true, installed: { 'lipo-nanny': 'v2.3.0' } });
    expect(wing).not.toHaveProperty('seen'); // "Unknown" until it is connected again
    expect(radios.find((r) => r.cardId === 'test-f5226899')).toMatchObject({ inSettings: false, test: true });
    expect(radios).toHaveLength(2);
    expect(radioLabel(radios.find((r) => r.test)!)).toBe('tx15 (test-f52)');
  });
});

describe('forgetRadio', () => {
  it('takes the radio out of the settings and its package versions, and keeps its backups unless asked', async () => {
    const { p, s } = await setup();
    s.radios['tx15/bbbbbbbb'] = { installed: { 'lipo-nanny': 'v1.1.1' } };
    await backup(p, 'tx15', '2026-11-18_2002', { id: 'bbbbbbbb' });
    expect(installedOn(s, 'lipo-nanny', 'v1.1.1')).toEqual(['tx15/bbbbbbbb']);
    expect(await forgetRadio(p, s, 'tx15/bbbbbbbb', false)).toEqual([]);
    expect(s.radios).toEqual({});
    expect(installedOn(s, 'lipo-nanny', 'v1.1.1')).toEqual([]);
    expect(await listBackups(p, 'tx15')).toEqual(['2026-11-18_2002']);
  });

  it('deletes its own backups with their notes when asked, never those without an id', async () => {
    const { p, s } = await setup();
    s.radios['tx15/bbbbbbbb'] = {};
    await backup(p, 'tx15', '2026-11-18_2002', { id: 'bbbbbbbb' });
    await backup(p, 'tx15', '2026-11-10_1811', { id: 'bbbbbbbb' });
    await backup(p, 'tx15', '2026-11-09_1230', { id: 'aaaaaaaa' });
    await backup(p, 'tx15', '2026-10-21_2245');
    s.keptBackups.tx15 = ['2026-11-10_1811', '2026-11-09_1230'];
    s.backupInfo.tx15 = { '2026-11-18_2002': { reason: 'manual', note: 'heli' }, '2026-11-09_1230': { reason: 'manual' } };
    expect((await forgetRadio(p, s, 'tx15/bbbbbbbb', true)).sort()).toEqual(['2026-11-10_1811', '2026-11-18_2002']);
    expect(await listBackups(p, 'tx15')).toEqual(['2026-11-09_1230', '2026-10-21_2245']);
    expect(s.keptBackups.tx15).toEqual(['2026-11-09_1230']);
    expect(Object.keys(s.backupInfo.tx15)).toEqual(['2026-11-09_1230']);
  });

  it('refuses a key that leads elsewhere and one it doesn’t know', async () => {
    const { p, s } = await setup();
    await expect(forgetRadio(p, s, '../tx15/aaaaaaaa', false)).rejects.toThrow(AppError);
    await expect(forgetRadio(p, s, '__proto__', false)).rejects.toThrow(AppError);
    await expect(forgetRadio(p, s, 'tx15/aaaaaaaa', false)).rejects.toMatchObject({ code: 'radioUnknown' });
  });
});

describe('radios in package versions and the terminal', () => {
  it('names the radios that hold a version when it can’t be deleted', async () => {
    const { p, s } = await setup();
    s.radios['tx15/aaaaaaaa'] = { name: 'TX15 Wing', installed: { 'lipo-nanny': 'v2.3.0' } };
    s.radios['tx15/bbbbbbbb'] = { installed: { 'lipo-nanny': 'v2.3.0' } };
    expect(labelOfKey(s, [], 'tx15/bbbbbbbb')).toBe('tx15 (bbbbbbbb)');
    await expect(deleteVersion(p, s, 'lipo-nanny', 'v2.3.0', (k) => labelOfKey(s, [], k))).rejects.toThrow(
      'lipo-nanny v2.3.0 is installed on TX15 Wing, tx15 (bbbbbbbb), so you can’t delete it.',
    );
  });

  it('finds a radio by the start of its id, once', async () => {
    const { p, s } = await setup();
    s.radios['tx15/5f854692-1665'] = {};
    s.radios['tx15/5f99aaaa-0000'] = {};
    s.radios.pocket = {};
    const radios = await knownRadios(p, s);
    expect(findRadioKey(radios, '5f854').key).toBe('tx15/5f854692-1665');
    expect(findRadioKey(radios, 'pocket').key).toBe('pocket');
    expect(() => findRadioKey(radios, '5f')).toThrow(expect.objectContaining({ code: 'radioAmbiguous' }));
    expect(() => findRadioKey(radios, 'ffff')).toThrow(expect.objectContaining({ code: 'radioUnknown' }));
  });
});
