import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/core/settings.ts';
import {
  checkFirmwareFile,
  firmwareCatalog,
  findUf2Drive,
  firmwareFile,
  firmwareId,
  flashFirmware,
  flashMethod,
  flashUf2,
  knownMethod,
  parseDfuList,
  parseUf2Info,
  waitFor,
} from '../src/core/firmware.ts';
import { versionDir } from '../src/core/packages.ts';
import { paths, type Paths } from '../src/core/paths.ts';
import { makeZip, tempDir, writeTree } from './helpers.ts';

async function withFirmware(): Promise<Paths> {
  const p = paths(await tempDir());
  const dir = versionDir(p, 'edgetx-firmware', 'v2.12.5');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'release.json'), JSON.stringify({ tag: 'v2.12.5', published: '2026-10-18T00:00:00Z', url: '' }));
  await writeFile(
    join(dir, 'edgetx-firmware-v2.12.5.zip'),
    makeZip({ 'tx16s-0ebe2e9.bin': 'BIN', 'tx16smk3-0ebe2e9.uf2': 'UF2-MK3', 'tx15-0ebe2e9.uf2': 'UF2-TX15', 'fw.json': '{}' }),
  );
  return p;
}

// A UF2 file as EdgeTX builds it: 512-byte blocks with 256 bytes of payload each.
function uf2(payload: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at < payload.length; at += 256) {
    const b = Buffer.alloc(512);
    b.writeUInt32LE(0x0a324655, 0);
    b.writeUInt32LE(0x9e5d5157, 4);
    const part = payload.subarray(at, at + 256);
    b.writeUInt32LE(part.length, 16);
    part.copy(b, 32);
    blocks.push(b);
  }
  return Buffer.concat(blocks);
}

// The identification string where the real tx15 and tx16s firmware v2.12.5 has it, between other bytes.
const withId = (id: string, before = 100) => Buffer.concat([Buffer.alloc(before, 0xff), Buffer.from(`${id}\0`), Buffer.alloc(300, 0)]);

const UF2_INFO = 'UF2 Bootloader v2.12.5\r\nModel: RadioMaster TX16S MK3\r\nBoard-ID: tx16smk3\r\nDate: Oct 18 2026\r\n';

