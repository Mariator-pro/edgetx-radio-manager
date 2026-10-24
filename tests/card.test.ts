import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCards, installedVersion, parseRadioYml, readCard } from '../src/core/card.ts';
import { isBelowMin, parseRadioTypes, radioName } from '../src/core/radios.ts';
import { parseMounts } from '../src/platform/volumes.ts';
import { SDCARD_JSON, tempDir, writeTree } from './helpers.ts';

describe('radio.yml', () => {
  it('reads board, firmware and language from a real file', async () => {
    const text = await readFile(join(import.meta.dirname, 'fixtures', 'radio.yml'), 'utf8');
    expect(parseRadioYml(text)).toEqual({ board: 'tx16s', firmware: '3.0.0', language: 'en' });
  });

  it('leaves missing keys undefined', () => {
    expect(parseRadioYml('board: tx15\n')).toEqual({ board: 'tx15', firmware: undefined, language: undefined });
  });
});

describe('Linux drives', () => {
  it('takes FAT and exFAT mounts from /proc/mounts, with spaces in names, but not the EFI partition', () => {
    const mounts = [
      '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
      '/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0',
      '/dev/sda1 /media/pilot/TX15 vfat rw,nosuid,nodev,uid=1000 0 0',
      '/dev/sdb1 /run/media/pilot/RADIO\\040CARD exfat rw,nosuid 0 0',
      '/dev/sdc /media/pilot/RPI-RP2 msdos rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
    ].join('\n');
    expect(parseMounts(mounts)).toEqual(['/media/pilot/TX15', '/run/media/pilot/RADIO CARD', '/media/pilot/RPI-RP2']);
  });
});

describe('readCard', () => {
  it('needs RADIO/ and MODELS/', async () => {
    const root = await tempDir();
    await writeTree(root, { 'RADIO/README.txt': '' });
    expect(await readCard(root)).toBeUndefined();
  });

  it('reads radio.yml and the installed list', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'RADIO/radio.yml': 'semver: 2.12.3\nboard: tx16smk3\nttsLanguage: "de"\n',
      'MODELS/model00.yml': '',
      '.radio-manager/installed.json': JSON.stringify({ packages: { 'lipo-nanny': { version: 'v1.1.1', origin: 'release' } } }),
    });
    const card = await readCard(root);
    expect(card).toMatchObject({ volume: root, board: 'tx16smk3', firmware: '2.12.3', language: 'de' });
    expect(card?.installed?.packages['lipo-nanny']?.version).toBe('v1.1.1');
  });

  it('reads the SD content version EdgeTX leaves on the card', async () => {
    const root = await tempDir();
    await writeTree(root, { 'RADIO/radio.yml': 'board: tx16smk3\n', 'MODELS/x': '', 'edgetx.sdcard.version': '2.12.1\n' });
    const card = (await readCard(root))!;
    expect(card.sdcardVersion).toBe('2.12.1');
    expect(installedVersion(card, 'edgetx-sdcard', 'sdcard')).toBe('v2.12.1');
    expect(installedVersion(card, 'lipo-nanny', 'project')).toBeUndefined();
    card.installed = { tool: 1, updated: '', packages: { 'edgetx-sdcard': { version: 'v2.12.3', origin: 'release' } }, files: {} };
    expect(installedVersion(card, 'edgetx-sdcard', 'sdcard')).toBe('v2.12.3');
  });

  it('finds the sound languages EdgeTX put on the card', async () => {
    const root = await tempDir();
    await writeTree(root, {
      'RADIO/radio.yml': 'board: tx16smk3\n',
      'MODELS/x': '',
      'SOUNDS/de/SYSTEM/hello.wav': '',
      'SOUNDS/en/SYSTEM/hello.wav': '',
      'SOUNDS/fr/SCRIPTS/LIPONY/a.wav': '',
    });
    expect((await readCard(root))!.soundLanguages).toEqual(['de', 'en']);
  });

  it('accepts a new card without radio.yml', async () => {
    const root = await tempDir();
    await writeTree(root, { 'RADIO/README.txt': '', 'MODELS/README.txt': '' });
    expect(await readCard(root)).toEqual({ volume: root });
  });

  it('finds only radio cards among drives', async () => {
    const radio = await tempDir();
    const other = await tempDir();
    await writeTree(radio, { 'RADIO/radio.yml': 'board: tx15\n', 'MODELS/x': '' });
    await writeTree(other, { 'Photos/a.jpg': '' });
    expect((await findCards([radio, other])).map((c) => c.volume)).toEqual([radio]);
  });
});

describe('radios', () => {
  it('reads the radios from sdcard.json and names them', () => {
    const types = parseRadioTypes(SDCARD_JSON);
    expect(types[2]).toEqual({ board: 'tx16smk3', name: 'RadioMaster TX16S MK3', sdPackage: 'c800x480' });
    expect(radioName(types, 'tx16smk3')).toBe('RadioMaster TX16S MK3');
    expect(radioName(types, 'x9e')).toBe('x9e');
    expect(radioName([], undefined)).toBe('unknown radio');
  });

  it('checks the minimum EdgeTX version', () => {
    expect(isBelowMin('2.11.4')).toBe(true);
    expect(isBelowMin('2.12.0')).toBe(false);
    expect(isBelowMin('2.12.5-rc1')).toBe(false);
    expect(isBelowMin('3.0.0')).toBe(false);
  });
});
