# Strata Tune collector (.NET)

The elevated sensor process and its disposable GPU worker. Versions are pinned in
[docs/dependencies.md](../docs/dependencies.md); the design is master-plan sections 4 to 7.

```
StrataTune.sln
  StrataTune.Shared/      the wire contract: C# records mirroring src/collector-types.ts, one
                          source-generated System.Text.Json context (camelCase, enums as strings)
  StrataTune.Collector/   --probe (Phase 0 report), --serve (Kestrel on loopback: LHM + NVML + PDH
                          samplers, ring buffer, SSE, snapshot, hogs, load runs, the /tune/* supervisor)
                          and --revert-if-pending (the start pass on its own, plan section 16)
  StrataTune.Worker/      ComputeSharp kernels: --hash (deterministic), --load (timed heat), --reference and --ladder (tune stages 1-2), heartbeat
  Directory.Build.props   net10.0, win-x64, x64, nullable, implicit usings, version, for all three
```

## Build

`global.json` at the repo root pins SDK 10.0.401 (`rollForward: latestPatch`). If `dotnet`
is not on the path: `$env:Path = 'C:\Program Files\dotnet;' + $env:Path`.

```
dotnet build collector\StrataTune.sln -c Release
```

Outputs (the `x64` segment comes from `Platforms=x64` in Directory.Build.props):

```
collector\StrataTune.Collector\bin\x64\Release\net10.0\win-x64\strata-tune-collector.exe
collector\StrataTune.Worker\bin\x64\Release\net10.0\win-x64\strata-tune-worker.exe
```

Shipping builds are self-contained single-file, one per exe, published side by side into
`resources/collector/` (gitignored, the folder the packaged app carries):

```
powershell -ExecutionPolicy Bypass -File scripts\build-collector.ps1
```

`IncludeNativeLibrariesForSelfExtract` stays off: it would extract native DLLs to `%TEMP%`
at every start, which is exactly the directory an elevated process must not load from. The
few native libraries the host cannot embed (Mono.Posix's helper, pulled in by
LibreHardwareMonitorLib) therefore land beside the exe.

The ComputeSharp source generator compiles the worker's shaders to DXIL at build time and
needs `AllowUnsafeBlocks` (analyzer error CMPS0052 without it); that is why the worker csproj
keeps that one property locally. `bin/` and `obj/` are gitignored.

## The three executables

### strata-tune-collector.exe (elevated)

| Verb | What it does |
|---|---|
| `--probe [--out <file>]` | One plain-text page: elevation and PawnIO state, every LHM sensor read twice 600 ms apart with min/max, the NVML facts per GPU, two PDH samples 1 s apart, a sanity block, then `computer.GetReport()` with the identifiers redacted. |
| `--revert-if-pending` | The pass every `--serve` start runs first, on its own (plan section 16): reads `%ProgramData%\Strata Tune\tune-state.json` and acts on it exactly as the collector's own start does (the table under *Tune's revert-at-start pass* below): a `PENDING` rung is reverted. No port, no sensors, no handshake; exit 0 when nothing was pending or the revert applied, 1 when the driver refused it, the file has no baseline to revert to (nothing is guessed, never 0/0), or the file does not parse (a copy is kept as `tune-state.json.bad`). There is no logon task any more: P0 deltas do not survive a boot, so a hard hang self-heals at the next boot, and a collector that died without the machine going down is covered by the next collector start. A task the Phase 8 build registered (`Strata Tune revert-if-pending`) is deleted once at start and logged. |
| `--serve --parent-pid <pid> [--parent-start <epoch ms>] [--handshake <file>] [--log <file>]` | The UI's mode: the HTTP service described below, alive exactly as long as the process `<pid>` (the UI) is. `--parent-start` is the UI's own start time; a pid that was not created within 10 s of it has been recycled and is refused. `--handshake` and `--log` are where the UI will look (its own `%LOCALAPPDATA%\Strata Tune`, even when UAC elevated this process under another account); without them the elevated identity's profile is used. The worker for load runs is the `strata-tune-worker.exe` beside this exe: `--worker` is still accepted but only for a path inside this exe's folder, because an administrator process must not run an executable named from medium integrity. `--ui-pid` is accepted as a spelling of `--parent-pid`. |

Exit codes for `--probe`: `0` ok, `1` an LHM or PDH block threw (the others still print),
`2` not elevated (nothing is read), `3` NVML failed (LHM and PDH still print), `4` PawnIO
cannot be used, so the CPU and board numbers would be zeros rather than readings. For
`--serve`: `0` clean exit (parent gone, `POST /shutdown`, Ctrl+C or SIGTERM), `1` bad
arguments, a `--parent-pid` that is not running or was not started when `--parent-start`
says (a stale prompt answered after its UI has gone, its pid handed on), a `--worker`
outside this exe's folder, a collector already running for this user (the handshake names a
live `strata-tune-collector`: a live collector is never doubled, on this side as well as the
UI's) or a fatal error (logged), `2` not elevated; every refusal happens before anything is opened.

`--out` exists because an elevated child cannot pipe stdout to a non-elevated parent, and it
errors rather than being ignored when its value is missing. The report is buffered and
flushed even when a block crashes, so partial evidence survives. From a non-elevated shell:

```
Start-Process -FilePath <path>\strata-tune-collector.exe -ArgumentList '--probe','--out','D:\probe.txt' -Verb RunAs -Wait
```

**What the report leaves out.** `Redact` strips every `… Serial:` line, the whole base64
`SMBios Table` block (which carries the board serial, both DIMM serials and the SMBIOS
system UUID) and the instance id at the tail of a PCI device path (on an NVIDIA card that is
the PCIe device serial number) before the text is written. The same text becomes the
shareable HTML report in plan section 19, so it is stripped where it is produced. Strings
that come from hardware also go through `Printable`, because a DIMM here returns SPD bytes
that are not clean text; the JSON streams use the same helper for every hardware name.

#### The service (`--serve`)

Plan section 5, made concrete:

- **Handshake.** Kestrel binds `127.0.0.1` on a port the OS picks; the collector then writes
  `collector.json` (`{ port, token, pid, startedAt }`, at the path the UI passed or its own
  `%LOCALAPPDATA%\Strata Tune`) through a per-pid temp file and a rename, so a reader never
  sees half a document and two instances starting at once never share a temp name, and
  deletes it on a clean exit, but only if the file still carries its own pid: an instance
  exiting late must not take a newer collector's handshake with it. The token is 32 random
  bytes as hex, generated per launch, never logged.
