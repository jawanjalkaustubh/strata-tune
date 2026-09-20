# Strata Tune on macOS (Apple Silicon)

Strata Tune was written for Windows, where a .NET collector reads LibreHardwareMonitor,
NVML and NVAPI under elevation. On a Mac the same app runs with a **macOS collector**
inside the Electron main process (`electron/mac/`): no elevation, no second process, the
same loopback HTTP + SSE contract (`src/collector-types.ts`), so the pages are unchanged.

| Page | On macOS |
|---|---|
| **Tune** | The audit runs: the snapshot, the idle sample, the GPU loads and the all-core load come from the Mac worker and macmon. The Headroom hunt is not shown: it drives NVIDIA clock offsets and Apple GPUs have no user clock control. |
| **Monitor** | Live: the CPU chip diagram with Apple's own cluster names (super and performance cores on the M5 Pro/Max), the GPU's SoC diagram (one cell per GPU core, the Neural Engine, the unified memory the GPU works from), core clocks and load, package power and temperature, GPU clock, load, power, temperature and memory in use, fans, system / memory / Neural Engine power, unified memory, the battery. No board rails, no 12V-2x6 pins, no PCIe link: those sensors do not exist here and the panels collapse as they do on a laptop. |
| **AI Models** | Everything: the Apple GPU is the card (its Metal working set is the memory a model is judged against), the spec tiles come from `src/data/apple-gpus.json` (Apple's core counts and bandwidth, the per-core unit counts, the machine's own clock), **Measure** runs the Metal worker (stream-copy bandwidth, fp32 and fp16 matmul TFLOPS, and on macOS 26 the GPU's matrix path through Metal 4 tensor ops at int8 and fp16) and leads the card with the measured int8 TOPS because Apple advertises no TOPS figure, Ollama timings and pulls work as on Windows. |
| **Capture** | Not shown. Frame capture needs PresentMon's ETW session, which has no macOS counterpart. |

## Install

```bash
git clone https://github.com/jawanjalkaustubh/strata-tune.git
cd strata-tune
scripts/mac/setup.sh          # --yes for no prompts
```

The script installs `node@24`, `macmon` and `ollama` with Homebrew (and Homebrew itself if
missing), runs `npm ci` and `npm run build`, builds the Swift worker with the command-line
tools' toolchain (`scripts/mac/build-collector.sh`) and installs **Strata Tune.app** in
`~/Applications` with a Desktop alias (`scripts/mac/install-shortcuts.sh`). Or by hand:

```bash
brew install node@24 macmon && brew link --overwrite node@24
npm ci && npm run build
scripts/mac/build-collector.sh    # collector/mac -> .build/release/strata-tune-mac-worker
npm start                         # or double-click run-strata-tune.command
npm test
```

Node 24, not Homebrew's plain `node` (26): Electron's unpacker stops silently after the
first file on 26 and the app then fails with "Electron failed to install correctly".

## How the macOS collector reads the machine

- **macmon** (`brew install macmon`, sudo-less) streams per-core frequency and active
  ratio for the P and E clusters, CPU / GPU / ANE / memory / system power, GPU frequency and
  active ratio, fan speeds, memory and the average CPU and GPU temperatures at 2 Hz.
  `electron/mac/sensors.ts` shapes them into LibreHardwareMonitor's names so the Monitor's
  layouts match unchanged. Without macmon the status pill says so and only the IOKit rows exist.
- **IOKit through ioreg**: the GPU's memory in use (`IOAccelerator`) and the battery
  (`AppleSmartBattery`), polled every 2 s.
- **The snapshot** (`electron/mac/snapshot.ts`): `sysctl`, `system_profiler`, `diskutil`,
  `df`, `pmset` (the power mode) and Ollama's `/api/ps`. The Apple GPU is listed as a display
  adapter with vendor `apple` and, as its "dedicated" memory, Metal's recommended working set
  (about three quarters of unified memory): what the GPU may hold, the figure a model's fit is judged by.
- **The worker** (`collector/mac`, Swift, Metal + MPS): `--bench --json` prints the same line
  as the Windows worker (stream-copy GB/s, fp32 and fp16-storage matmul TFLOPS) plus, on macOS 26,
  `matmulTopsInt8` and `matmulTflopsFp16tensor` from Metal 4 tensor ops (MetalPerformancePrimitives
  `matmul2d`, 64 x 64 tiles, int8 with int32 accumulate: the precision a PC's "AI TOPS" quotes,
  measured dense rather than a vendor's sparse peak); `--load light|heavy|cpu|fillrate` are the
  audit's kernels; `--info` the device facts. On the M5 Max 40-core: 549 GB/s, 15 / 65 TFLOPS, 107 int8 TOPS.
- **Time base**: microseconds from the Mach monotonic clock (`Health.qpcFrequency` = 1e6).
- **Tune routes**: `/tune/state` answers `nvapi.available: false` with the reason; every
  `/tune/*` write is 403. `/timers` answers nulls: macOS has no timer-resolution setting.

Data: `~/Library/Application Support/Strata Tune/` (collector.json, bench.json, sessions);
presence files shared with Strata Code and Photo: `~/Library/Application Support/Strata/presence/`.

## The Apple spec table

`src/data/apple-gpus.json` holds what Apple publishes (GPU and Neural Engine core counts,
memory bandwidth) with the unit counts the review sites list by the per-core rule (128
ALUs, 8 TMUs, 4 ROPs per core), each row cited. Apple prints no clock, power or tensor
figure, so the clock tile is the top of the GPU's clock table as macOS reports it, the FP32
figure follows the table's own convention (ALUs x 2 x clock), the TDP tile says "not
published", and the headline is the measured fp16 matmul once Measure has run. The rows
are separate from `gpus.json` because that table's invariants (a TDP, a TechPowerUp page)
do not hold for Apple parts.

## Comparing with a PC

The AI Models stats card reads the same on both: Measure's bandwidth and matmul figures are
measured the same way (a 1 GiB stream copy, a 4096² matmul), Ollama tok/s is Ollama's own
count, and the tok/s estimates use the same bandwidth-bound model. No reference row exists
for Apple GPUs in `gpus.json` (Apple publishes no tensor-throughput figures), so the card
shows the measurements and says so instead of an advertised TOPS headline.

## Troubleshooting

- **"Electron failed to install correctly"** on launch, or `node_modules/electron/dist`
  holding only `LICENSES.chromium.html`: the dependencies were installed with Node 26
  (Homebrew's plain `node`), where Electron's unpacker (extract-zip) stops silently
  after the first file. `brew install node@24 && brew link --overwrite node@24`, then
  `node node_modules/electron/install.js`.
- **Collector: Connected · install macmon**: `brew install macmon`, then Retry.
- **Measure says "Worker not built"**: `scripts/mac/build-collector.sh` (needs the
  command-line tools: `xcode-select --install`).
- **The Dock shows "Electron"**: `run-strata-tune.command` renames and re-signs the
  development Electron bundle once; launch through it or the app in `~/Applications`.

## What changed for the port

- `electron/mac/`: the collector (`server.ts`), the sensor source (`sensors.ts`), the
  snapshot, the process sampler (`hogs.ts`), the load runner (`loads.ts`) and the paths.
- `electron/collector.ts`: on macOS `start()` runs the in-process collector and adopts its
  handshake; the Windows elevation path is untouched.
- `electron/bench.ts`: the worker path on macOS.
- `electron/presence.ts`: `strataDataDir()` and `tuneDataDir()` resolve
  `~/Library/Application Support/Strata` and `.../Strata Tune` on macOS.
- `src/collector-types.ts`: `DisplayAdapter.vendor` gains `'apple'`; the AI Models page
  treats it as the card and, once measured, uses the GPU's bandwidth as the memory bus
  (one pool).
- `src/App.tsx`, `src/pages/Tune.tsx`: no Capture page and no Headroom section on macOS.
- Tests: `tests/mac-sensors.test.ts` (the rows against the Monitor layouts, the parsers),
  `tests/mac-collector.test.ts` (the routes over the wire through `CollectorClient`).
