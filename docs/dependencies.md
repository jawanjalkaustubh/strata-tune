# Dependencies — pinned versions and verified facts (Phase 0, 2026-09-15)

Every fact here was fetched from a primary source and then independently re-checked
against it. Where the master plan assumed something different, the plan is corrected in
its own text and the reason is here.

## Dev box

RTX 5090 32 GB, driver 616.92 (NVML 13.x, `C:\Windows\System32\nvml.dll` 1,499,368 bytes),
Ryzen 9 9950X (32 logical CPUs), MSI MAG X870E TOMAHAWK WIFI (MS-7E59) BIOS 2.A60, Windows 11
26200 with HVCI running, **PawnIO 2.2.0 installed and running**, user in Performance Log Users,
.NET SDK **10.0.401** (runtime + ASP.NET Core 10.0.12), Node 24, Python 3.11.

## LibreHardwareMonitorLib 0.9.6 (NuGet, MPL-2.0)

- 0.9.5 (2026-01-07) swapped WinRing0 for PawnIO and moved the PawnIO client into the library
  (raw `DeviceIoControl`, no `PawnIOLib.dll`). **0.9.6 (2026-02-14)** opens
  `\\?\GLOBALROOT\Device\PawnIO`, which PawnIO 2.1.0+ requires; 2.2.0 provides both paths.
  0.9.6 + 2.2.0 is the right pair. Everything newer is `0.9.7-preNNN` (auto-published from
  master; the "nightly"). Not for shipping.
- Package layout is `ref/` + `runtimes/win-x64/lib/`: set `<RuntimeIdentifier>win-x64</RuntimeIdentifier>`.
  Targets net472, netstandard2.0, net8.0, net9.0, **net10.0**.
- **Admin is mandatory.** PawnIO's device ACL is SYSTEM + Administrators. When the handle
  cannot be opened, `PawnIo.Execute()` silently returns zeros — CPU temp 0, package power 0,
  no super-IO chip, no exception. Check `LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled`,
  `WindowsPrincipal.IsInRole(Administrator)` and `computer.GetReport()` before trusting values.
- `Computer { IsCpuEnabled, IsMotherboardEnabled, IsGpuEnabled, IsMemoryEnabled, IsStorageEnabled }`
  → `Open()` → per poll `Accept(UpdateVisitor)` (or `hw.Update()` + sub-hardware) → `Close()`.
  Sensor identity is `ISensor.Identifier` (e.g. `/amdcpu/0/power/0`, `/lpc/nct6687dr/0/fan/1`),
  never `Name` (user-renamable). **Identifiers are not unique**: on this box the 5090 emits `/gpu-nvidia/0/voltage/0` twice (GPU Core Voltage and 12VHPWR Pin 1) and `/gpu-nvidia/0/load/3` twice (GPU Bus and GPU Memory) — the stream layer suffixes the ordinal within the parent hardware. The super-IO id is `/lpc/nct6687dr/0` (no hyphen).
- What a 9950X reports: `Core (Tctl/Tdie)`, `CCD1/CCD2 (Tdie)`, per-core clocks, and **`Package`
  power = delta of MSR `C001_029B` energy accumulator (RAPL-style)**. It is *not* SVI3: LHM
  disables SVI readout for models 0x61/0x44 and has no SMU PM-table layout for Zen 5, so there
  is no core/SoC voltage or current, no PPT/TDC/EDC. Package power needs two samples ≥ 500 ms
  apart (first is 0/NaN); very fast polling (~100 ms) has produced nulls. **Plan §13 corrected.**
