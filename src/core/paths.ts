import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything the tool stores on the computer lives under one fixed folder.
export interface Paths {
  root: string;
  packages: string;
  backups: string;
  settings: string;
  server: string; // where the browser interface's server runs, so a second start opens it
}

// Where apps keep their data on each system: macOS Application Support (the same folder Electron uses for
// the app), Windows LocalAppData (not Roaming: downloads and backups are large), elsewhere XDG data.
function dataRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'EdgeTX Radio Manager');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'EdgeTX Radio Manager');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'edgetx-radio-manager');
}

export function paths(root = dataRoot()): Paths {
  return {
    root,
    packages: join(root, 'Packages'),
    backups: join(root, 'Backups'),
    settings: join(root, 'settings.json'),
    server: join(root, 'server.json'),
  };
}

// A single folder name coming from outside (UI, command line, SD card), never a path.
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}

// A path inside the SD card with "/", as the list on the card keeps them: no absolute path, drive,
// backslash or "..", so nothing written or deleted by it lands outside the card.
export function isCardPath(path: string): boolean {
  return path !== '' && !path.includes(':') && path.split('/').every(isSafeName);
}

// Text from a radio's files as it is shown and printed: without control characters, which in a terminal
// could move the cursor, change colours or the window title, nor those that turn the direction of text.
export const printable = (s: string) => s.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '');