describe('firmware', () => {
  it('flashes over UF2 when the zip has a .uf2 for the radio, else over DFU', async () => {
    const p = await withFirmware();
    expect(await flashMethod(p, 'v2.12.5', 'tx16s')).toBe('dfu');
    expect(await flashMethod(p, 'v2.12.5', 'tx16smk3')).toBe('uf2');
    expect(await flashMethod(p, 'v2.12.5', 'tx15')).toBe('uf2');
    await expect(flashMethod(p, 'v2.12.5', 'x9e')).rejects.toThrow(/No firmware for x9e/);
  });

  it('knows the flash method from the newest stable version, else from older ones, then release candidates', async () => {
    const p = await withFirmware();
    for (const [tag, files] of Object.entries<Record<string, string>>({ 'v2.12.4': { 'old-1a.bin': 'B', 'both-1a.bin': 'B' }, 'v2.13.0-rc1': { 'new-1a.uf2': 'U', 'both-1a.uf2': 'U' } })) {
      await mkdir(versionDir(p, 'edgetx-firmware', tag), { recursive: true });
      await writeFile(join(versionDir(p, 'edgetx-firmware', tag), `edgetx-firmware-${tag}.zip`), makeZip(files));
    }
    const versions = [{ tag: 'v2.13.0-rc1', prerelease: true }, { tag: 'v2.12.5' }, { tag: 'v2.12.4' }];
    expect(await knownMethod(p, versions, 'tx15')).toBe('uf2');
    expect(await knownMethod(p, versions, 'old')).toBe('dfu');
    expect(await knownMethod(p, versions, 'new')).toBe('uf2');
    expect(await knownMethod(p, versions, 'both')).toBe('dfu');
    expect(await knownMethod(p, versions, 'x9e')).toBeUndefined();
    expect(await knownMethod(p, [], 'tx15')).toBeUndefined();
  });

  it('takes the file of the radio type from the firmware zip', async () => {
    const p = await withFirmware();
    expect(await firmwareFile(p, 'v2.12.5', 'tx16smk3')).toEqual({ name: 'tx16smk3-0ebe2e9.uf2', data: Buffer.from('UF2-MK3') });
    expect((await firmwareFile(p, 'v2.12.5', 'tx16s')).name).toBe('tx16s-0ebe2e9.bin');
    await expect(firmwareFile(p, 'v2.12.5', 'x9e')).rejects.toThrow(/No firmware for x9e/);
    await expect(firmwareFile(p, 'v9.9.9', 'tx15')).rejects.toThrow(/not downloaded/);
  });

  it('reads the bootloader drive and refuses firmware for another radio', async () => {
    expect(parseUf2Info(UF2_INFO)).toEqual({ board: 'tx16smk3', bootloader: 'v2.12.5' });
    const other = await tempDir();
    const drive = await tempDir();
    await writeTree(drive, { 'INFO_UF2.TXT': UF2_INFO, 'CURRENT.UF2': 'old' });
    const found = (await findUf2Drive([other, drive]))!;
    expect(found).toMatchObject({ volume: drive, board: 'tx16smk3' });
    await expect(flashUf2(found, 'tx15', Buffer.from('x'))).rejects.toThrow(/is a tx16smk3/);
    await flashUf2(found, 'tx16smk3', Buffer.from('new'));
    expect(await readFile(join(drive, 'firmware.uf2'), 'utf8')).toBe('new');
  });

  it('finds the STM32 boot ROM in the dfu-util list', () => {
    const list = [
      'dfu-util 0.11',
      'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=1, name="@Option Bytes  /0x1FFFC000/01*016 e", serial="3276"',
      'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg", serial="3276"',
    ].join('\n');
    expect(parseDfuList(list)).toEqual([{ id: '0483:df11', name: '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg' }]);
  });

  it('waits for the UF2 drive, then writes firmware.uf2', async () => {
    const p = await withFirmware();
    const drive = await tempDir();
    await writeTree(drive, { 'INFO_UF2.TXT': UF2_INFO });
    const steps: string[] = [];
    let polls = 0;
    const r = await flashFirmware(p, 'tx16smk3', 'v2.12.5', {
      volumes: async () => (++polls > 1 ? [drive] : []),
      onProgress: (pr) => steps.push(pr.step),
    });
    expect(r).toEqual({ method: 'uf2', file: 'tx16smk3-0ebe2e9.uf2' });
    expect(await readFile(join(drive, 'firmware.uf2'), 'utf8')).toBe('UF2-MK3');
    expect(steps).toEqual(['waiting', 'writing']);
  });

  it('flashes the TX16S with dfu-util to the start of the internal flash', async () => {
    const p = await withFirmware();
    const bin = await tempDir();
    const log = join(bin, 'args.txt');
    const fake = join(bin, 'dfu-util');
    await writeFile(
      fake,
      `#!/bin/sh
case "$1" in
  --version) echo "dfu-util 0.11" ;;
  -l) echo 'Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-1", alt=0, name="@Internal Flash  /0x08000000/04*016Kg", serial="1"' ;;
  *) echo "$@" > "${log}"; cp "$8" "${bin}/written.bin"; printf 'Download\\t[====      ]  40%%\\rDownload\\t[==========] 100%%\\nFile downloaded successfully\\n' ;;
esac
`,
    );
    await chmod(fake, 0o755);
    const pct: number[] = [];
    const r = await flashFirmware(p, 'tx16s', 'v2.12.5', { volumes: async () => [], dfuUtil: fake, onProgress: (pr) => pr.pct !== undefined && pct.push(pr.pct) });
    expect(r.method).toBe('dfu');
    expect((await readFile(log, 'utf8')).trim()).toMatch(/^-d 0483:df11 -a 0 -s 0x08000000:leave -D .*firmware\.bin$/);
    expect(await readFile(join(bin, 'written.bin'), 'utf8')).toBe('BIN');
    expect(pct).toContain(100);
  });

  it('stops waiting when cancelled', async () => {
    const abort = new AbortController();
    const waiting = waitFor(async () => undefined, abort.signal, 60_000, 10);
    abort.abort();
    await expect(waiting).rejects.toThrow('Cancelled');
  });

  it('reads radio type and version from the firmware, also across UF2 blocks', () => {
    expect(firmwareId(withId('BOOT10edgetx-tx16s-v2.12.5 (0ebe2e98)'))).toEqual({ board: 'tx16s', version: 'v2.12.5' });
    expect(firmwareId(withId('edgetx-x9e-hall-v2.13.0-rc1 (12345678)'))).toEqual({ board: 'x9e-hall', version: 'v2.13.0-rc1' });
    // without a radio type: "edgetx-v2.12.5" is the bare version string
    expect(firmwareId(withId('edgetx-v2.12.5 (0ebe2e98) https://edgetx-user-manual/x'))).toBeUndefined();
    // the string starts 10 bytes before a block boundary, so it is split over two blocks
    expect(firmwareId(uf2(withId('edgetx-tx15-v2.12.5 (0ebe2e98)', 246)))).toEqual({ board: 'tx15', version: 'v2.12.5' });
  });

  it('checks an own file: extension, how the radio flashes, and the radio type inside', () => {
    const tx15 = uf2(withId('edgetx-tx15-v2.12.5 (0ebe2e98)'));
    expect(checkFirmwareFile('my.uf2', tx15, 'tx15', 'uf2')).toEqual({ method: 'uf2', board: 'tx15', version: 'v2.12.5' });
    expect(() => checkFirmwareFile('notes.txt', tx15, 'tx15', 'uf2')).toThrow(/not a firmware file/);
    expect(() => checkFirmwareFile('my.bin', withId('edgetx-tx15-v2.12.5'), 'tx15', 'uf2')).toThrow(/takes \.uf2 files/);
    expect(() => checkFirmwareFile('fake.uf2', Buffer.from('no uf2 blocks'), 'tx15')).toThrow(/not a firmware file/);
    expect(() => checkFirmwareFile('mk3.uf2', uf2(withId('edgetx-tx16smk3-v2.12.5')), 'tx15', 'uf2')).toThrow(/built for tx16smk3, not for tx15/);
    // no identification: allowed, but without a radio type the caller has to confirm
    expect(checkFirmwareFile('odd.bin', Buffer.alloc(2048, 0xff), 'tx16s', 'dfu')).toEqual({ method: 'dfu' });
  });

  it('lists the firmware releases from 2.12 on with their radio types, reading only the end of each zip', async () => {
    const p = paths(await tempDir());
    const zip = makeZip({ 'tx15-0ebe2e9.uf2': 'U'.repeat(100_000), 'tx16s-0ebe2e9.bin': 'B', 'x9e-hall-0ebe2e9.bin': 'H', 'fw.json': '{}' });
    const asset = (tag: string) => ({ name: `edgetx-firmware-${tag}.zip`, browser_download_url: `https://dl/${tag}.zip`, size: zip.length });
    const releases = ['v2.12.5', 'v2.12.4', 'v2.11.8', 'nightly', 'v2.12.0-rc4', 'v2.11.0-rc4'].map((tag) => ({
      tag_name: tag,
      name: `EdgeTX "Test" ${tag}`,
      published_at: '',
      html_url: '',
      zipball_url: '',
      assets: [asset(tag)],
      prerelease: tag === 'nightly' || tag.includes('-rc'),
    }));
    const ranges: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/releases?')) return Response.json(releases);
      const range = new Headers(init?.headers).get('Range')!;
      ranges.push(`${url} ${range}`);
      const [, a, b] = range.match(/bytes=(\d+)-(\d+)/)!;
      // v2.12.4's server ignores Range and sends the whole file
      if (url.includes('v2.12.4')) return new Response(zip);
      return new Response(zip.subarray(Number(a), Number(b) + 1), { status: 206 });
    }) as typeof fetch;
    const source = defaultSettings().sources.find((x) => x.kind === 'firmware')!;

    const catalog = await firmwareCatalog(p, source, fetchFn);
    expect(catalog.map((e) => [e.tag, e.name, e.boards.sort()])).toEqual([
      ['v2.12.5', 'EdgeTX "Test" v2.12.5', ['tx15', 'tx16s', 'x9e-hall']],
      ['v2.12.4', 'EdgeTX "Test" v2.12.4', ['tx15', 'tx16s', 'x9e-hall']],
    ]);
    expect(ranges.some((r) => r.includes('v2.11.8'))).toBe(false);

    // known releases come from catalog.json, without asking for the zip again
    ranges.length = 0;
    expect((await firmwareCatalog(p, source, fetchFn)).map((e) => e.tag)).toEqual(['v2.12.5', 'v2.12.4']);
    expect(ranges).toEqual([]);

    // with release candidates from 2.12 on, never nightly
    const withRc = await firmwareCatalog(p, source, fetchFn, true);
    expect(withRc.map((e) => [e.tag, e.prerelease])).toEqual([
      ['v2.12.5', false],
      ['v2.12.4', false],
      ['v2.12.0-rc4', true],
    ]);
  });
});
