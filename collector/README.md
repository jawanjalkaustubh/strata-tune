# Strata Tune collector (.NET)

The elevated sensor process and its disposable GPU worker. Versions are pinned in
[docs/dependencies.md](../docs/dependencies.md); the design is master-plan sections 4 to 7.

```
StrataTune.sln
  StrataTune.Shared/      row and wire types (SensorSample, SensorMeta, GpuFacts)
  StrataTune.Collector/   LibreHardwareMonitor + NVML + PDH; --probe today, Kestrel server in Phase 1
  StrataTune.Worker/      ComputeSharp hash kernel, heartbeat; one process per test candidate
  Directory.Build.props   net10.0, win-x64, x64, nullable, implicit usings, for all three projects
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

Shipping builds are self-contained single-file, one per exe (`scripts/build-collector.ps1`
lands with Phase 1):

```
dotnet publish <csproj> -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

`IncludeNativeLibrariesForSelfExtract` stays off: it would extract native DLLs to `%TEMP%`
at every start, which is exactly the directory an elevated process must not load from.

The ComputeSharp source generator compiles the worker's shader to DXIL at build time and
needs `AllowUnsafeBlocks` (analyzer error CMPS0052 without it); that is why the worker csproj
keeps that one property locally. `bin/` and `obj/` are gitignored.

## The three executables

### strata-tune-collector.exe (elevated)

| Verb | What it does |
|---|---|
| `--probe [--out <file>]` | One plain-text page: elevation and PawnIO state, every LHM sensor read twice 600 ms apart with min/max, the NVML facts per GPU, two PDH samples 1 s apart, a sanity block, then `computer.GetReport()` with the identifiers redacted. Phase 1 adds the server verb. |

Exit codes: `0` ok, `1` an LHM or PDH block threw (the others still print), `2` not elevated
(nothing is read), `3` NVML failed (LHM and PDH still print), `4` PawnIO cannot be used, so
the CPU and board numbers would be zeros rather than readings.

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
that are not clean text (see the carried-into-Phase-1 list below).

### strata-tune-worker.exe (inherits the caller's token)

| Verb | What it does |
|---|---|
| `--devices` | Lists every DXGI adapter with LUID, hardware/WARP, dedicated memory, compute units, wavefront size. |
| `--hash [--adapter LUID] [--elements N] [--rounds R] [--seed S] [--expect HEX] [--heartbeat PATH]` | Runs the uint-only lowbias32 kernel over N slots for R rounds, folds the result with FNV-1a 64 and prints `hash`, `dispatches`, `elapsed`, `throughput` and `mix`. Defaults: 16,777,216 elements, 256 rounds, seed `0x53545241`. Numbers accept decimal or `0x` hex so printed values paste back. |

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
run reports the last failure on stderr when it finishes.

Determinism is an integer-only guarantee (dependencies.md, ComputeSharp): the hash kernel
stays `uint`; float kernels added later are timing-only. It holds across vendors here — the
RTX 5090 and the 9950X's Radeon iGPU both return `5ed206bd4475e275` for the default run.
Work is sliced at 4,194,240 elements (65,535 groups x 64 threads) and 2^26 element-rounds
per dispatch to stay far under the 2 s TDR budget; the default run is 80 dispatches under
one fence. That per-dispatch constant is safe only because this kernel's cost per step is
known: the bandwidth and heavy kernels must size their dispatches from a timed warm-up.

### PresentMon-2.5.1-x64.exe (vendored, not elevated)

Intel's console PresentMon, spawned by the collector as a child in Phase 4 to get one CSV
row per present on the same QPC clock as the sensors. The binary is gitignored;
`scripts/setup-tools.ps1` downloads it into `tools/presentmon/` and verifies the pinned
size and SHA-256 (idempotent: a verified copy is left alone). Invocation, session-name
rule, pipe-encoding rule, columns and exit codes (`0` ok, `1` bad args, `6` trace session
failed, `7` terminate failed) are in [tools/presentmon/README.md](../tools/presentmon/README.md).

## Elevation rule

The collector must run as administrator, and that is checked rather than assumed:

1. `WindowsPrincipal.IsInRole(Administrator)` — exit `2`, nothing is read.
2. `CreateFile(\\?\GLOBALROOT\Device\PawnIO)` — exit `4`. This is the check that matters.
   `PawnIo.IsInstalled` is only a registry read of the uninstall entry's `DisplayVersion`:
   it answers True from a non-elevated shell and says nothing about whether the driver is
   running (it is `StartType=Manual` on this box) or whether its SYSTEM+Administrators ACL
   lets us in. When the handle cannot be opened, LHM's `Execute()` returns a zeroed buffer
   and every CPU and board sensor reads 0 with no exception.
3. After the read, the tree is checked for the signature of a driver that answered but read
   nothing — a CPU node whose every temperature is 0 on both passes — and that is exit `4`
   too. A missing super-IO node is reported but not fatal: a board LHM has no mapping for
   legitimately has none.

The UI launches the collector with `ShellExecute("runas")`, one UAC prompt per app start,
and reads the handshake file `%LOCALAPPDATA%\Strata Tune\collector.json` (Phase 1).

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
for both.

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
- 12 hardware nodes, 364 sensors (362 distinct ids), the two passes 734 ms apart.
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

Carried into Phase 1:

- LHM identifiers are not unique on this box: `/gpu-nvidia/0/voltage/0` (GPU Core Voltage and
  12VHPWR Pin 1) and `/gpu-nvidia/0/load/3` (GPU Bus and GPU Memory) each appear twice.
  Master plan section 6 keys streams on the identifier, so the stream layer needs a
  disambiguation rule; the probe flags duplicates and keeps the first occurrence in `Meta`.
- One of the two identical G.Skill DIMMs returns a part-number string with trailing junk
  bytes, and which one it is changes between runs. `Printable` replaces the control
  characters so nothing writes NULs into a report; the UI will want to trim at the first one.

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
