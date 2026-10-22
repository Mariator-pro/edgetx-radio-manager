import { buffer } from 'node:stream/consumers';
import yauzl from 'yauzl';

// All file entries of a zip, read into memory (packages are a few MB up to ~50 MB).
export function readZip(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`cannot open ${path}`));
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
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
