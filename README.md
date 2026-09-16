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
| 1 Audit | **v0.1.** The elevated collector ([collector/README.md](collector/README.md): handshake, token, ring buffer, LibreHardwareMonitor 2 Hz + NVML 10 Hz + PDH 1 Hz, snapshot, SSE, load runs), the **Audit** page (the plan section 8 rules in `src/analysis/audit.ts`: snapshot, 5 s idle sample, 3 s light PCIe load, 20 s heavy thermal ramp judged over its steady window behind an engagement gate; top five by severity × cost, show all, copy report) and the **Monitor** page (plan section 17a: vendor-accented CPU, GPU and Board panels, the chip diagram with hover detail, the 12V-2x6 connector block with spread and max/mean, the system-power row, rails, fans, sparklines; pieces in `src/components/monitor/`). No-orphan rule enforced on both sides. **Polish (2026-09-16, the user's feedback on the live app, `.claude/workflows/phase1-polish.md`):** device names on the panel headers (the GPU's board partner from the PCI subsystem vendor id, `nvmlDeviceGetPciInfo_v3` + `src/data/vendors.json`), every title renameable in place; the CPU power limit as a setting (`cpuPptW`, the stock PPT from `cpus.json` labelled *stock* until set) with PBO inferred from the measured package power; movable, resizable panels persisted in settings, with Reset layout; the plan section 17a card schematic pulled forward into the GPU panel (fans as duty arcs, VRAM as chip fill, die, engines, PCIe edge with Rx/Tx, 12V-2x6 stub); five CPU audit rules over a 20 s all-core vector-FMA load (`strata-tune-worker --cpu-load`; it pulls this 9950X to 264 W and its 95 °C Tjmax, so the rules have something to judge); GPU overclock detection from `nvmlDeviceGetClockOffsets` and the reworded power-limit finding; the collector answers and streams from t+62 ms with the sensor groups opening behind `warming` (the app connected at t+217 ms against 9.7 s before; PDH's first enumeration at t+7.7 s is the last source in). Evidence in the same document. |
| 2 Sensors | Not started. |
| 3 AI advisor | **v0.2.** The **AI Models** page (plan section 10). `src/data/models.json` (22 models, 73 Ollama pull tags, every tag checked against ollama.com and the architecture numbers read from the GGUF metadata Ollama serves; a row whose GGUF carries an MTP head that Ollama runs as speculative decoding says so with `mtpAcceptedTokens`, which multiplies its tok/s and keeps it out of the calibration factor; a row with sliding-window blocks (Gemma 3, gpt-oss) says so with `swa`, so its KV cache is sized at the window as llama.cpp's iSWA cache does), `src/data/gpus.json` (37 NVIDIA, AMD and Intel rows: the vendor's advertised AI TOPS exactly as printed with its precision and sparsity, the spec tiles from each card's TechPowerUp page (die, shading units, TMUs, ROPs, memory type, bus, data rate, base/boost, TDP, the vendor's PSU recommendation), bandwidth for every row, tensor TOPS per precision dense and sparse with BF16/TF32 from the Blackwell whitepaper tables, FP32 shader TFLOPS; a figure nobody publishes is `null`, a dense figure halved from a sparse headline is flagged `denseDerived`) and NPU TOPS on the `cpus.json` rows. `src/analysis/advisor.ts` sizes every quant of every model (the pulled file + GQA KV cache at the chosen context, windowed blocks at their window + vision tower + reserves) against VRAM and RAM into Runs fast / Runs, tight (under 1.5 GiB of headroom) / Runs slowly (with the offload cliff) / Won't run, estimates tok/s from bandwidth (a measured copy rate, or spec x the 0.8 a stream copy reaches), sorts by total parameters so a 30B-A3B ranks as a 30B, checks the download against the model drive and picks the best model for chat, coding, vision and reasoning among the rows whose window holds the context. The **AI stats card** opens with the advertised figure ("3,352 AI TOPS · FP4 sparse"), the architecture line and the spec tiles, then dense/sparse pairs, spec against expected and measured bandwidth, and the worker's matmul beside the shader spec, every number tagged spec / measured / estimated / derived / default. Each model row carries a one-click `ollama pull <tag>`; without Ollama the page says once "Install Ollama to measure real tokens/s on your models." Measurements come from `strata-tune-worker --bench --json` (a 1 GiB stream copy and a 4096 fp32 / fp16-storage matmul, timing-only, cached per GPU and driver in `bench.json`, applied only to the same card) and from a timed 256-token Ollama generation per installed model, both through `electron/bench.ts`; "Set factor from measurements" makes the median ratio this box's own factor, warned when it leaves the 0.3–1.0 band. Without the collector the page runs standalone from a GPU picker, RAM and free-space inputs. Calibrated on the dev box in [docs/phase3-calibration.md](docs/phase3-calibration.md): the 5090 measures 1603–1611 GB/s (80 % of the bus its +229 MHz memory offset gives), and qwen3:4b decodes at 0.50 of the bandwidth bound, so the plan's 0.65 factor is now the measured 0.50 — from one dense 4B model only; the dense 30B-class and MoE pulls the plan's three-model calibration needs (20 + 19 GB) wait for the user, and MoE rows carry a "MoE ceiling" chip until one is timed. **Deferred:** the plan's `diffusion` row type (LTX-2.5 / Gemma 4 12B from Strata Video) needs a sizing model of its own (no KV cache, steps/s not tok/s) and is not in `models.json`; the three-column spec / this card / measured bandwidth needs the collector's max memory clock. |
| 4–5 Capture and stutter classifier | **Built and run once on this box (2026-09-16); not yet judged on a game.** The **Capture** page (`src/pages/Capture.tsx`, `src/components/capture/`): pick a windowed process or arm Game Mode; PresentMon 2.5.1 runs *unelevated* from Electron main (`electron/presentmon.ts`, `electron/capture.ts`; this user is in Performance Log Users, so the host is not in the collector as the plan says); frames stream into `%LOCALAPPDATA%\Strata Tune\sessions\<stamp>-<exe>.stsession` (`frames.ndjson.gz`, `sensors.ndjson.gz` sliced from the collector's window while it is connected, `gpu.ndjson.gz` from its ticks, `session.json`; `electron/sessions.ts`). A multi-process app is captured by image name, because the presenting pid is its GPU helper, not its window. Analysis runs in the renderer (`src/analysis/frames.ts`, `stutter.ts`, `bound.ts`: detection, the nine section 11 cases with confidence, the section 12 CPU-or-GPU verdict; `src/components/capture/toReport.ts` maps it for the renderer), the report is `src/report/ReportView` in-app and as one self-contained HTML file (`sessions:exportHtml` in `electron/capture.ts` fills the template from `npm run build:report`, which `npm run build` runs as `postbuild`). The bench (`collector/StrataTune.Bench`, `strata-tune-bench.exe`: DX12 flip-model scene, five-segment 90 s script, Vortice 3.8.3, gpu.lock holder `strata-tune-bench`) is in the solution but not yet launched from the app. Verified: a 20 s capture of `claude.exe` with the collector up saved 4,337 frames, 262 sensor rows and 40 GPU samples; the session reopened with a headline and the measurements table; the exported file opened standalone from `file://`. Waits: a real game capture (the Phase 5 gate), the bench wired into Capture, and the "fine" line for short captures (one hitch in 17 s is 3.5 a minute, over the 2-a-minute line, so a single 9 ms frame headlines its cause). |
| 6 Power | PSU model only: `src/analysis/psu.ts` + `src/data/psu.json` (80 PLUS curves, wall watts from DC watts, over/tight/good/generous verdict with a recommended size, the transient disclaimer text). Waits: the PSU prompt UI, cost and performance-per-watt, and the estimated parts of the plan section 13 table. |
| 7 Score and share card | Libraries only: `src/analysis/score.ts` (four subscores, weights renormalised over what was measured, the stability cap, validity flags that make the total null), `src/report/ShareCard.tsx` (1200x630 SVG drawn to a 2D canvas), `src/analysis/history.ts` + `electron/history.ts` (`history.json` in the app's userData, IPC `history:list` / `history:add`). Waits: a page that runs the fixed workload, computes and shows the score and the card, and the section 15 before/after view; nothing in the renderer calls `api.history` yet. |
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

## The collector and the UAC prompt

Sensors need the PawnIO driver, and PawnIO only answers administrators, so the
collector runs elevated while the app does not (plan section 5). Every start of
the app shows one UAC prompt for `strata-tune-collector.exe`; decline it and the
app still opens, with the Audit and Monitor pages showing "Permission declined"
and a Retry. The collector listens on a random loopback port with a per-launch
token, serves nothing without it, and exits by itself once the app's process is
gone; the app also posts `/shutdown` on quit so that happens sooner.

Developer run: build the collector first, then start Electron.

```
$env:Path = 'C:\Program Files\dotnet;' + $env:Path     # if dotnet is not on the path
dotnet build collector\StrataTune.sln -c Release          # scripts/build-collector.ps1 publishes the shipping exes
npm run build
npx electron .                                            # a window opens, then the UAC prompt
```

In development the app runs the newer of the Release build under
`collector\StrataTune.Collector\bin\x64\Release\net10.0\win-x64\` (the build
copies the worker beside it) and the published bundle in `resources\collector\`
(`scripts\build-collector.ps1`); packaged, always the bundle. Windows Smart App
Control refuses the loose build's freshly compiled DLLs on some boxes
(CodeIntegrity 3077, `0x800711C7`) while it accepts the self-contained bundle,
so when a plain `dotnet build` stops connecting, publish once and the bundle
wins by date. A still-running collector from a previous run is reused rather
than launched again. A `collector.json` left behind by a crash, End Task or a reboot is
removed at start once its pid is dead or belongs to something other than
`strata-tune-collector.exe` (low pids are reused); only a collector that is
alive and not answering is left alone, with a Retry. The app passes its own
handshake and log paths under its `%LOCALAPPDATA%`, so an over-the-shoulder
elevation with another account's credentials still lands where the app looks.

**No orphan rule.** An elevated process that outlives the app is a bug, never a
feature: after every quit `strata-tune-collector` must be gone within 5 s. The
app cannot kill it (an elevated child is out of reach of a medium-integrity
parent), so it does not try; it arms a detached watcher at quit that checks 5 s
after the app's own exit and appends to `%LOCALAPPDATA%\Strata Tune\orphan.log`
if the collector is still alive, and the next start prints that log. Verify by
hand with `Get-Process strata-tune-collector` after closing the window.

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
