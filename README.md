# EdgeTX Radio Manager

Backup, package download, SD card update and firmware flashing for EdgeTX radios, as a desktop app for macOS and Windows, as a command line tool and as a browser interface (English and German).

## Features

- **Detection**: The radio is detected as a drive in "USB Storage" mode. Radio type, language, firmware and installed packages are read from the SD card (`RADIO/radio.yml`, `edgetx.sdcard.version`).
- **Download**: Fetches new releases of all sources from GitHub, and for own projects also the newest commit of the main branch.
- **Backup**: Copies the whole SD card, including file times, into a folder. Old backups are pruned (default: the last 10 are kept), single backups can be kept permanently.
- **Update**: Shows a plan (new, replaced, deleted, conflicts), backs up the card and then installs the packages. Files changed on the card are never overwritten silently, they come up as conflicts instead.
- **Firmware flashing**: Radios with a UF2 bootloader get the firmware via the drive, all others via USB DFU (`dfu-util`). The method follows from the firmware file for the radio type.
- **Sources**: EdgeTX firmware, SD content and sounds are built in. Further GitHub projects with a `SCRIPTS/` or `WIDGETS/` folder can be added and removed.

Every radio that EdgeTX supports works without a list of its own in the tool: radio types and SD packages come from the `sdcard.json` of the EdgeTX SD content release.

## Requirements

- For the command line and the browser interface: Node.js 22.18 or newer (TypeScript runs directly, without a build step for the command line). The desktop app brings everything it needs.
- macOS or Windows for drive detection (on Linux use `--volume` or `RADIO_MANAGER_VOLUMES`)
- Only for flashing firmware to DFU radios: [`dfu-util`](https://dfu-util.sourceforge.net/) in the `PATH`, not bundled. Without it, the tool blocks the flash flow and explains what to install.
  - macOS: `brew install dfu-util`
  - Windows: download `dfu-util` and put it in the `PATH`, and install the WinUSB driver for the radio in DFU mode with [Zadig](https://zadig.akeo.ie/)

## Desktop app

The finished app is on the [Releases](https://github.com/Mariator-pro/edgetx-radio-manager/releases) page: a `.dmg` for macOS (Apple Silicon `arm64`, Intel `x64`) and an `.exe` installer for Windows. The app starts the server itself (port 5175) and shows the interface in its own window; links to GitHub open in the browser.

The licenses of the bundled open source packages are in `THIRD_PARTY_LICENSES.txt` in the app's resources folder, next to Electron's own license files.

The app is signed ad hoc only (no Apple or Microsoft certificate), so the system warns on first start:

- macOS: the first start shows "Apple could not verify ... is free of malware". Click "Done" (not "Move to Trash"), open System Settings, Privacy & Security, scroll down and click "Open Anyway" next to the blocked app, confirm with your password or Touch ID, then start the app again and choose "Open". Later starts need nothing.
- Windows: in the SmartScreen window, click "More info" and then "Run anyway".

From source:

```sh
npm run desktop   # builds everything and starts the app
npm run dist      # builds the installers for your own system into release/
```

A new release is made with a tag: bump the version in `package.json`, then `git tag v0.2.0 && git push origin v0.2.0`. The GitHub workflow `.github/workflows/release.yml` builds the app for macOS and Windows and attaches the files to the release.

## Installation

```sh
git clone https://github.com/Mariator-pro/edgetx-radio-manager.git
cd edgetx-radio-manager
npm install
npm run build   # builds the browser interface into dist/ui, the desktop main process into dist/desktop and THIRD_PARTY_LICENSES.txt
```

## Browser interface

```sh
npm start
```

Starts the server on `http://127.0.0.1:5174` and opens the browser. There are pages for the connected radio, packages, sources and backups, plus guided flows for updating and flashing firmware.

## Command line

```sh
npm run cli -- <command> [options]
```

| Command | What it does |
| --- | --- |
| `status` | Connected radio, installed and downloaded versions |
| `download` | Check all sources for new releases and download them |
| `backup` | Back up the whole SD card of the connected radio |
| `update` | Show the plan, then back up and update the card |
| `flash [version]` | Flash firmware, without a version the newest downloaded one (e.g. `flash v2.12.5`) |
| `sources` | List sources; `sources add <owner/repo>`, `sources remove <name>` |
| `ui` | Open the browser interface (like `npm start`) |

Options:

- `--volume <path>`: use this drive instead of automatic detection
- `--board <id>`: radio type when the card has no `RADIO/radio.yml` yet (e.g. `tx16s`)

Typical flow: `download`, connect the radio in "USB Storage" mode, `update`.

## Package sources per radio

For every radio the tool stores which sources go on the card and where they come from:

- **release**: the newest downloaded GitHub release
- **main**: the newest commit of the main branch (own projects only), downloaded when needed
- **local**: a local git checkout. Checkouts of the projects next to this repo (e.g. `../edgetx-lipo-nanny`) are found automatically.

What was installed on the card is recorded in `.radio-manager/installed.json` on the SD card. On the next update the tool uses it to tell which files it wrote itself and which were changed since.

## Data on the computer

Settings, downloads and backups live where apps keep their data on each system:

- macOS: `~/Library/Application Support/EdgeTX Radio Manager/`
- Windows: `%LOCALAPPDATA%\EdgeTX Radio Manager\` (e.g. `C:\Users\<name>\AppData\Local\EdgeTX Radio Manager`), not Roaming, because downloads and backups are large
- Linux: `~/.local/share/edgetx-radio-manager/` (or `$XDG_DATA_HOME`)

```
EdgeTX Radio Manager/
├── settings.json          sources, radios, backup settings
├── Packages/<source>/     downloaded versions, _main/ for the main branch
└── Backups/<board>/       one folder per backup, named by date and time
```

On macOS the desktop app keeps its window data (language, theme) in the same folder. The backups page has a button that opens the backup folder.

## Development

```sh
npm run dev        # Vite with API server, interface with hot reload
npm test           # Vitest
npm run typecheck  # TypeScript for core and interface
npm run lint       # oxlint
```

To test without a real radio, `RADIO_MANAGER_VOLUMES` can point to one or more folders (separated like in the `PATH`), for example the SD folder of a simulator.

Structure:

- `src/core/`: logic (detection, download, backup, update plan, firmware)
- `src/server/`: HTTP API and server-sent events for progress and state
- `src/ui/`: React interface (HeroUI, Tailwind)
- `src/cli/`: command line
- `src/desktop/`: Electron main process, starts the server and shows the interface in its own window
- `src/platform/`: drive detection, the only OS-specific part
- `scripts/licenses.ts`: collects the license texts of all bundled packages during the build

## License

Released under the [MIT License](LICENSE). The app bundles open source packages under their own licenses, listed in `THIRD_PARTY_LICENSES.txt` (see [Desktop app](#desktop-app)).
