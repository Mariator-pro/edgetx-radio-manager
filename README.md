# EdgeTX Radio Manager

Keep your EdgeTX radio up to date without copying files by hand. Plug in the radio, and the app shows what is new: firmware, SD card content, sounds (voice announcements) and your Lua scripts and widgets from GitHub. It backs up the SD card before every change and never silently overwrites files you changed yourself.

Desktop app for macOS, Windows and Linux, in English and German (English by default, German in a menu at the bottom of the sidebar). For advanced use, a [browser interface](docs/browser-interface.md) and a [command line tool](docs/command-line.md) are available when running from source.

![The radio page: firmware, SD card and backup status of a connected RadioMaster TX15](docs/screenshots/radio.png)

## What it does

- **Detects your radio** as soon as it is connected in "USB Storage" mode: radio type, language, firmware and what is installed on the SD card.
- **Downloads updates** from GitHub: EdgeTX firmware, the EdgeTX SD card content, sounds, the ExpressLRS Lua script and any Lua project you add.
- **Updates the SD card** in one guided flow: shows exactly which files are added, replaced or deleted, backs up the card, then writes the changes.
- **Flashes firmware**, with step by step instructions for entering the bootloader.
- **Keeps backups** of the whole SD card, the last 10 per radio by default, and any backup you mark to keep, and restores them when needed.
- **Manages models**: every model from the backups with its earlier versions, copied one by one back onto the radio or onto another radio, deleted from the card, exported, imported or compared.

Every radio that EdgeTX supports works: radio types and SD card content come straight from the EdgeTX release.

## Install

