import { buffer } from 'node:stream/consumers';
import yauzl from 'yauzl';
import { AppError } from './errors.ts';
import type { FetchFn } from './github.ts';

// maxBytes: the most all entries may unpack to; yauzl checks each entry against its stated size.
function readEntries(zip: yauzl.ZipFile, resolve: (files: Map<string, Buffer>) => void, reject: (e: Error) => void, maxBytes = Infinity): void {
  const files = new Map<string, Buffer>();
  let total = 0;
  zip.on('error', reject);
  zip.on('end', () => resolve(files));
  zip.on('entry', (entry: yauzl.Entry) => {
    if (entry.fileName.endsWith('/')) return zip.readEntry();
    total += entry.uncompressedSize;
    if (total > maxBytes) {
      zip.close();
      return reject(new AppError('invalidRequest', { what: 'file too large' }));
    }
    zip.openReadStream(entry, (e, stream) => {
      if (e || !stream) return reject(e ?? new Error(`cannot read ${entry.fileName}`));
      buffer(stream)
        .then((data) => {
          files.set(entry.fileName, data);
          zip.readEntry();
        })
        .catch(reject);
    });
  });
  zip.readEntry();
}

// What a package may unpack to: they are a few MB up to ~50 MB, a project's release is anyone's.
const MAX_PACKAGE = 1024 * 1024 * 1024;

// All file entries of a zip, read into memory.
export function readZip(path: string, maxBytes = MAX_PACKAGE): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`cannot open ${path}`));
      readEntries(zip, resolve, reject, maxBytes);
    });
  });
}

// The same for a zip already in memory, e.g. an uploaded .etx file.
export function readZipBuffer(data: Buffer, maxBytes?: number): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open the zip'));
      readEntries(zip, resolve, reject, maxBytes);
    });
  });
}

// File names in a zip without reading the data, e.g. to see which firmware files it has.
export function zipNames(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`cannot open ${path}`));
      const names: string[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(names));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) names.push(entry.fileName);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

// File names in a zip on a web server, from the central directory at its end: a few KB instead of the whole file.
export async function remoteZipNames(url: string, size: number, fetchFn: FetchFn = fetch): Promise<string[]> {
  const range = async (start: number, end: number) => {
    const res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'edgetx-radio-manager' } }).catch(() => {
      throw new AppError('noConnection');
    });
    if (!res.ok) throw new AppError('downloadFailed', { status: res.status, url });
    const data = Buffer.from(await res.arrayBuffer());
    // a server that ignores Range sends the whole file
    return res.status === 206 ? data : data.subarray(start, end + 1);
  };
  const tailStart = Math.max(0, size - 22 - 65_535); // end record and the longest possible zip comment
  const tail = await range(tailStart, size - 1);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`no zip directory in ${url}`);
  const dirSize = tail.readUInt32LE(end + 12);
  const dirStart = tail.readUInt32LE(end + 16);
  const dir = dirStart >= tailStart ? tail.subarray(dirStart - tailStart, dirStart - tailStart + dirSize) : await range(dirStart, dirStart + dirSize - 1);
  const names: string[] = [];
  for (let at = 0; at + 46 <= dir.length && dir.readUInt32LE(at) === 0x02014b50; ) {
    const length = dir.readUInt16LE(at + 28);
    names.push(dir.toString('utf8', at + 46, at + 46 + length));
    at += 46 + length + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
  }
  return names.filter((n) => !n.endsWith('/'));
}