- **The handshake comes before the sensors** (phase1-polish item 8). Kestrel binds and the
  file is written before NVML, LibreHardwareMonitor or PDH are opened; `/health` answers
  `warming: true` meanwhile and every tick carries the same flag. The sources then open on a
  background task, NVML first (it is quick and the GPU panel reads from it alone), then the
  LibreHardwareMonitor driver with its hardware groups enabled live in stages, CPU, board,
  GPU, memory, storage (SMART over every drive is the slow one), then PDH. `/sensors/meta`
  grows as they arrive; a client re-reads it once `warming` turns false. The log stamps each
  step `t+X ms` from process start, which is the measurement for the 1.5 s budget.
- **One bad source is a gap, not a failure.** NVML, LibreHardwareMonitor and PDH each open
  inside their own try: a missing NVIDIA driver, a corrupt performance-counter registry (the
  `lodctr /R` condition) or a library that throws on this board is logged, reported as
  `available: false` in `/health`, and left out of the stream while the others flow. Inside
  the LibreHardwareMonitor tree one hardware node whose update throws costs that node's
  readings for the tick (reported once a minute), not the tree's; one NVML card that fails a
  mandatory call is skipped, not the others; `/snapshot` and `/gpu` answer an empty `gpus[]`
  rather than a 500 when NVML fails mid-read. A sensor that stops reporting drops out of the
  latest row after 3 s instead of sitting there at its last value.
- **Auth.** Every request needs `Authorization: Bearer <token>` (`401` otherwise, compared in
  fixed time); a non-loopback remote address gets `403` even though Kestrel only listens on
  loopback. Error bodies are `{ "error": "…" }`.
- **Lifetime.** The UI's pid is watched with a handle-pinned `WaitForExit` on its own thread,
  so a recycled pid cannot fool it; when the UI is gone the samplers stop, a running worker is
  killed, the handshake is deleted and the process exits 0. `POST /shutdown` (202, then stop
  once the response is on the wire) is the graceful spelling the UI sends from `before-quit`;
  Ctrl+C and SIGTERM take the same path. The exit is bounded: the handshake goes first, then
  a 4 s watchdog ends the process even if closing the sensor tree hangs behind a stuck driver
  call, so the no-orphan rule's 5 s holds whatever a driver does.
- **One clock.** Every stamp is `Stopwatch.GetTimestamp()` (QPC); `/health` carries
  `qpcFrequency`. Three sampling loops, one per source, none waiting on another: NVML at
  10 Hz, LibreHardwareMonitor at 2 Hz (the package-power delta needs ≥ 500 ms and the shared
  super-IO mutex should not be polled faster), PDH disk queue depth at 1 Hz.
- **Ring buffer** (plan section 6). Full-rate rows for the last ten minutes, then folded into
  one-second min/max/mean summaries kept for four hours or a 64 MB budget, whichever runs out
  first. Rows are one float per sensor with the id array shared per source, so ten minutes
  of this box's 380-odd sensors is a few megabytes.
- **Sensor ids.** LibreHardwareMonitor identifiers, which are *not* unique: the 5090 emits
  `/gpu-nvidia/0/voltage/0` twice (GPU Core Voltage, 12VHPWR Pin 1) and `/gpu-nvidia/0/load/3`
  twice (GPU Bus, GPU Memory). A repeat under the same hardware node gets `#n` appended in
  enumeration order (`/gpu-nvidia/0/voltage/0#1`), which the library keeps fixed per machine,
  so the ids hold across ticks and runs. NVML fields get `/nvml/<i>/…` ids (`clocks/sm`,
  `clocks/mem`, `power` and `powerLimit` in watts, `temperature`, `vram/used`, `vram/total`,
  `util/gpu`, `util/mem`, `pcie/gen`, `pcie/width`, `clocksEventReasons` as the raw mask) and
  the disk queue `/pdh/physicaldisk/<n>/queue`, `n` being the disk index PDH puts at the front
  of its instance name (`2 D: E: C:`). `/sensors/meta` lists all of them with units.
- **Log.** `%LOCALAPPDATA%\Strata Tune\logs\collector.log`, one line per event (start, port,
  each stream client, load runs, errors), rolled once past 1 MB.

