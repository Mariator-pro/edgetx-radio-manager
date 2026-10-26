# Command line

[Back to the README](../README.md)

The main functions of the app are also available as commands, e.g. for scripts or when you prefer the terminal. It needs the app [running from source](development.md#running-from-source) (Node.js and `npm install`).

```sh
npm run cli -- <command> [options]
```

## Commands

| Command | What it does |
| --- | --- |
| `status` | Connected radio, installed and downloaded versions |
| `download` | Check all sources for new releases and download them |
| `backup` | Back up the whole SD card of the connected radio |
| `update` | Show the plan, then back up and update the card |
| `restore [backup]` | Without a name, list the backups of the connected radio with EdgeTX version, reason and note; with one (e.g. `restore 2026-10-23_2015`), show the plan, then back up the card and restore the backup |
| `flash [version]` | Flash firmware, without a version the newest downloaded one; any other release is downloaded first (e.g. `flash v2.12.2` or `flash v2.12.0-rc4`); `flash --file <path>` flashes a `.uf2` or `.bin` of your own |
| `sources` | List sources; `sources add <owner/repo>`, `sources remove <name>` |
| `models` | List the models in the backups of the connected radio (or `--board`) with their versions, compared with the card |
| `models copy <model> ...` | Show the plan, then back up the card and copy the newest version of these models onto it; `--from tx16smk3` takes them from another radio's backups, `--from tx16smk3/2026-10-23_1849` from one backup |
| `models delete <model> ...` | Move models on the card to `MODELS/DELETED/`, after a backup |
| `models export <model> ...` | Save models from the backups as `<model name>.yml` (`--out <folder>`, `--from`) |
| `models import <file> [<model> ...]` | Copy models from a `.yml` or `.etx` file onto the card |
| `models diff <model> [<backup> [<backup>]]` | Differences between two versions, without a second backup against the card |
| `ui` | Open the browser interface (like `npm start`) |

## Options

- `--volume <path>`: use this drive instead of automatic detection
- `--board <id>`: radio type when the card has no `RADIO/radio.yml` yet (e.g. `tx16s`)
- `--no-backup`: restore, copy or delete models without backing up the card first
- `--force`: with `flash --file`, flash a file that has no EdgeTX identification; with `models copy` or `models import`, copy models that do not fully fit the radio
- `--add`: with `models copy` or `models import`, add the models as new ones instead of replacing those of the same name
- `--from <radio>[/<backup>]`: with `models copy`, `export` or `diff`, take the models from these backups
- `--out <folder>`: with `models export`, where the files go (default: the current folder)

Typical flow: `download`, connect the radio in "USB Storage" mode, `update`.
