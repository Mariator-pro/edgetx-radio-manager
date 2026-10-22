# EdgeTX Radio Manager

Backup, Paket-Download, SD-Karten-Update und Firmware-Flashen für EdgeTX-Fernsteuerungen, als Kommandozeile und als Browser-Oberfläche (Englisch und Deutsch).

## Funktionen

- **Erkennung**: Die Fernsteuerung wird im Modus „USB Storage“ als Laufwerk erkannt. Radiotyp, Sprache, Firmware und installierte Pakete kommen von der SD-Karte (`RADIO/radio.yml`, `edgetx.sdcard.version`).
- **Download**: Lädt neue Releases aller Quellen von GitHub, bei eigenen Projekten zusätzlich den neuesten Commit des Hauptbranches.
- **Backup**: Kopiert die ganze SD-Karte samt Dateizeiten in einen Ordner. Alte Backups werden aufgeräumt (Standard: die letzten 10 bleiben), einzelne Backups lassen sich dauerhaft behalten.
- **Update**: Zeigt einen Plan (neu, ersetzt, gelöscht, Konflikte), sichert die Karte und spielt dann die Pakete auf. Auf der Karte geänderte Dateien werden nicht stillschweigend überschrieben, sondern als Konflikt abgefragt.
- **Firmware flashen**: Radios mit UF2-Bootloader bekommen die Firmware per Laufwerk, alle anderen per USB-DFU (`dfu-util`). Die Methode ergibt sich aus der Firmware-Datei für den Radiotyp.
- **Quellen**: EdgeTX-Firmware, SD-Inhalt und Sounds sind fest eingetragen. Weitere GitHub-Projekte mit `SCRIPTS/`- oder `WIDGETS/`-Ordner lassen sich hinzufügen und wieder entfernen.

Jedes Radio, das EdgeTX unterstützt, funktioniert ohne eigene Liste im Tool: Radiotypen und SD-Pakete kommen aus der `sdcard.json` des EdgeTX-SD-Content-Releases.

## Voraussetzungen

- Node.js 22.18 oder neuer (TypeScript läuft direkt, ohne Build-Schritt für die Kommandozeile)
- macOS oder Windows für die Laufwerkserkennung (unter Linux mit `--volume` oder `RADIO_MANAGER_VOLUMES`)
- Für DFU-Radios: [`dfu-util`](https://dfu-util.sourceforge.net/) im `PATH`, z. B. `brew install dfu-util`

## Installation

```sh
git clone https://github.com/Mariator-pro/edgetx-radio-manager.git
cd edgetx-radio-manager
npm install
npm run build   # baut die Browser-Oberfläche nach dist/ui
```

## Browser-Oberfläche

```sh
npm start
```

Startet den Server auf `http://127.0.0.1:5174` und öffnet den Browser. Dort gibt es Seiten für das verbundene Radio, Pakete, Quellen und Backups sowie geführte Abläufe für Update und Firmware-Flashen.

## Kommandozeile

```sh
npm run cli -- <befehl> [optionen]
```

| Befehl | Was er tut |
| --- | --- |
| `status` | Verbundenes Radio, installierte und heruntergeladene Versionen |
| `download` | Alle Quellen auf neue Releases prüfen und herunterladen |
| `backup` | Die ganze SD-Karte des verbundenen Radios sichern |
| `update` | Plan zeigen, dann Karte sichern und aktualisieren |
| `flash [version]` | Firmware flashen, ohne Angabe die neueste heruntergeladene (z. B. `flash v2.12.5`) |
| `sources` | Quellen auflisten; `sources add <owner/repo>`, `sources remove <name>` |
| `ui` | Browser-Oberfläche öffnen (wie `npm start`) |

Optionen:

- `--volume <pfad>`: dieses Laufwerk statt der automatischen Erkennung verwenden
- `--board <id>`: Radiotyp, wenn die Karte noch keine `RADIO/radio.yml` hat (z. B. `tx16s`)

Typischer Ablauf: `download`, Radio im Modus „USB Storage“ verbinden, `update`.

## Paketquellen pro Radio

Für jedes Radio wird gespeichert, welche Quellen auf die Karte kommen und woher:

- **release**: das neueste heruntergeladene GitHub-Release
- **main**: der neueste Commit des Hauptbranches (nur eigene Projekte), wird bei Bedarf heruntergeladen
- **local**: ein lokaler Git-Checkout. Checkouts der Projekte neben diesem Repo (z. B. `../edgetx-lipo-nanny`) werden automatisch gefunden.

Was auf der Karte installiert wurde, steht in `.radio-manager/installed.json` auf der SD-Karte. Daran erkennt das Tool beim nächsten Update, welche Dateien es selbst geschrieben hat und welche seitdem geändert wurden.

## Daten auf dem Rechner

Alles liegt unter `~/EdgeTX/`:

```
~/EdgeTX/
├── settings.json          Quellen, Radios, Backup-Einstellungen
├── Packages/<quelle>/     heruntergeladene Versionen, _main/ für den Hauptbranch
└── Backups/<board>/       ein Ordner pro Backup, benannt nach Datum und Uhrzeit
```

## Entwicklung

```sh
npm run dev        # Vite mit API-Server, Oberfläche mit Hot Reload
npm test           # Vitest
npm run typecheck  # TypeScript für Kern und Oberfläche
npm run lint       # oxlint
```

Zum Testen ohne echtes Radio kann `RADIO_MANAGER_VOLUMES` auf einen oder mehrere Ordner zeigen (getrennt wie im `PATH`), etwa auf den SD-Ordner eines Simulators.

Aufbau:

- `src/core/`: Logik (Erkennung, Download, Backup, Update-Plan, Firmware)
- `src/server/`: HTTP-API und Server-Sent Events für Fortschritt und Zustand
- `src/ui/`: React-Oberfläche (HeroUI, Tailwind)
- `src/cli/`: Kommandozeile
- `src/platform/`: Laufwerkserkennung, der einzige betriebssystemabhängige Teil
