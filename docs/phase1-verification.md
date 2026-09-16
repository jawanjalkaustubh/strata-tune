# Phase 1 verification — dev box, 2026-09-15

Run evidence for the v0.1 status line in the README, kept here so the README stays a status
table. Everything below was produced on the dev box (RTX 5090, Ryzen 9 9950X, MAG X870E
TOMAHAWK WIFI, Windows 11 26200, PawnIO 2.2.0, driver 616.92) after the post-review fixes.

## Gates

| Gate | Result |
|---|---|
| `dotnet build collector\StrataTune.sln -c Release` | 0 warnings, 0 errors; the build copies `strata-tune-worker.exe` and its files beside the collector |
| `npm run typecheck` | clean for every file of this phase (`src/`, `electron/`, `tests/`) |
| `npm test` | 4 files, 122 tests: audit rules, memory kits, the Monitor helpers over the dev box's 379-sensor tree (`tests/fixtures/devbox.meta.json`, parsed from the Phase 0 probe), and the four Monitor panels rendered with react-dom/server over one real tick |
| `npm run build` | Vite bundles the renderer and the main process |
| `STRATA_SELFTEST=1 npx electron .` | `ok: true`, `hardwareAccelerationDisabled: true`, renderer SwiftShader, Electron 34.5.8 |

## The real app, end to end

Driven over the Chrome DevTools Protocol (`--remote-debugging-port`), one UAC prompt, the
user at the machine:

- **Connected 9.7 s after the prompt.** `/health`: pid matches the handshake, version 0.1.0,
  elevated, PawnIO 2.2.0 device open, NVML driver 616.92, `lhm.available` and
  `pdh.available` true. The collector log shows the worker resolved beside the collector
  (`...\StrataTune.Collector\bin\...\strata-tune-worker.exe`), no `--worker` argument passed.
- **Audit in 31 s, nothing skipped, no error.** Snapshot, 5 s idle sample, 3 s light PCIe
  load (7 samples), 20 s heavy thermal ramp (41 samples). All twelve checks: EXPO on and above
  rated (6200 of 6000 MT/s), Resizable BAR on, two modules one per channel, PCIe 5.0 x16 under
  load, Balanced on Ryzen not flagged, C: 68 % free, driver 12 days old, no background hogs,
  power limit at its 600 W maximum (information), Ollama holding no model, game-on-HDD
  unknown until a capture; **thermal headroom: "Power-limited at 600 W, normal: clocks held
  (3203 to 3201 MHz) at a peak of 52 °C with the card at its 600 W limit"** — the plan §8
  verdict from the steady window with the engagement gate passed, where the old light ramp
  could only ever answer ok. The top five are all OK and show no cost text.
- **Monitor.** CPU panel in AMD red with the chip beside the bars: two stacked CCD blocks
  (CCD1 33 °C, CCD2 32 °C), PKG 47 °C / 57 W, Tctl, package 56.9 W of 230 W (PPT from
  `src/data/cpus.json`), average effective clock, per-CCD temps. GPU panel in NVIDIA green:
  temps, board power 74 W of 600 W, SM clock against the session high with no LHM ghost,
  memory clock, loads, VRAM, Fan 1/2 with duty, the perf-limit pill `idle (0x400)` in its own
  case, the 12V-2x6 block with A, W and V per pin, spread and max/mean beside the header,
  and the connector bar (6.0 A, 72 W of 600). Board panel in MSI crimson with BIOS 2.A60 in
  the aside: six rails with the SoC at 1.304 V emerald under the 1.30 V tick, five board
  temperatures, and the fans folded to CPU Fan "0 rpm, no tacho at 100 %" (amber), Pump
  2992 rpm 78 %, "8 headers unused". System power 170 W: measured CPU package 57 W · GPU
  board 74 W, estimated board 25 W · RAM (2 DIMM) 7 W · drives (3) 2 W · fans (3) 6 W.
- **Close.** `POST /shutdown` accepted; `strata-tune-collector.exe` gone 0.3 s after the
  window closed, `collector.json` removed, no `orphan.log`, collector log ends `exit 0`.
  An earlier driver run that killed the UI outright (no graceful shutdown) also ended with
  "parent gone, stopping … exit 0" within 30 ms.

## Not measured on this box

- A declined UAC prompt (ERROR_CANCELLED 1223 from Start-Process) is read from the exception
  code by reading, not by declining a prompt.
- The over-the-shoulder elevation (`--handshake` / `--log` under the launching user's
  profile) and the Windows power-mode overlay on a laptop have no second machine yet.
- A stale `collector.json` whose pid was recycled is handled by the image-name check; the
  reboot case has not been reproduced deliberately.
