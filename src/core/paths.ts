import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything the tool stores on the computer lives under one fixed folder.
export interface Paths {
  root: string;
  packages: string;
  backups: string;
  settings: string;
}

export function paths(root = join(homedir(), 'EdgeTX')): Paths {
  return {
    root,
    packages: join(root, 'Packages'),
    backups: join(root, 'Backups'),
    settings: join(root, 'settings.json'),
  };
}

// A single folder name coming from outside (UI, command line), never a path.
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}