| Endpoint | Returns |
|---|---|
| `GET /health` | `Health`: pid, version, PawnIO usable (the device opened, not the registry entry), NVML driver, whether the LibreHardwareMonitor and PDH sources opened (`lhm.available`, `pdh.available`), `qpcFrequency`, uptime |
| `GET /snapshot` | `StaticSnapshot`: OS, chassis and laptop flag (SMBIOS chassis type; a battery only decides when the type is missing or "Other", because a USB UPS is a battery too), CPU (CPUID family/model from the WMI caption), board and BIOS date, DIMMs, `gpus[]` as read at capture time, GPU driver version and install date, active power plan plus the Windows power-mode overlay (`overlayGuid`, the Settings slider the active-scheme API never reports), physical disks (media and bus type), fixed volumes with the physical disk each lives on, Ollama's loaded models or `null`. Each block is read on its own; one failed WMI class empties that block only. Takes 1–3 s (WMI). |
| `GET /sensors/meta` | `SensorMeta[]` |
| `GET /sensors/latest` | one `SensorRow`: the newest value of every id |
| `GET /sensors/window?seconds=N` | `SensorWindow`: full-rate `rows` for N ≤ 600, `summaries` beyond, the other list empty; thinned per source until the JSON fits in about 2.5 MB |
| `GET /gpu` | `GpuFacts[]`, a fresh NVML read |
| `GET /stream` | `text/event-stream`, one `event: tick` with a `Tick` every 500 ms, a `: keep-alive` comment every 10 s; one loop per client. While Tune is enabled or a run is live, an `event: tune` with the `TuneRun` follows each tick |
| `GET /hogs?seconds=N&excludePid=P` (also `/procs/hogs`) | `HogsResult`, N in 2..15: every process's CPU time and working set at the start and end of the window; CPU is percent of all logical CPUs; the collector's tree (the worker is its child), P's tree (the UI) and the kernel-backed pseudo-processes (System, Memory Compression, Registry, Secure System) are excluded, because none of them is a program the user could close |
| `POST /load` `{ kind, seconds }` | `LoadRun` with `state: running`; `409` while one runs, `400` for a bad request. A `light` run started from idle does not take the 5090 out of its half-rate memory P-state (14 samples at 7001 MHz / 80 W on 2026-09-17), so it says nothing about what the card holds; run `heavy` first (16041 / 3225 at 600 W), and a `light` run in the seconds after it reads the P0 memory clock (16041). Starts the worker with `--load <kind> --seconds N --heartbeat <temp file>` (`--cpu-load --seconds N` for kind `cpu`) and samples GPU 0 (or, for `cpu`, the library's CPU package power, Tctl, average effective and highest core clock into `cpuSamples`) at 2 Hz from just before the worker starts, so the first sample is the idle reference, until it exits. Kind `fillrate` starts the bench beside the collector instead (`--fillrate --json --seconds N`, no heartbeat) with the same GPU sampling, and keeps its one JSON line as `fillRate`; a run that exits 0 without the line is `failed` (the missing-ROPs cross-check, plan section 8) |
| `GET /load/{id}` | the `LoadRun`: `done` with exit 0, else `failed` with the worker's exit code (3 no hardware GPU, 10 device lost) and its stderr; the last eight runs are kept |
| `POST /load/{id}/cancel` | Stop (plan section 17c): the worker or bench is killed with its process tree, the run is marked `cancelled` at once (a start that follows is not refused as busy) and answered once the process is gone or after 2 s; the samples taken until then stay on the run and no error is recorded. A bench killed this way never ran its own gpu.lock release, so the lock it left under a dead pid is cleared. `409` when the run has already ended, `404` for an unknown id |
| `GET /tune/state` | `TuneStatus`: the state file (`enabled`, `state` IDLE / PENDING / REVERTED, `baseline`, `candidate`, `reverted` with the rung and the stage, `result`, `history`), the NVAPI read (`nvapi.deltas` and the driver's range, or the reason it is unavailable), the live `run` (with `repeat`, which repeat of the shape a scored run is on, and `asFound` once the as-found run has scored), whether a flight file exists, the file's path, `problem` when Tune refuses to act at all (the state folder could not be restricted to administrators, the file does not parse, another user's collector owns the state), and `estimateMinutes`, what a full hunt takes on a typical card (`TuneTiming`: 2 min as found + 6 + 6 rungs of a minute + 2 min official = 16, one more with a vendor rung; a capped run is 2 + cap + cap + 2). Every successful `POST /tune/*` answers the same shape |
| `POST /tune/enable` `{ enabled, acknowledgedAt?, appVersion? }` | On: records the warning's acknowledgement in the history and the log (plan section 27a: `warning acknowledged <date>, app <version>, GPU <name from NVML>`) and sets the file flag. Off: refuses (`409`) while a run is going, otherwise takes anything of Tune's off the card (unless the file cannot be trusted, in which case the card is left as it is) and clears the flag |
| `POST /tune/start` `{ kind: hunt \| core \| memory, enabled?, maxCandidates?, vendor?, coreCapMhz?, memCapMhz? }` | Starts the hunt (plan section 16, as of 2026-09-16: find the numbers, score them, hand them over, leave the card as found) and answers at once; the run is watched on `/tune/state` and the `tune` event. `403` unless Tune is enabled on both sides (the file flag and the request's `enabled`); `409` before the revert-at-start pass has run or while the state file cannot be trusted, while warming or without NVML, when NVAPI cannot read the P0 deltas, on a box with more than one GPU (NVML or NVAPI; the offset is written to one card and the load could run on another, so multi-GPU is refused until the handle is matched by PCI bus id), when Windows' GPU timeout is off or longer than 10 s (`TdrLevel` / `TdrDelay` / `TdrDdiDelay` under `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`: a hung rung would then never become a driver reset), while a run is going, at PENDING, within 15 s of any device loss and for 60 s after two (kept in the file across runs and restarts; a device loss during the reference run counts too), while the family's `gpu.lock` is held, while the bench, a worker or a PresentMon capture runs, or while Ollama has a model resident. A vendor OC tool may stay open. **The run.** (1) The P0 deltas are read from the card, never written (plan section 16, rule 3: run 74c3442b1294 wrote 0 / 0 before measuring and that write took GPU Tweak's tune off the card); the worker lists adapters and captures the reference hash. (2) **The card as found is scored**: two repeats of the 60 s shape with nothing written (`asFound`): its sustained peaks are `baselineHeld`, its variable-half peak the top of the curve, its throughput and bandwidth the floor every rung is judged against, and its points the score the official run is compared with. (3) **The baseline is decided before the first write** (`TuneLadder.PlanVendor`, mirrored and tested as `planVendor` in `src/analysis/tune.ts`): a held clock above the driver's ceiling (`nvmlDeviceGetMaxClockInfo`, 3090 / 14001 MHz on the dev box) plus our own P0 offset plus one 15 MHz bin is a tune by a route ours does not read and — measured on the dev box on 2026-09-17 — does not add to either: `NvAPI_GPU_SetPstates20` REPLACES it (as found 16008 → +15 written → held 14016 = stock 14001 + 15 → restore 0 / 0 left 14001; the user's +319 / +4072 was gone). So the request carries `vendor`, what the tool shows (core MHz, memory in the slider's effective-rate units, from the settings' `vendorCoreOffsetMhz` / `vendorMemoryOffset`): with a foreign tune and no value the run refuses untouched (`foreign-tune`: "your card holds a tune we cannot see — enter what your vendor tool shows first"); the memory value is cross-checked against held − ceiling within 60 NVML MHz (16008 − 14001 = 2007 against +4072 ÷ 2 = 2036 passes, a stale +3672 fails, a card at stock against any value fails: `vendor-mismatch`, "not applied on the card", with both numbers; the core cannot be checked under a power cap and is trusted, guarded by the additivity check); a foreign core with core +0 entered is refused (the write would wipe it); with the check passed (its arithmetic is in the log: `memory cross-check: 16041 held − 14001 ceiling = 2040 NVML MHz against +2036 entered, within 60`) the tune is written through our route as the **vendor rung** (one rung; its peaks must reproduce the card as found: memory within 60 MHz, SM within 120) and becomes the baseline every rung sits on and every restore puts back, **never 0**; its own peaks, not the as-found ones, are what the ladders climb from and check additivity against (`ClimbFrom`: the two routes sit a boost bin apart, 3337 MHz at the top of the curve as found against 3322 through P0 +319 on the dev box, run 154463d9b2f1); the state file records the vendor values beside the baseline so the revert at the next start restores them too. With nothing foreign the driver's own P0 deltas are the baseline (a value entered that they already reproduce, after an earlier hunt, is kept for the export). (4) **Each ladder** (`hunt` is memory first, on its own, then core from the baseline again; `core` and `memory` run one ladder) climbs in **+15 MHz rungs** (NVML MHz for memory, 30 on the effective rate the vendor sliders show), bisected to 5; **a rung is a minute**: 30 s `variable` (heavy bursts 2–4 s apart with light or idle gaps, seeded so every rung and every card runs the same shape, hash-checked on every burst; its peak SM clock is the top of the curve) then 30 s `sustained` (hash-checked on every dispatch; its throughput, held clocks, limit bits and closing 1 GiB stream pass). Per rung the file says PENDING before `NvAPI_GPU_SetPstates20` hears the value (a file the disk did not take means nothing is applied), the driver's read-back must equal the request and the value must be inside the driver's range or the apply is a failure, and the verdict is read off the exit code, the heartbeat (two consecutive stale reads, the file opened sharing write and delete) and the sensors. **The climb asserts additivity** (`TuneLadder.JudgeAdditivity`, then the cap signals): the held clock (the core's top of the curve under the variable half; the memory clock under the sustained half) must be at least the baseline plus 0.6 x the offset written so far. Memory shows it on the first rung (16037 → 16052) or the ladder ends with "the driver is not adding our offset on top of your tune" and the run fails on that sentence ("it replaced it" when the clock fell by more than a bin, on either ladder). The core's top of the curve moves in half bins between minutes (3322 / 3330 / 3337 on the dev box, runs 154463d9b2f1 and bb09b0a0455c), so a first +15 rung within a bin of the baseline is *undecided* and the +30 rung decides; and on a card whose tune already sits at the top of the VF table (3337 MHz on the dev box, whatever the offset) the top cannot move at all, so a core rung whose top did not move is judged on the **sustained half's mean SM clock and throughput** against the as-found repeats' spread as the noise floor (`TuneLadder.GainedOnCap`: the mean must rise more than max(5 MHz, the spread), the throughput more than max(0.3 %, 3 x the spread); on the dev box the +15 rung read 3927 against 3889 Gsteps/s, +1.0 %, so the offset counts where the card runs, on the cap); when neither the top, the mean nor the throughput moved at +30 the ladder ends with `top-of-table` ("the card already runs at the top of its clock table; no core headroom above it through offsets, certified +0 core"), a converged result and not a refusal, the run goes on to the official run, and a rung certified while the check was still open is dropped. Once additivity is shown, a core rung that lifts neither the top by a bin nor the sustained figures over the rung below ends the climb at the rung below with the same reason, so the ladder never climbs blind to the driver's range with every rung "stable". Peaks, means and limit-bit shares are read from the steady window only (t >= 3 s of each half). **Every rung's held clock** is checked for another tool changing clocks under the test, which aborts the run: the memory clock against the baseline plus our offset (more than a rung plus one bin off while our delta is constant), the core's top against the rung below (`MovedFromPrevious`: a drop or a jump of more than a rung plus a bin between consecutive rungs, because the top stops tracking the offset at the table's top); a P0 delta that changed under the test aborts it too. **The user's cap** (`coreCapMhz` / `memCapMhz`, the Headroom form's "never test above"): a rung whose predicted clock (the ladder's reference plus the offset it would write) would pass the cap is not written and the ladder ends with `user-cap`, "stopped at your cap". **The power cap is the normal state**: a core rung is certified when every pass's hash matched and the sustained throughput (`steps` / `busyMs` from the worker) did not fall more than 3 % under the best certified rung; the share of samples under any limit bit is reported (`throttledFraction`), never judged. A **thermal-limit bit** on more than 5 % of the sustained samples ends the ladder: the cooler, not the clock, is the limit. A memory rung is certified when its hashes matched and the stream bandwidth did not fall more than max(3 %, 3 x the as-found repeats' spread) under the best certified; each ladder raises its own floor (the memory ladder's bandwidth, the core ladder's throughput), never the other's. **A bandwidth fall is confirmed before it counts** (`TuneHunt.ReconsiderBandwidthAsync`; also for the official run): on the dev box the stream pass reads in two modes about 9 % apart at one memory clock (1520 GB/s through the first five launches of run 154463d9b2f1, 1660 from the +45 memory rung to the end, 1520 again in bb09b0a0455c seventeen minutes later), so a rung that reads under the best certified gets the baseline put back and re-measured under 10 s of sustained load: a baseline that now reads under the best by the same rule is the bus in its other mode, not the rung — the floor is re-based to that reading, the rung is judged against it and turned stable when it holds (its note says so); a baseline that still reads at the best leaves the regression standing. The worker's JSON line now carries the pass count and the lowest and highest pass of the stream pass, and the log prints them with the SM clock in the pass's last second, so the next live run can pin the cause (the copy is a light SM load the boost governor may idle; the mode has not yet been tied to anything). The core ladder also ends when the top of the curve reaches the driver's clock ceiling and either ladder at the driver's offset range. **Every rung is scored** (`TuneCandidate.score`, `TuneScoring`): compute points from the sustained throughput + bandwidth points from the stream pass on one fixed scale where a reference 5090 at reference clocks is 10,000 (5,000 at 2861 Gsteps/s, the dev box's 3502.40 at 2947 MHz scaled to 2407; 5,000 at 1437 GB/s, the stream copy's ~80 % of the 1792 GB/s bus at 14001 MHz). (5) **The official run**: the certified pair (memory and core together) gets two repeats of the shape (`official`); a failure steps the failing ladder down one fine step (bandwidth → memory, throughput → core, a silent error or a reset → both) and re-runs once; a second failure leaves the pair uncertified and the as-found score stands. (6) **Every exit re-applies the baseline** (the vendor tune when one was found), retrying six times over 15 s; a restore the driver still refuses leaves the file PENDING, the run un-restored for the shutdown to try once more, and `/health` `tune.restoreFailure` set. A device loss puts the baseline back at once, before the 15 s wait; two device losses end the run. (7) **The end-of-run truth** (plan section 16, rule 4): once the baseline is back, a 10 s sustained load reads what the card holds now (`holdsNow`; the light load's SM clock is the boost governor bouncing, so the comparison uses the same sustained load the as-found figure came from); skipped after a stop, a driver reset, a failed restore, or when nothing was ever written. The result (written after each ladder, so a later ladder's abort keeps an earlier finding) carries `certified` (core / memory MHz on top of the baseline), `vendor`, `baselineHeld`, `heldAtCertified`, `firstFailure`, `stops`, `asFound`, `official`, `holdsNow` and `rungs`. `maxCandidates` caps each ladder's rungs for a bounded smoke test (unconverged, low confidence) |
| `POST /tune/stop` | Cancels the run: the worker is killed and the baseline restored as it ends; `409` when none is going |
| `POST /tune/revert` | Takes anything of Tune's off the card now (a PENDING rung the run could not restore), or acknowledges a crash revert; `409` when nothing is applied |
| `GET /tune/export` | `TuneExport`: the value set to type into the vendor tool, `certified` in our units and `vendorSlider` in GPU Tweak III's / Afterburner's (core the same, memory x2: their slider counts the effective rate; verified on the dev box, +4072 on the slider ↔ +2036 NVML on the 14001 ceiling ↔ 16037, NVML read 16032; the dropped-apply case +3672 ↔ 15837 held), `sliderTotal` (the whole tune to set when the hunt climbed on top of the user's vendor tune, null from stock), `vendor`, `baselineHeld`, `heldAtCertified`, `firstFailure`, `score` (the official run: points, held clocks and the telemetry summary the .html comparison sheet tabulates: GPU core / memory clock avg + max, core / hotspot / memory-junction temperature avg + max, board power avg + max and the cap, the share of samples under each limit reason, fan duty; CPU effective clock, package power, Tctl; from the flight recorder's samples of that run), `asFound` (the same for the card as found), `referencePoints` (10,000), `rungs` (the vendor rung and every climb rung with its points: the ladder as a score climb; the as-found and official runs travel as `asFound` / `score` only, since 2026-09-17 — the build before listed them among the rungs too, and the page drops them by identity), `holdsNow`, and `text`: "your tune (core +319 / memory +4072 on the slider) holds 3225 / 16008; certified +45 core / +60 memory on top → 3270 / 16068; first silent error at +60 core (stage 1)", then "11,812 points at +45 / +60: +0.9 % over your current tune (11,701), +18.1 % over a reference 5090 (10,000)", then "GPU Tweak / Afterburner: core +45, memory +120 on top of your +319 / +4072: set core +364, memory +4192", then "The card holds 3225 / 16037 now; as found 3225 / 16008" (with "re-apply in your vendor tool" when they differ by more than 1 %) and one line saying how the card was left; `404` before a result exists |
| `GET /tune/flight` | `application/x-ndjson`: the last 30 s before a hard hang (2 Hz samples of the NVML facts, the CPU package and the `/nvml/`, `/gpu-*` sensors, merged with the ladder's events), kept from `flight\current.ndjson` as `last-crash.ndjson` when a start found a crash; `404` otherwise |
| `POST /shutdown` | `202`, then a clean stop |

**Tune's revert-at-start pass** (`TuneStateMachine.AtStart`, mirrored in `src/analysis/tune.ts`): the
first thing every `--serve` start does, before a port is bound or a sensor opened, and what
`--revert-if-pending` does on its own. The state machine is IDLE → PENDING (a rung is on the
card; on disk before the apply) → IDLE; REVERTED is only the attribution shown after a crash
until the next run starts. There is no Keep, no VALIDATING, no promotion and no logon task: the
hunt's product is a value set, and the card always ends at the P0 deltas it was found with.

| File says | Action |
|---|---|
| PENDING with a rung, no `orderlyStop` | revert; REVERTED names the rung (stage 4, a hard hang); the flight file is kept as `last-crash.ndjson` |
| PENDING with a rung, `orderlyStop` set (the collector reached its exit path but the driver refused the restore) | revert quietly: IDLE, no attribution |
| PENDING without a baseline | refuse (exit 1, the reason in the log); nothing is guessed, the user's Revert acknowledges it |
| IDLE, REVERTED, PENDING without a rung | nothing |

A file that does not parse is copied aside as `tune-state.json.bad`, reported in `/tune/state`
`problem`, and treated as no state; a folder or file that anyone but administrators can write
is restricted again at every start (`AdminOnly.EnforceFolder`) and, if that fails, nothing in
the file may steer a write. The collector takes a machine-wide mutex (`Global\Strata Tune
state`) so a second elevated collector under another user session (fast user switching) is
read-only and never writes over the first's PENDING. A file the Phase 8 build wrote (KNOWN_GOOD,
VALIDATING) is read as IDLE, or as PENDING so a kept result comes off the card. Scope, as built:
the memory and core ladders on top of the card as found (or on top of the user's vendor tune,
entered once and reproduced through our route), the scored as-found and official runs, and the
vendor-slider value set; the undervolt hunt plan section 16 names first (NVML locked clocks and
power limit) is not in this version. The collector's only hardware write is `NvAPI_GPU_SetPstates20` (core and memory clock
deltas): nothing sets a power limit, locked clocks, a fan curve or a voltage.

