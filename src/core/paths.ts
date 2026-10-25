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

// A single folder name coming from outside (UI, command line), never a path.
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}
