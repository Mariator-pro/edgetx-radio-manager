import { app } from 'electron';
import { autoUpdater, type ProgressInfo } from 'electron-updater';
import type { AppUpdateView } from '../server/api.ts';
import type { AppUpdates } from '../server/server.ts';
import { isNewer } from '../ui/format.ts';

const RELEASES = 'https://github.com/Mariator-pro/edgetx-radio-manager/releases';

// Windows and Linux (AppImage) download and install a new release when asked to. macOS would only
// accept an update signed with an Apple certificate, so there the page links to the download.
export function appUpdates(): AppUpdates & { check: () => Promise<void> } {
  const installable = process.platform !== 'darwin';
  let found: AppUpdateView | undefined;
  let changed = () => {};
  // first use creates the updater; on macOS it would set up Squirrel, which is never used there
  if (installable) autoUpdater.autoDownload = false;

  const newest = async (): Promise<string | undefined> => {
    if (installable) {
      const r = await autoUpdater.checkForUpdates();
      return r?.isUpdateAvailable ? r.updateInfo.version : undefined;
    }
    // github.com forwards /latest to the newest release's page; no API request, those are limited to 60 an hour
    const res = await fetch(`${RELEASES}/latest`, { method: 'HEAD' });
    const tag = res.url.split('/tag/')[1];
    return tag && isNewer(tag, app.getVersion()) ? tag.replace(/^v/, '') : undefined;
  };

  return {
    view: () => found,
    onChange: (fn) => {
      changed = fn;
    },
    check: async () => {
      const version = await newest();
      if (!version) return;
      found = { version, url: `${RELEASES}/tag/v${version}`, installable };
      changed();
    },
    install: async (onProgress) => {
      const progress = (p: ProgressInfo) => onProgress(Math.floor(p.percent));
      autoUpdater.on('download-progress', progress);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off('download-progress', progress);
      }
      found = { ...found!, restarting: true };
      changed();
      // a moment for the answer and the state to reach the page; silent install, then start the new version
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1000);
    },
  };
}