The C# records in `StrataTune.Shared` serialise to exactly the shapes in
[src/collector-types.ts](../src/collector-types.ts); change both sides together. NVML fields
a card answers NOT_SUPPORTED for read `0` on the wire because the contract has no null there;
this box supports all of them, and the probe still prints "not supported" where a human reads it.

### Live verification of the hunt, 2026-09-17 (and what is pending)

Run `154463d9b2f1` (06:17–06:25 UTC) through the live collector on the dev box, the user's
GPU Tweak tune applied (core +319 / memory +4072 entered, cap 3 rungs per ladder):

- as found (nothing written): 12,080 points (6,797 compute + 5,283 bandwidth), held 3285 /
  16041 MHz sustained, 3337 at the top of the curve, 3889.04 Gsteps/s, 1518 GB/s (2 repeats,
  0.1 % spread), power-capped 98 % of the sustained samples;
- the cross-check passed (16041 − 14001 = 2040 against +2036 entered) and the vendor rung
  wrote P0 +319 / +2036: held 3255 / 16037, top 3322, 12,077 points (reproduced within the
  60 / 120 MHz rule);
- memory ladder: +15 → 16052 held, 12,116 points (additivity: 16052 against 16041); +30 →
  16067, 12,070; +45 → 16082, 12,536 (the stream pass read 1661 GB/s, its scatter); cap
  reached, certified +45 memory on top;
