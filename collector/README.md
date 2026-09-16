# Strata Tune collector (.NET)

The elevated sensor process and its disposable GPU worker. Versions are pinned in
[docs/dependencies.md](../docs/dependencies.md); the design is master-plan sections 4 to 7.

```
StrataTune.sln
  StrataTune.Shared/      the wire contract: C# records mirroring src/collector-types.ts, one
                          source-generated System.Text.Json context (camelCase, enums as strings)
  StrataTune.Collector/   --probe (Phase 0 report) and --serve (Kestrel on loopback: LHM + NVML + PDH
                          samplers, ring buffer, SSE, snapshot, hogs, load runs)
  StrataTune.Worker/      ComputeSharp kernels: --hash (deterministic), --load (timed heat), heartbeat
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
| `GET /stream` | `text/event-stream`, one `event: tick` with a `Tick` every 500 ms, a `: keep-alive` comment every 10 s; one loop per client |
| `GET /hogs?seconds=N&excludePid=P` (also `/procs/hogs`) | `HogsResult`, N in 2..15: every process's CPU time and working set at the start and end of the window; CPU is percent of all logical CPUs; the collector's tree (the worker is its child), P's tree (the UI) and the kernel-backed pseudo-processes (System, Memory Compression, Registry, Secure System) are excluded, because none of them is a program the user could close |
| `POST /load` `{ kind, seconds }` | `LoadRun` with `state: running`; `409` while one runs, `400` for a bad request. Starts the worker with `--load <kind> --seconds N --heartbeat <temp file>` and samples GPU 0 at 2 Hz until it exits |
| `GET /load/{id}` | the `LoadRun`: `done` with exit 0, else `failed` with the worker's exit code (3 no hardware GPU, 10 device lost) and its stderr; the last eight runs are kept |
| `POST /shutdown` | `202`, then a clean stop |

The C# records in `StrataTune.Shared` serialise to exactly the shapes in
[src/collector-types.ts](../src/collector-types.ts); change both sides together. NVML fields
a card answers NOT_SUPPORTED for read `0` on the wire because the contract has no null there;
this box supports all of them, and the probe still prints "not supported" where a human reads it.

### strata-tune-worker.exe (inherits the caller's token)

| Verb | What it does |
|---|---|
| `--devices` | Lists every DXGI adapter with LUID, hardware/WARP, dedicated memory, compute units, wavefront size. |
| `--hash [--adapter LUID] [--elements N] [--rounds R] [--seed S] [--expect HEX] [--heartbeat PATH]` | Runs the uint-only lowbias32 kernel over N slots for R rounds, folds the result with FNV-1a 64 and prints `hash`, `dispatches`, `elapsed`, `throughput` and `mix`. Defaults: 16,777,216 elements, 256 rounds, seed `0x53545241`. Numbers accept decimal or `0x` hex so printed values paste back. |
| `--load light\|heavy --seconds N [--adapter LUID] [--heartbeat PATH]` | The same kernel run for its heat, timing-only. `light` is one 64 K-slot dispatch every ~50 ms (a few percent of a discrete card); `heavy` is back-to-back full-width dispatches with no sleep, each sized from the one before it towards 40 ms and halved past 120 ms, so it stays far under the 2 s TDR budget on any adapter. Stops at N seconds, exit 0. |

Exit codes: `0` ok, `1` bad arguments or an unexpected failure (caught at top level so
Windows Error Reporting never parks a dialog on a supervised process), `2` hash differs from
`--expect`, `3` the selected adapter is not hardware accelerated (a silent WARP fallback is
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
