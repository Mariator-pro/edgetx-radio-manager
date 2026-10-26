# Development

[Back to the README](../README.md)

## Running from source

Needs Node.js 22.18 or newer (TypeScript runs directly, without a build step for the command line). Drive detection works on macOS, Windows and Linux (there: FAT and exFAT drives listed in `/proc/mounts`).

```sh
git clone https://github.com/Mariator-pro/edgetx-radio-manager.git
cd edgetx-radio-manager
npm install
npm run build   # builds the browser interface into dist/ui, the desktop main process into dist/desktop and THIRD_PARTY_LICENSES.txt
```

This is also what the [browser interface](browser-interface.md) and the [command line](command-line.md) need.

For your own Lua projects, the source type **Local** finds checkouts of the projects next to this repo (e.g. `../edgetx-lipo-nanny`) automatically when the tool runs from source.

## Desktop app

```sh
npm run desktop   # builds everything and starts the app
npm run dist      # builds the installers for your own system into release/
```

The app starts the server itself (on a free port) and shows the interface in its own window; links to GitHub open in the browser. The licenses of the bundled open source packages end up in `THIRD_PARTY_LICENSES.txt` in the app's resources folder.

A new release is made with a tag: bump the version in `package.json`, then `git tag v<version> && git push origin v<version>`. The GitHub workflow `.github/workflows/release.yml` builds the app for macOS, Windows and Linux and attaches the files to the release: one zip per installer for download, the portable Windows app as a zip, and for the app's own update on Windows and Linux the bare installer, the AppImage and their `latest*.yml` files.

## Development workflow

```sh
npm run dev        # Vite with API server, interface with hot reload
npm test           # Vitest
npm run typecheck  # TypeScript for core and interface
npm run lint       # oxlint
```

To test without a real radio, `RADIO_MANAGER_VOLUMES` can point to one or more folders (separated like in the `PATH`), for example the SD folder of a simulator.

## How it works

- **Detection**: the radio type, language and firmware are read from the SD card (`RADIO/radio.yml`, `edgetx.sdcard.version`).
- **Download**: new releases of all sources from GitHub, and for own projects also the newest commit of the main branch.
- **Backup**: copies the whole SD card, including file times, into a folder; old backups are pruned.
- **Restore**: compares the backup with the card by size and file time (small files also by content) and writes only what differs; files the backup does not have are deleted.
- **Update**: compares the packages with the card; files changed on the card come up as conflicts instead of being overwritten.
- **Models**: reads `MODELS/model<n>.yml` from the backups and the card and groups them by model name. Copying writes the model file unchanged with the current time, so the radio reads it again; `labels.yml` and `radio.yml` are never written, the radio adds missing labels itself. What fits the radio is checked against the switches, pots and internal module listed in its `RADIO/radio.yml`.
- **Firmware**: radios with a UF2 bootloader get the firmware via the drive, all others via USB DFU (`dfu-util`). The method follows from the firmware file for the radio type.

## Structure

- `src/core/`: logic (detection, download, backup, restore, update plan, firmware, models)
- `src/server/`: HTTP API and server-sent events for progress and state
- `src/ui/`: React interface (HeroUI, Tailwind)
- `src/cli/`: command line
- `src/desktop/`: Electron main process, starts the server and shows the interface in its own window
- `src/platform/`: drive detection, the only OS-specific part
- `scripts/licenses.ts`: collects the license texts of all bundled packages and runtime dependencies during the build (also holds the Vite plugin that lists the bundled modules)
- `docs/`: this documentation, `docs/screenshots/` holds the screenshots in the README