Download the app from the [Releases](https://github.com/Mariator-pro/edgetx-radio-manager/releases) page:

- **macOS**: `edgetx-radio-manager-macos-arm64-v<version>.zip` for Apple Silicon (M1 and newer) or `edgetx-radio-manager-macos-x64-v<version>.zip` for Intel Macs. Unzip it, open the `.dmg` inside and drag the app into Applications.
- **Windows**: `edgetx-radio-manager-win64-v<version>.zip`. Unzip it and run the installer inside.
- **Windows, portable**: `edgetx-radio-manager-win64-portable-v<version>.zip`, no installation. Unzip it into a folder of its own (the files are at the top of the zip) and start `EdgeTX Radio Manager.exe`. Downloads, backups and settings go to the same folder as with the installed app.
- **Linux** (x64): `edgetx-radio-manager-linux-v<version>.zip`. Unzip it and start the `.AppImage` inside, for example with a double click or `./edgetx-radio-manager-linux-v<version>.AppImage`. If it does not start, the system may lack FUSE 2: on Ubuntu 24.04 and newer install it with `sudo apt install libfuse2t64`, on older Ubuntu and Debian with `sudo apt install libfuse2`.

The app is not signed with an Apple or Microsoft certificate, so the system warns on first start:

- **macOS**: the first start shows "Apple could not verify ... is free of malware". Click "Done" (not "Move to Trash"), open System Settings, Privacy & Security, scroll down and click "Open Anyway" next to the blocked app, confirm with your password or Touch ID, then start the app again and choose "Open". Later starts need nothing.
- **Windows**: if a SmartScreen window appears, click "More info" and then "Run anyway".
- **Linux**: no warning. If the file manager does not start the AppImage, mark it as executable (`chmod +x`).

Signing the Windows version is applied for at the SignPath Foundation, see [Code signing policy](#code-signing-policy).

### Updating the app

On start the app looks for a newer release and shows it at the top left:

- **Windows (installed) and Linux**: "Update and restart" downloads the new version, installs it in place and starts it again. Your data and settings stay.
- **Windows (portable)**: "Download" opens the release page; unzip the new version and delete the old folder.
- **macOS**: "Download" opens the release page. Install the new version like the first one; the app replaces the old one in Applications. macOS accepts an in-place update only for apps signed with an Apple certificate, which this one is not.

### Only for radios that flash over DFU

Radios with a UF2 bootloader (for example RadioMaster TX15 and TX16S Mk III) get their firmware through a USB drive in the bootloader and need nothing extra. Others such as the TX16S flash over USB DFU and need [`dfu-util`](https://dfu-util.sourceforge.net/), which is not bundled. The app tells you when your radio needs it and blocks flashing until it is installed:

- macOS: `brew install dfu-util`
- Windows: download `dfu-util` and put it in the `PATH`, and install the WinUSB driver for the radio in DFU mode with [Zadig](https://zadig.akeo.ie/)
- Linux: install it with the package manager, e.g. `sudo apt install dfu-util`, and allow access to the radio in DFU mode without root with a udev rule:

  ```sh
  echo 'SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0664", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/45-edgetx-dfu.rules
  sudo udevadm control --reload-rules
  ```

## Using it

### 1. Connect the radio

Switch the radio on, plug in the USB cable and choose "USB Storage" on the radio. The app opens the radio's page. It shows three cards in the order they are due: firmware, SD card and backup.

Below them you choose what belongs on this radio: switch sources on or off, and for your own projects pick where they come from (see [Where packages come from](#where-packages-come-from)). Below the sounds you add or remove languages and pick a voice for each.

### 2. Check for updates

"Check for updates" at the bottom left looks for new releases of all sources and downloads them. Downloaded versions stay on your computer, so updating works offline later.

### 3. Update the SD card

"Prepare update" shows the plan before anything is written: how many files are new, replaced or deleted, and every file per package.

![The update plan with counts of new, replaced and deleted files and one conflict](docs/screenshots/update.png)

Files that you changed on the SD card, or that did not come from a package, show up as **conflicts**. You decide per file whether to keep it or overwrite it. If you don't choose, it stays as it is. Models, settings and files you copied yourself are never touched.

"Back up and update" first copies the whole SD card into a backup, then writes the changes.

### 4. Flash firmware

"Flash firmware" on the firmware card opens the flash page. Pick the EdgeTX version (the newest downloaded one is preselected), click "Start flashing" and follow the steps to put the radio into its bootloader. The app waits up to five minutes for the radio. Afterwards, run an SD card update so the card matches the new firmware.

The list also shows the older EdgeTX versions from 2.12 on that have a file for your radio, also those not downloaded yet. To find them the app reads only the end of each firmware zip on GitHub, a few KB, and remembers the result. A version that is not downloaded yet is downloaded when you click "Start flashing", and then stays like any other download. "Check for updates" itself only downloads the newest firmware.

Two more options sit below the version list:

- **Show release candidates**: also lists the test versions EdgeTX publishes before a release (e.g. `v2.12.0-rc4`), from 2.12 on. Like the older versions they are downloaded when you flash one. The newest finished release stays preselected, and the SD content stays at the newest release.
- **Choose file**: flashes a `.uf2` or `.bin` file of your own, e.g. a firmware you built yourself. The app reads the radio type and version that EdgeTX builds into every firmware and refuses a file for another radio or of the wrong kind. A file without this identification can only be flashed after choosing "Flash anyway".

![The flash page with the bootloader steps for a RadioMaster TX15](docs/screenshots/flash.png)

### 5. Add your own Lua scripts and widgets

On the "Sources" page, enter a GitHub repo (`owner/name`) and click "Check". The app looks for the folder with `SCRIPTS/` or `WIDGETS/` in its newest release and shows it for you to confirm. Added sources can be removed again; EdgeTX firmware, SD content and sounds are built in.

![The sources page with the built-in EdgeTX sources and several Lua projects](docs/screenshots/sources.png)

### 6. Restore or keep backups

The "Backups" page lists the backups per radio. Below each one it shows the EdgeTX version on the SD card at the time and why the backup was made: by hand, before restoring another backup, or before an SD update together with the packages that update changed. "Note" adds your own short text. Switch on "Keep" for a backup that should never be deleted, for example before a big EdgeTX update. "Open folder" shows the backups on your computer.

"Restore" brings the SD card back to exactly the state of that backup: changed and missing files come back, files added since then are deleted. It works only while a radio of the same type is connected. Before anything is written, the app shows the plan with every file, and points out when the backup was made with a different EdgeTX version than the one on the radio. "Back up the SD card first" is on by default, so a restore can be undone as well.

![The backups page with backups of two radios](docs/screenshots/backups.png)

The "Packages" page lists every downloaded version. Nothing there is deleted automatically, and versions installed on a radio cannot be deleted.

### 7. Copy, restore and compare models

The "Models" page lists the models in the backups of a radio. Each model shows its picture, labels, EdgeTX version and whether the connected radio has it: "on the SD card", "on the SD card, changed" or "not on the SD card". Open a model to see its earlier versions (each different state in the backups is one version) and pick the one you want. "Compare" lists what differs between two versions, or between a version and the model on the SD card, grouped like the radio's model menus. Models that are on the SD card but in no backup yet show up as "only on the SD card".

![The models page with the models of a RadioMaster TX16S MK3, one of them opened to its two versions](docs/screenshots/models.png)

Tick one or more models, then:

- **Copy to** puts them onto the connected radio. Only these models change; all other models and the radio settings stay as they are. A model with the same name on the SD card is replaced (you can switch to "Add as new model" instead), any other model is added under the next free number. The model picture and its checklist come along. The plan shows what does not come along (Lua scripts, voice files and widgets the model uses but the SD card lacks, with the package to switch on), and what does not fit when the model comes from another radio type: switches, pots or sliders the radio does not have, another internal module or another screen size. Such models are copied unchanged only after choosing "Copy anyway"; adjust them on the radio.
- **Delete from SD card** moves them to `MODELS/DELETED/` on the SD card, like the radio does, so you can get them back.
- **Export** saves each model as `<model name>.yml`.

"Import file" reads a single model (`.yml`) or the models of an `.etx` file, which can then be copied like the others. Before copying or deleting, "Back up the SD card first" is on by default. The radio uses the new models and labels once you unplug the USB cable.

To bring models onto a new SD card, put the card into the radio once (or create the folders `RADIO` and `MODELS` on it), so the app recognizes it.

## Where packages come from

For every radio the app stores which sources go on the SD card and where they come from:

- **Release**: the newest downloaded GitHub release
- **Main**: the newest commit of the main branch (own projects only), downloaded when needed
- **Local**: a local git checkout, only when the app runs from source (see [Development](docs/development.md#running-from-source))

What was installed is recorded in `.radio-manager/installed.json` on the SD card. On the next update the app uses it to tell which files it wrote itself and which were changed since.

## Your data on the computer

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

On macOS the desktop app keeps its window data (language, theme) in the same folder, on Windows next to it in `%APPDATA%\EdgeTX Radio Manager\`, on Linux in `~/.config/EdgeTX Radio Manager/`.

## More documentation

You do not need any of this to use the app. It is for those who want to go further:

- [Browser interface](docs/browser-interface.md): the same pages as the desktop app, in your web browser
- [Command line](docs/command-line.md): most functions of the app as commands, e.g. for scripts
- [Development](docs/development.md): running from source, building the app, making a release and how it works inside

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The Windows version is not signed yet: the application to the SignPath Foundation is pending. Once accepted, every Windows release is built by GitHub Actions from the source code in this repository and signed only after a manual approval.

- Committers and reviewers: [Mariator-pro](https://github.com/Mariator-pro)
- Approvers: [Mariator-pro](https://github.com/Mariator-pro)

### Privacy policy

The app doesn't collect or send any personal data, settings or radio information to the developer or to anyone else. It only connects to GitHub (api.github.com, github.com, raw.githubusercontent.com):

- to look for a newer version of the app itself, each time the installed desktop app starts
- to list the EdgeTX firmware versions available for your radio, on the firmware page
- to download firmware, SD card content, sounds and Lua scripts, when you click "Check for updates" or start flashing

See the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) for what GitHub records about these requests.

## License

Released under the [MIT License](LICENSE). The app bundles open source packages under their own licenses, listed in `THIRD_PARTY_LICENSES.txt` in the app's resources folder. Electron's own license files (`LICENSE.electron.txt`, `LICENSES.chromium.html`) are in the same folder on macOS and in the app folder on Windows and Linux.
