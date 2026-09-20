# Strata Tune on macOS

Strata Tune is a Windows tool at heart: its sensor collector is a .NET service
built on LibreHardwareMonitor, NVML, NVAPI, WMI, PawnIO and PresentMon, and the
headroom hunt drives NVIDIA clocks. None of that exists on a Mac. What this
port does is let the **shell** build and run on Apple Silicon, so the family
stays buildable from one MacBook and the pages that do not need live sensors
work:

| Page | On macOS |
|---|---|
| **AI Models** | Sizing every quant against RAM works from the static tables; live bandwidth and Ollama measurements need the collector, so they show "collector unavailable". `ollama pull` buttons work if Ollama is installed. |
| **Capture** | Opening saved sessions and exporting the HTML report works. Recording needs PresentMon (Windows). |
| **Tune / Monitor** | Need the collector. They show the Windows-only notice instead of a UAC prompt that never comes. |

A native macOS collector (`powermetrics`, IOKit, `sysctl`) would be a separate
project; nothing here starts it.

## Build and run

```bash
brew install node@24 && brew link --overwrite node@24   # not plain `node` (26): Electron's unpacker stops silently there
npm ci
npm run build          # also builds the single-file report bundle
npm start              # or double-click run-strata-tune.command
npm test               # vitest
scripts/mac/install-shortcuts.sh   # Strata Tune.app in ~/Applications + a Desktop alias
```

## Troubleshooting

- **"Electron failed to install correctly"** on launch, or `node_modules/electron/dist`
  holding only `LICENSES.chromium.html`: the dependencies were installed with Node 26
  (Homebrew's plain `node`), where Electron's unpacker (extract-zip) stops silently
  after the first file. Install Node 24: `brew install node@24 && brew link --overwrite
  node@24`, then `node node_modules/electron/install.js`. Strata Code and Photo's
  `scripts/mac/setup.sh` do this for you.

## What changed for the port

- `electron/presence.ts`: `strataDataDir()` and `tuneDataDir()` resolve
  `~/Library/Application Support/Strata` and `.../Strata Tune` on macOS
  (`%LOCALAPPDATA%\Strata`, `\Strata Tune` on Windows); the presence
  convention shared with Strata Code and Photo uses the same folder on every
  platform.
- `electron/collector.ts`: off Windows, `start()` reports the Windows-only
  notice at once; `tasklist.exe` is never spawned.
- `electron/main.ts`: PNG window icon off Windows.

Everything else (`bench.ts`, `capture.ts`, `game-mode.ts`, `presentmon.ts`,
`about.ts`'s dxdiag/reg queries) is only reached from a page action and fails
with a clear message when it is.
