import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { OPEN_SETTINGS } from '../ui/menu.ts';

// The macOS menu bar: the usual app, file, edit and window menus, "Settings…" with Cmd+, when the app has a
// settings page, zoom and full screen, but no reload or developer tools. Windows and Linux show no menu.
export function setAppMenu(win: () => BrowserWindow | undefined, hasSettings: boolean): void {
  if (process.platform !== 'darwin') return;
  const openSettings = () => {
    const w = win();
    if (!w) return;
    w.show();
    void w.webContents.executeJavaScript(`dispatchEvent(new Event(${JSON.stringify(OPEN_SETTINGS)}))`);
  };
  const settings: MenuItemConstructorOptions[] = hasSettings
    ? [{ label: 'Settings…', accelerator: 'Command+,', click: openSettings }, { type: 'separator' }]
    : [];
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...settings,
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
