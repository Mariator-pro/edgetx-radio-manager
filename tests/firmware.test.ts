import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUf2Drive, firmwareFile, flashFirmware, flashMethod, flashUf2, parseDfuList, parseUf2Info, waitFor } from '../src/core/firmware.ts';
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

const UF2_INFO = 'UF2 Bootloader v2.12.5\r\nModel: RadioMaster TX16S MK3\r\nBoard-ID: tx16smk3\r\nDate: Oct 18 2026\r\n';

describe('firmware', () => {
  it('flashes over UF2 when the zip has a .uf2 for the radio, else over DFU', async () => {
    const p = await withFirmware();
    expect(await flashMethod(p, 'v2.12.5', 'tx16s')).toBe('dfu');
    expect(await flashMethod(p, 'v2.12.5', 'tx16smk3')).toBe('uf2');
    expect(await flashMethod(p, 'v2.12.5', 'tx15')).toBe('uf2');
    await expect(flashMethod(p, 'v2.12.5', 'x9e')).rejects.toThrow(/No firmware for x9e/);
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
});