- Board mapping exists for the exact SMBIOS string `MAG X870E TOMAHAWK WIFI (MS-7E59)` →
  Nuvoton NCT6687D-R: temps CPU Core / System / VRM MOS / Chipset / CPU Socket, fans CPU / Pump /
  Chipset / EZ-Connect / System #1–#6, 13 voltages. Fan *control* on SYS_FAN headers is broken in
  0.9.6 (issue #2292, fixed in master) — irrelevant, this app never controls fans.
- Global mutexes `Global\Access_ISABUS.HTP.Method` / `Global\Access_PCI` are shared with HWiNFO,
  MSI Center, Fan Control. Two LHM-based apps polling at once is fine; poll ≥ 500 ms.
- MPL-2.0 is file-level copyleft: using the unmodified library from an MIT app is fine; ship
  the notice. If the library is ever modified, those files stay MPL.

## PresentMon 2.5.1 (Intel, MIT)

- Asset: `https://github.com/GameTechDev/PresentMon/releases/download/v2.5.1/PresentMon-2.5.1-x64.exe`,
  **956,768 bytes**, SHA-256 `9BEC3083069F58F911E6A512F4806DB51A27BD096103087BC1D05EF54C80A191`
  (from the winget manifest; `scripts/setup-tools.ps1` verifies after download). x64 only.
  Do not pin 2.5.0 (withdrawn 2026-06-29). Not the 157 MB MSI (service + GUI).
- Invocation: `PresentMon-2.5.1-x64.exe --process_id <pid> --output_stdout --qpc_time
  --stop_existing_session --terminate_on_proc_exit --session_name StrataTune`
  `--session_name` matters: the default session name is `PresentMon` and
  `--stop_existing_session` would kill CapFrameX/RTSS sessions of that name.
- Default CSV header (28 columns):
  `Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,TimeInQPC,MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed,CPUStartQPC,MsBetweenAppStart,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsAnimationError,AnimationTime,MsFlipDelay,MsAllInputToPhotonLatency,MsClickToPhotonLatency`
  Parse by header name, never by index (the README's column table is stale). `TimeInQPC` and
  `CPUStartQPC` are raw QPC ticks on the same clock as `Stopwatch.GetTimestamp()`. Optional
  columns print `NA` — nullable. `MsBetweenPresents` is the classic frame time;
  `MsBetweenAppStart = MsCPUBusy + MsCPUWait` is the v2 frame time.
- **Stdout to a pipe is narrow (ANSI) text with CRLF**; a console/file gets UTF-16. Read the
  child's stdout as ASCII/Latin-1, not UTF-8.
- Exit codes: 0 ok, 1 bad args, 6 failed to start trace session (not admin and not in
  Performance Log Users, or an anti-cheat blocked `StartTraceW`), 7 terminate-session failed.
- Non-admin works for members of Performance Log Users (this user is one). Without admin,
  other accounts' or elevated games' processes show as `<unknown>` — prefer `--process_id`.
- `--terminate_on_proc_exit` only fires once the target has been seen presenting; pair it with
  our own wait on the process handle and a kill fallback.
- ETW-only, no injection/overlay/driver. Known: EA's anti-cheat (issue #573) makes
  `StartTraceW` fail with ACCESS_DENIED once the game runs — start PresentMon *before* the game.
- GPU metrics read ~0.5 ms high with Hardware-Accelerated GPU Scheduling on (README).

## ComputeSharp 3.2.0 (NuGet, MIT)

- Single `<PackageReference Include="ComputeSharp" Version="3.2.0" />`; only a `net8.0`
  assembly, consumed by net10.0 via compatibility. Source generator is bundled (43 MB analyzer,
  embeds DXC; shaders compile to DXIL cs_6_0 at build time). Needs .NET SDK ≥ 8.0.200.
- **`<AllowUnsafeBlocks>true</AllowUnsafeBlocks>` is required** — analyzer error CMPS0052
  otherwise (the research missed this; the verifier caught it).
- Shader: `public readonly partial struct HashKernel : IComputeShader` with
  `[ThreadGroupSize(DefaultThreadGroupSizes.X)]` and `[GeneratedComputeShaderDescriptor]`;
  `device.For(n, shader)` or `ComputeContext` for many dispatches under one fence.
- `GraphicsDevice.GetDefault()` picks the DXGI high-performance adapter and **silently falls
  back to WARP** — the worker must check `IsHardwareAccelerated` and exit with a distinct
  code, else a "passing" run may never have touched the GPU. Log `Luid`.
- **Determinism holds for integer arithmetic only.** Float kernels are fast-math; keep the
  hash-verified kernel `uint`-only; treat bandwidth/heavy kernels as timing-only.
- TDR: does not throw where the hang happened; the fence wait returns and the next API call
  throws `Win32Exception` with `NativeErrorCode` 0x887A0005/6/7/20 (DEVICE_REMOVED/HUNG/RESET)
  or `InvalidOperationException` containing "has been lost"; also `GraphicsDevice.DeviceLost`
  event. `Win32Exception.HResult` is always E_FAIL — read `NativeErrorCode`.
- **Windows bug-checks (0x117) on the 6th GPU hang within 60 s.** The supervisor must
  rate-limit worker restarts (≥ 15 s apart) and never disable the GPU timeout unattended.
  Default TDR budget 2 s per dispatch: split heavy work into many dispatches, sized by
  measured throughput, not fixed iteration counts.

## .NET 10 collector pieces

- `global.json` pins SDK 10.0.401 with `rollForward: latestPatch`.
- Kestrel: `Microsoft.NET.Sdk.Web` (or `FrameworkReference Microsoft.AspNetCore.App`);
  `app.Run("http://127.0.0.1:<port>")`. Single-file: `Assembly.Location` is empty — use
  `AppContext.BaseDirectory` / `Environment.ProcessPath`.
- Publish: `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true`.
  Runtime packs are restored from nuget.org the first time. **Licence:** the self-contained exe
  embeds coreclr under the *Microsoft .NET Library License* (redistribution as part of the app
  is permitted; it is not MIT — nuget.org's "MIT" on the win-x64 runtime packs is wrong
  metadata, dotnet/runtime #108905). Say so in THIRD-PARTY-NOTICES.md.
- PDH: package `System.Diagnostics.PerformanceCounter` 10.0.12. On Windows 11 use category
  `Process V2` (instances `<exe>:<pid>`, no `#1` ambiguity), counter `% Processor Time`
  (0..100 × ProcessorCount — divide by 32 here). `PhysicalDisk` / `Current Disk Queue Length`
  instances are `0 G:`, `1 F:`, `2 D: E: C:` — enumerate with
  `PerformanceCounterCategory.GetInstanceNames()`. Rate counters return 0 on the first
  `NextValue()`; keep instances alive and sample ≥ 1 s apart. Readable non-elevated.
- NVML: **no usable NuGet wrapper** (`NVIDIA.NVML`, `ManagedCuda-NVML` do not exist;
  `ManagedCuda-Nvml.NETStandard` is from 2018; `NvAPIWrapper` is NVAPI and LGPL). Hand-written
  P/Invoke against `nvml.dll` (System32, Cdecl, `nvmlDevice_t` = `IntPtr`):
  `nvmlInit_v2`, `nvmlShutdown`, `nvmlSystemGetDriverVersion(char*, 80)`,
  `nvmlDeviceGetCount_v2`, `nvmlDeviceGetHandleByIndex_v2`, `nvmlDeviceGetName(…, 96)`,
  `nvmlDeviceGetCurrentClocksEventReasons(ulong*)` (exists on 616.92; fall back to
  `nvmlDeviceGetCurrentClocksThrottleReasons` via `NativeLibrary.TryGetExport` — same bitmask),
  `nvmlDeviceGetCurrPcieLinkGeneration/Width`, `nvmlDeviceGetMaxPcieLinkGeneration/Width`,
  `nvmlDeviceGetGpuMaxPcieLinkGeneration`, `nvmlDeviceGetBAR1MemoryInfo(nvmlBAR1Memory_t*)`,
  `nvmlDeviceGetPowerUsage(uint* mW)`, `nvmlDeviceGetPowerManagementLimit(uint* mW)`,
  `nvmlDeviceGetClockInfo(type, uint* MHz)` (GRAPHICS 0, SM 1, MEM 2),
  `nvmlDeviceGetTemperature(0, uint*)`, `nvmlDeviceGetMemoryInfo` (v1; be consistent),
  `nvmlDeviceGetUtilizationRates(nvmlUtilization_t*)`. Non-zero return = failure;
  `nvmlErrorString`. The nvml.h notice asks that its disclaimer be reproduced where its
  prototypes are transcribed — the P/Invoke file carries it.
- Clocks-event-reason bits (NVML): GpuIdle 0x1, ApplicationsClocksSetting 0x2, SwPowerCap 0x4,
  HwSlowdown 0x8, SyncBoost 0x10, SwThermalSlowdown 0x20, HwThermalSlowdown 0x40,
  HwPowerBrakeSlowdown 0x80, DisplayClockSetting 0x100. This box shows 0x400 at idle **and under light load**,
  and it disappears under heavy load (599/600 W → 0x4 SwPowerCap only), on driver 616.92 — so it
  behaves like an idle/low-utilisation indicator on Blackwell; newer than the public header. Decode
  known bits, show unknown as hex, and treat 0x400-only as "not loaded" for validity gates.
- Measured on the dev box: heavy worker load holds SM 3210–3225 MHz at 599 W / 51 °C with
  SwPowerCap set; a light (50 ms-dispatch) load bounces 1717–2812 MHz at 28 °C — clock drops
  under light load are the boost governor, not throttling.
- AM5 VSOC: AMD's AGESA cap is **1.30 V**; EXPO 6000+ kits run 1.25–1.30 V by design. Rails
  need real nominal/limit tables (this box: SoC 1.304 V = at the cap, not a fault).

## Licence summary for THIRD-PARTY-NOTICES.md

| Component | Licence | Shipped how |
|---|---|---|
| LibreHardwareMonitorLib 0.9.6 | MPL-2.0 | NuGet, unmodified, in the collector |
| ↳ BlackSharp.Core 1.0.7, DiskInfoToolkit 1.1.2, RAMSPDToolkit-NDD 1.4.2 (LHM transitive) | MPL-2.0 | shipped unmodified with the collector |
| ↳ HidSharp 2.6.4 (LHM transitive) | Apache-2.0 | shipped with the collector; NOTICE text reproduced |
| ↳ Mono.Posix.NETStandard, System.Management, System.IO.Ports (LHM transitive) | MIT | shipped with the collector |
| PawnIO 2.2.0 | separate installer (namazso) | not redistributed; setup links to pawnio.eu |
| PresentMon 2.5.1 | MIT (Copyright 2017-2024 Intel) | exe downloaded by setup script, not committed |
| ComputeSharp 3.2.0 | MIT | NuGet, in the worker |
| System.Diagnostics.PerformanceCounter 10.0.12 | MIT | NuGet |
| .NET runtime (self-contained) | MIT + Microsoft .NET Library License for coreclr | embedded in the published exe |
| nvml.h prototypes | NVIDIA notice (royalty-free; reproduce disclaimer) | transcribed into Nvml.cs |