- core ladder: +15 (P0 +334) → top 3337, held 3270 / 16037, 3927.12 Gsteps/s, 12,661 points,
  every hash matched — and the build then running judged it against the as-found 3337 and
  ended the run on the additivity sentence (a boost bin between the two routes and a warmer
  card, not a driver that failed to add: the fixes above, `ClimbFrom` and the two-rung
  decision, come from this run and from `bb09b0a0455c`, a core-only run at 06:42 that read
  3337 against 3330 as found);
- restore: `applied core 319000 / memory 2036000 kHz; driver reads back the same`, holds-now
  10 s sustained 3292 / 16037 against 3285 / 16041 as found ("the same"); afterwards a heavy
  load held 3232 / 16037 at 600 W and a light load 16037, NVAPI P0 +319 / +2036 (the vendor
  value, never 0), no logon task in `schtasks`, no worker, bench or ETW session left;
- export text: "your tune (core +319 / memory +4072 on the slider) holds 3285 / 16041;
  certified +0 core / +45 memory on top → 3285 / 16082" / "12,080 points as found: +20.8 %
  over a reference 5090 (10,000)" / "GPU Tweak / Afterburner: core +0, memory +90 on top of
  your +319 / +4072: set core +319, memory +4162" / "The card holds 3292 / 16037 now; as found
  3285 / 16041."

