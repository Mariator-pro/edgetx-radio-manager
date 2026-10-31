import { join } from 'node:path';
import { app, BrowserWindow, screen, session, shell } from 'electron';
import { paths } from '../core/paths.ts';
import { startServer } from '../server/server.ts';
import { isOwnPage, isWebLink } from './links.ts';
import { appUpdates } from './update.ts';

// Space kept free around the window when it opens, in points.
const WINDOW_MARGIN = 24;

// Apps started from Finder don't get the shell's PATH, so dfu-util from Homebrew would not be found.
if (process.platform === 'darwin') process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');

// No page in the window gets a permission (camera, microphone, location, notifications, USB ...) apart from
// writing to the clipboard; the radio is flashed by dfu-util and the SD card written by the app itself.
const ALLOWED = ['clipboard-sanitized-write'];

function limitPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.includes(permission));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED.includes(permission)));
  ses.setDevicePermissionHandler(() => false);
}

async function start(): Promise<void> {
  limitPermissions();
  // only the installed app updates itself, not a start from the source folder
  const updates = app.isPackaged ? appUpdates() : undefined;
  // any free port: language and theme are kept by the server, not by the page's address
  const server = await startServer({
    paths: paths(),
    port: 0,
    appUpdates: updates,
    staticDir: join(app.getAppPath(), 'dist', 'ui'),
    // own projects' checkouts next to this repo only when run from the source folder
    repoParent: app.isPackaged ? undefined : join(app.getAppPath(), '..'),
    // packed: in the resources folder; started from the source: in dist/
    licensesFile: app.isPackaged ? join(process.resourcesPath, 'THIRD_PARTY_LICENSES.txt') : join(app.getAppPath(), 'dist', 'THIRD_PARTY_LICENSES.txt'),
  });
  // At most 1280 × 860, but always inside the free screen area (no menu bar, dock or taskbar) with a margin, centred there.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1280, area.width - 2 * WINDOW_MARGIN);
  const height = Math.min(860, area.height - 2 * WINDOW_MARGIN);
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 900,
    minHeight: 600,
    title: 'EdgeTX Radio Manager',
  });
  // Electron's default menu has nothing the app needs on Windows, and Windows draws a stray white line under it in dark mode;
  // macOS keeps it for Cmd+Q and copy and paste
  if (process.platform !== 'darwin') win.removeMenu();
  // links to GitHub and other sites open in the browser, not in the app; other schemes not at all
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url, server.url)) return;
    e.preventDefault();
    if (isWebLink(url)) void shell.openExternal(url);
  });
  await win.loadURL(server.open);
  // without internet or GitHub the app runs on as it is
  updates?.check().catch((e: unknown) => console.error('Update check failed:', e));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start).catch((e: Error) => {
    console.error(e);
    app.quit();
  });
}
