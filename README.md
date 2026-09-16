# Strata Tune

PC tuning and diagnostics: what is wrong with this PC, what it costs, and how to
fix it. Fifth member of the Strata family (Code, Photo, Video, Snap/Remote).
Standalone Electron app; free, no telemetry, no accounts, no cloud calls.

The design lives in [docs/master-plan.md](docs/master-plan.md); the original idea
document is [docs/spec-original.md](docs/spec-original.md).

## Status

| Phase | State |
|---|---|
| 0 Shell and toolchain | Electron 34 + React 18 + Vite 6 + Tailwind scaffolded from Strata Video. Frameless window, GPU acceleration off by design (the app must never contend with a card under test), `St` monogram, title bar with Help/About, bottom-bar page switcher (Audit, Monitor, Capture, AI Models; Tune hidden behind a settings flag), `STRATA_SELFTEST=1` check that measures the GPU feature status with acceleration off. .NET collector solution in [`collector/`](collector/README.md) (SDK 10.0.401 pinned by `global.json`; Shared, Collector, Worker; builds Release with zero warnings): `strata-tune-collector --probe` reads this box elevated through LibreHardwareMonitor 0.9.6 + PawnIO 2.2.0, NVML and PDH, refuses to run non-elevated (exit 2) and exits 4 rather than reporting zeros when PawnIO's device will not open (the raw probe is gitignored because it is a dump of one machine; its numbers are quoted in [collector/README.md](collector/README.md)); PresentMon 2.5.1 vendored by `scripts/setup-tools.ps1` with size and SHA-256 pinned, 28-column CSV header confirmed on the QPC clock ([docs/phase0-presentmon-sample.csv](docs/phase0-presentmon-sample.csv)); `strata-tune-worker --hash` (ComputeSharp 3.2.0, uint-only kernel) returns the same hash `5ed206bd4475e275` in every process and on the Radeon iGPU, refuses WARP (exit 3, exercised with `--adapter`), and maps device loss to exit 10 (read from ComputeSharp's exception shapes, not yet exercised by a real TDR). **Sensor-layer go/no-go: GO.** PawnIO + LHM read Tctl 49 C, package power 63-68 W, the NCT6687D-R fans/temps/voltages and the DIMM SPD sensors with HVCI on; the HWiNFO fallback from plan section 22 is not needed. Carried into Phase 1: LHM identifiers are not unique on this box (`/gpu-nvidia/0/voltage/0` and `/gpu-nvidia/0/load/3` each appear twice), so the stream layer needs a disambiguation rule. |
| 1 Audit | Not started. |
| 2 Sensors | Not started. |
| 3 AI advisor | Not started. |
| 4–5 Capture and stutter classifier | Not started. |
| 6 Power | Not started. |
| 7 Score and share card | Not started. |
| 8 Tune | Not started. The Tune page is already hidden behind `enableTune` in `src/settings.ts` (default off, no UI yet); the settings toggle and the warning modal from plan section 17 are deferred to this phase. |

## Run

```
npm install
npm run dev        # Vite + Electron with hot reload
npm run build      # production bundle into dist/ and dist-electron/
npm run typecheck
```

Headless check that the shell really runs with hardware acceleration off. It
loads `about:blank` in a hidden window, waits for Chromium's `gpu-info-update`
(before that event the feature table is a placeholder that reads the same with
or without the disable call), then reads `app.getGPUFeatureStatus()`.
Acceleration counts as off when `gpu_compositing`, `rasterization` and `webgl`
all read something other than `enabled`. Exit code 0 when off, 1 when not (the
same bundle with `app.disableHardwareAcceleration()` removed exits 1 and reports
the real card as `renderer`). No window is shown.

```
set "STRATA_SELFTEST=1" && npx electron .        # cmd
$env:STRATA_SELFTEST='1'; npx electron .           # PowerShell
```

The report is a single JSON object on its own line (`ok`,
`hardwareAccelerationDisabled`, `renderer`, `gpuFeatureStatus`, `electron`,
`chrome`, `elapsedMs`, and `reason` when it fails). Note that stdout is not
exactly one line: on Windows `electron.exe` itself writes a CRLF before the JSON,
with or without `npx`. Consumers should take the first line that starts with `{`
rather than the first line, for example in PowerShell:

```
$env:STRATA_SELFTEST='1'; (npx electron .) | Where-Object { $_ -like '{*' } | Select-Object -First 1
```

## Launch

`Install-Shortcuts.ps1` puts "Strata Tune" on the Desktop and Start Menu. It
runs `run-strata-tune.vbs`, which builds once if needed and starts Electron. The
console stays hidden, so if that first install or build fails the `.bat` shows a
message box saying which step failed and what to run by hand (it uses
PowerShell for that: `msg.exe` does not exist on Windows Home).

## Support

`support.json` at the repo root holds the project, issues and donation links,
same shape as the rest of the family. The donate entries stay hidden while
`donateUrl` is empty; the file is read at launch, so no rebuild is needed.