**Keep-awake (plan section 17c).** `KeepAwake` holds `SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)` on one background thread from a hunt's or a load run's start to its finally (stop, failure and the shutdown's abort all pass through it), never `ES_DISPLAY_REQUIRED`; the main process holds Electron's `powerSaveBlocker('prevent-app-suspension')` while a capture runs or saves (electron/keepAwake.ts). Tested from the sources (tests/keep-awake.test.ts).

**Pending (the collector on the box is the 23:55 build; the sources since carry `ClimbFrom`,
`JudgeAdditivity`, the cross-check line and the rung list without the scored runs, compiled
and unit-tested, not run live):** a core ladder that climbs past its first rung, the official
two-minute run and its score line ("+x % over your current tune"), the step-down after an
official failure, a stage 1–3 failure and the bisect, the driver's refusal paths
(`foreign-tune` without a value, `vendor-mismatch`), and a hunt from stock. Note that the
card now holds the tune through our route (P0 +319 / +2036): the next hunt finds nothing
foreign, uses those deltas as the baseline and keeps an entered vendor value for the export.

**Pending since 2026-09-17 02:00 (compiled and unit-tested against tonight's numbers, not run live; verify with the user present):** the top-of-table verdict on the core ladder (3337 → 3337 at +15 and +30: expect `top-of-table`, run `done`, certified +0 core, or "additivity shown on the cap" when the sustained throughput rises the ~1 % it did in 154463d9b2f1), the "never test above" caps (`coreCapMhz` 3300 on this box should end the core ladder with `user-cap` before the first rung, since the top of the curve as found is 3337), the consecutive-rung movement guard, the dropped certification on an additivity stop, the bandwidth re-measure at the baseline when the stream pass flips mode (watch for `re-measuring the bus at the baseline` and the `stream pass: N passes, lo..hi GB/s, buffer 1024 MiB, SM clock X MHz at the end` log lines, which are the evidence for the mode's cause), the stops in `/tune/export` `text`, and the keep-awake hold (`powercfg /requests` should list the collector under SYSTEM while a hunt runs).

### strata-tune-worker.exe (inherits the caller's token)

| Verb | What it does |
|---|---|
| `--devices` | Lists every DXGI adapter with LUID, hardware/WARP, dedicated memory, compute units, wavefront size. |
| `--hash [--adapter LUID] [--elements N] [--rounds R] [--seed S] [--expect HEX] [--heartbeat PATH]` | Runs the uint-only lowbias32 kernel over N slots for R rounds, folds the result with FNV-1a 64 and prints `hash`, `dispatches`, `elapsed`, `throughput` and `mix`. Defaults: 16,777,216 elements, 256 rounds, seed `0x53545241`. Numbers accept decimal or `0x` hex so printed values paste back. |
| `--load light\|heavy --seconds N [--adapter LUID] [--heartbeat PATH]` | The same kernel run for its heat, timing-only. `light` is one 64 K-slot dispatch every ~50 ms (a few percent of a discrete card); `heavy` is back-to-back full-width dispatches with no sleep, each sized from the one before it towards 40 ms and halved past 120 ms, so it stays far under the 2 s TDR budget on any adapter. Stops at N seconds, exit 0. |
| `--cpu-load --seconds N [--threads T] [--heartbeat PATH]` | A vector FMA load on the CPU: the logistic map `x = r·x·(1 − x)` over eight independent float vectors per thread (AVX-512 where the box has it, else AVX2 FMA, else scalar), one thread per logical CPU (or T), below normal priority so the collector's sampling keeps its 2 Hz, no memory traffic and no GPU: the audit's CPU thermal, all-core clock and package-power rules read the sensors while it runs. A scalar integer chain drew 138 W on the 230 W dev box and told those rules nothing; this pulls the package to its limit the way a renderer would. Prints `elapsed`, `steps` (lane-iterations) and the folded `mix`; exit 0. |
| `--bench [--json] [--seconds N] [--adapter LUID] [--heartbeat PATH]` | The measured rows of the advisor's AI stats card (plan §10; §16 stage 2 reuses the bandwidth half read-only), all timing-only. A uint4 stream copy between two 1 GiB buffers (512 MiB each when the pair does not fit; `bufferBytes` says which) filled with random bytes, run for N seconds (default 3) in ~20 ms passes of whole-buffer sweeps under one fence with a barrier between sweeps, read and write bytes both counted, reported as the best pass and the median in GB/s. Then a group-shared tiled fp32 matmul, C = A×B at 4096, the whole product repeated under one fence to ~100 ms runs and dispatches sized from a timed row block, median of 5 as TFLOPS = 2·N³/s, four cells checked against a CPU reference; and the same product with A and B stored as packed halves (`fp16storage`: 16-bit storage, float arithmetic — cs_6_0 has no 16-bit math, so it is not a tensor-core figure). `--json` prints exactly one line on stdout and nothing else: `{ device, luid, bufferBytes, bandwidthGBs, bandwidthMedianGBs, matmulN, matmulTflopsFp32, matmulTflopsFp16storage, elapsedMs }`. On this box the 5090 reads 1600–1620 GB/s best, ~1460 median (spec 1792), 53 TFLOPS fp32 and 59 fp16storage (half the peak 105: the kernel is bound by group-shared bandwidth, not FMA issue); the Radeon iGPU 75 GB/s and 0.42 TFLOPS. |
| `--reference [--json] [--adapter LUID] [--heartbeat PATH]` | The tune ladder's stage-1 baseline (plan §16): the hash kernel at one fixed configuration (1,048,576 slots, 1024 rounds, seed `0x53545241`, constants in `Reference.cs`) at the current clocks, run twice; exit 2 if the two passes disagree, because a card that cannot repeat its own baseline has no reference. The supervisor runs it at stock before any offset and hands the hash back as `--expect`. `--json` prints one line: `{ device, luid, elements, rounds, seed, hash, elapsedMs }`. Same fold as `--hash --elements 1048576 --rounds 1024`. On the 5090: `bbcc4652a31654c5`, ~1.3 ms of GPU per pass plus the CPU fold of 4 MiB. |
| `--ladder --pattern variable\|sustained --seconds N --expect HEX [--adapter LUID] [--heartbeat PATH]` | One half of a ladder rung, stages 1 and 2 (plan §16, 'a rung is a minute of realistic load'): the pattern for N seconds with the reference pass verified against `--expect` at its cadence. `sustained` is `--load heavy`'s sized dispatches, each followed by a pass, and ends with the bench's 1 GiB stream pass for 1 s, reporting the median (the number that repeats): the throughput and the bandwidth that score the rung. `variable` is bursts of heavy dispatches 0.5–1.5 s long starting 2–4 s apart, a pass after each dispatch, with a gap of light dispatches (one per 50 ms) or idle between them and a pass at the gap's end (the low-voltage points of the VF curve are the fragile ones, and the first dispatch after an idle gap runs while the clocks and the voltage are still climbing); the sequence is seeded from a fixed word so every rung, run and card gets the same shape, and it carries no bandwidth. The first mismatch ends the run (`hash mismatch at pass P of <pattern> after T s: got X, expected Y` on stderr, exit 2). The last stdout line is always JSON: `{ pattern, seconds, passes, mismatches, bandwidthGBs, bandwidthBufferBytes, dispatches, steps, busyMs, elapsedMs }`, the bandwidth fields null unless a sustained half ran to the end; `steps` / `busyMs` (lane steps computed by the load dispatches over the wall time spent inside them, the verified passes and their CPU fold excluded) is the sustained throughput, what the supervisor compares between core rungs under a power cap and scores. Every dispatch stays under the ~40 ms the loads size themselves to, so a TDR (exit 10) is real instability and never the workload. Ctrl+C at a console ends the run at the next pass with the JSON line and exit 1; the supervisor's Kill needs nothing, the process holds no state outside itself. |

Exit codes: `0` ok, `1` bad arguments or an unexpected failure (caught at top level so
Windows Error Reporting never parks a dialog on a supervised process), `2` hash differs from
`--expect` (or `--reference` could not repeat itself), `3` the selected adapter is not hardware accelerated (a silent WARP fallback is
refused so a "passing" run cannot have skipped the GPU), `10` device lost (TDR: the
`DeviceLost` event, `Win32Exception.NativeErrorCode` 0x887A0005/6/7/20, or an
`InvalidOperationException` saying the device "has been lost").

**Exit 10 is unverified.** No TDR has been induced — deliberately, because Windows
bug-checks 0x117 on the sixth GPU hang inside 60 s — so `DeviceLoss.Matches` is checked
against ComputeSharp's exception shapes by reading, not by observing one. Treat it as
untested until Phase 8 exercises it under the supervisor with the 15 s restart rate limit in
place. A device loss that fires *after* the readback still exits 0: the data was already
read, and that is deliberate.

`--adapter` takes a LUID from `--devices`; without it, `GraphicsDevice.GetDefault()` picks
the DXGI high-performance adapter. The supervisor passes the LUID of the card under test and
compares it with the printed `device … luid …` line, because on a multi-GPU box the default
is not necessarily the card being certified. `--elements` is capped at 536,870,912 (2 GiB of
uint), which is where `AllocateReadWriteBuffer` starts throwing.

`--heartbeat PATH` rewrites `<pid> <utc iso>` every 2 s from a timer thread. It proves the
process is alive and scheduled, nothing more: the main thread can be blocked on a fence
behind a hung GPU while the file keeps updating, so the supervisor must pair it with a
wall-clock budget per dispatch batch. The first write is synchronous so an unwritable path
fails the run up front; after that a failed write can never end the run (it is a timer
thread, so an escaping exception would kill the process outside `Main`'s catch), and the
run reports the last failure on stderr when it finishes. The collector's load runner passes
a temp path and gives the worker its declared seconds plus 20 s before killing it.

Determinism is an integer-only guarantee (dependencies.md, ComputeSharp): the hash kernel
stays `uint`; the load verb reuses it but is timing-only. It holds across vendors here — the
RTX 5090 and the 9950X's Radeon iGPU both return `5ed206bd4475e275` for the default run.
Work is sliced at 4,194,240 elements (65,535 groups x 64 threads) and 2^26 element-rounds
per dispatch to stay far under the 2 s TDR budget; the default run is 80 dispatches under
one fence. That per-dispatch constant is safe only because this kernel's cost per step is
known, which is why `--load heavy` sizes its dispatches from a measured one instead.

### PresentMon-2.5.1-x64.exe (vendored, not elevated)

Intel's console PresentMon, spawned by the collector as a child in Phase 4 to get one CSV
row per present on the same QPC clock as the sensors. The binary is gitignored;
`scripts/setup-tools.ps1` downloads it into `tools/presentmon/` and verifies the pinned
size and SHA-256 (idempotent: a verified copy is left alone). Invocation, session-name
rule, pipe-encoding rule, columns and exit codes (`0` ok, `1` bad args, `6` trace session
failed, `7` terminate failed) are in [tools/presentmon/README.md](../tools/presentmon/README.md).

## Elevation rule

The collector must run as administrator, and that is checked rather than assumed:

1. `WindowsPrincipal.IsInRole(Administrator)` — exit `2`, nothing is read, in both verbs.
2. `CreateFile(\\?\GLOBALROOT\Device\PawnIO)` — the probe exits `4`; the service opens the
   LibreHardwareMonitor tree *without* the CPU and motherboard readers and reports
   `pawnIo.installed: false` in `/health`, so the GPU, memory, storage, NVML and PDH streams
   still flow and nothing is served as a zero that is really a driver that did not answer.
   `PawnIo.IsInstalled` is only a registry read of the uninstall entry's `DisplayVersion`:
   it answers True from a non-elevated shell and says nothing about whether the driver is
   running (it is `StartType=Manual` on this box) or whether its SYSTEM+Administrators ACL
   lets us in. When the handle cannot be opened, LHM's `Execute()` returns a zeroed buffer
   and every CPU and board sensor reads 0 with no exception.
3. The probe also checks the tree for the signature of a driver that answered but read
   nothing — a CPU node whose every temperature is 0 on both passes — and that is exit `4`
   too. A missing super-IO node is reported but not fatal: a board LHM has no mapping for
   legitimately has none.

The UI launches the collector with `ShellExecute("runas")`, one UAC prompt per app start,
and reads the handshake file `%LOCALAPPDATA%\Strata Tune\collector.json`. The collector is a
console executable, so the launcher passes `SW_HIDE` (`Start-Process -WindowStyle Hidden`);
without it a console window appears beside the app.

**Where the collector may be installed.** Only a directory a standard user cannot write:
`%ProgramFiles%\Strata Tune\` or `%ProgramData%` with a restricted ACL — *not* the
per-user `%LOCALAPPDATA%\Programs` pattern the other Strata Electron apps use. An elevated
process loads DLLs from its own directory first, so a writable install directory turns any
UAC-approved start into a standard user's code running as administrator.
LibreHardwareMonitorLib loads `nvapi64.dll`, `atiadlxx.dll`, `nvml.dll`, `Ftd2xx.dll` and
`ControlLib.dll` by bare name, and the last two do not exist in System32, so the default
search order reaches the exe's directory, the working directory and `%PATH%` for them.
`Main` calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 |
LOAD_LIBRARY_SEARCH_APPLICATION_DIR)` first, before any library is touched, which closes the
working-directory and `%PATH%` half of that; the install location is what closes the rest.
`Nvml` additionally loads only `%SystemRoot%\System32\nvml.dll` by full path. The worker
makes no such call: every native library ComputeSharp needs is in System32, where it wins
over the working directory anyway, and the install-location rule covers the exe directory
for both. The worker runs elevated too, under the same rule, which is why the collector only
ever starts the `strata-tune-worker.exe` in its own folder (the build copies it there; publish
puts both in one folder): a `--worker` path outside that folder is refused before anything
opens, so a medium-integrity process cannot turn the UAC prompt the user clicks Yes on into
an administrator launch of an executable of its choosing.

**No logon task.** The Phase 8 build registered `Strata Tune revert-if-pending` to run this exe
elevated at every logon; this build removes it once at start (`LegacyLogonTask`, logged) and
registers nothing, because P0 deltas do not survive a boot and every collector start reverts a
pending rung itself. The state folder's ACL rule stays (`AdminOnly.EnforceFolder`): the elevated
collector applies the baseline the file names at its next start, so only administrators may write it.

The worker inherits whatever token starts it; DirectX 12 compute needs no elevation.
PresentMon runs non-elevated for members of Performance Log Users (this user is one); the
setup script reports membership and prints the `net localgroup` command to add a user.

NVML reads, PDH counters and WMI need no elevation either. v1 keeps the whole collector
elevated because LHM needs it anyway; splitting it is a later optimisation.

## Phase 0 probe outputs

**`--probe` on the dev box, 2026-09-15** (elevated, ~217 KB). The file itself is
gitignored — it is a raw dump of one machine and is regenerated with
`--probe --out docs\phase0-probe.txt`, not shipped — so the evidence for the go/no-go in
master-plan section 22 is quoted here:

- `Elevated True`, `PawnIO registered, 2.2.0.0`, `\\?\GLOBALROOT\Device\PawnIO opened`,
  QPC 10,000,000 Hz.
- 12 hardware nodes, 364 sensors (362 distinct identifiers), the two passes 734 ms apart.
- Ryzen 9 9950X: `Core (Tctl/Tdie)` 49.1 → 48.9 °C, `CCD1/CCD2 (Tdie)`, `Package` power
  53.0 → 51.6 W (non-zero on both passes; `Computer.Open()` appears to take an initial
  reading, the 600 ms gap is kept regardless), per-core `Core #n (SMU)` power and VID rows;
  no PPT/TDC/EDC, as documented.
- Nuvoton NCT6687D-R at `/lpc/nct6687dr/0` (no hyphen; the dependencies.md example spells it
  `nct6687d-r`): CPU Core / VRM MOS (34.5 °C) / CPU Socket temperatures, 13 voltages
  (+12V reads 12.216 V), fans CPU / Pump / Chipset / EZ-Connect / System #1-#6. Pump Fan #1
  reads 3053 RPM, every other header 0 at 100 % control: an AIO wiring fact, not a code issue.
- DIMM SPD sensors present (`/memory/dimm/1`, `/memory/dimm/3`, 33 °C).
- NVML: RTX 5090, driver 616.92, PCIe gen 5 x16 of gen 5 x16, BAR1 32768 MiB (Resizable BAR
  on), power limit 600000 mW, clocks-event reasons `0x400` (newer than the public header,
  shown as hex).
- PDH: `PhysicalDisk` instances `0 G:`, `1 F:`, `2 D: E: C:` (the `_Total` pseudo-instance is
  filtered out); `Process V2` instance `strata-tune-collector:<pid>`.

Settled in Phase 1:

- The repeated LHM identifiers are suffixed by the stream layer (`#n`, see the service
  section); the probe lists which ids it suffixed instead of flagging duplicates.
- One of the two identical G.Skill DIMMs returns a part-number string with trailing junk
  bytes, and which one it is changes between runs. `Printable` replaces the control
  characters in every hardware-provided name, in the probe and on the wire; the UI will want
  to trim at the first one.

**[docs/phase0-presentmon-sample.csv](../docs/phase0-presentmon-sample.csv)**: the header
plus ten rows from a non-elevated 6 s run (`--output_stdout --qpc_time`), ASCII, CRLF. The
header is byte-for-byte the 28-column string in dependencies.md; `TimeInQPC` and
`CPUStartQPC` are raw ticks on the 10 MHz QPC clock, monotonic across rows, with each
row's CPU start before its present. It was captured from `claude.exe`, an Electron window in
Hardware Composed: Independent Flip — **not** from a game, which master-plan section 22 step 3
asks for. The columns, encoding and clock are proven by it; the `--process_id` path against a
real game, and the anti-cheat behaviour dependencies.md warns about, are not.

**Worker determinism**: `--hash` with the defaults returns `5ed206bd4475e275` on the RTX 5090
in every separate process it has been run in, and the same value on the AMD iGPU via
`--adapter`; `--rounds 255`, `--rounds 512` and `--seed 1` each give a different hash, and
`--expect` with a wrong value exits 2. `--adapter` with the WARP LUID exits 3.
