import { join } from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import { paths } from '../core/paths.ts';
import { startServer } from '../server/server.ts';

// Fixed port so the page keeps its origin and with it the stored language and theme; the CLI uses 5174.
const PORT = 5175;
// Space kept free around the window when it opens, in points.
const WINDOW_MARGIN = 24;

// Apps started from Finder don't get the shell's PATH, so dfu-util from Homebrew would not be found.
if (process.platform === 'darwin') process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');

async function start(): Promise<void> {
  const o = {
    paths: paths(),
    staticDir: join(app.getAppPath(), 'dist', 'ui'),
    // own projects' checkouts next to this repo only when run from the source folder
    repoParent: app.isPackaged ? undefined : join(app.getAppPath(), '..'),
  };
  const server = await startServer({ ...o, port: PORT }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') return startServer({ ...o, port: 0 });
    throw e;
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
  // links to GitHub and other sites open in the browser, not in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(server.url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  await win.loadURL(server.url);
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
