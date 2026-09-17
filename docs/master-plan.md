# Strata Tune — Master Plan (v1, 2026-09-15)

PC tuning and diagnostics app. Fifth member of the Strata family (Code, Photo, Video,
Snap/Remote). Standalone project at `D:\AntiGravity\strata-tune`.

**Hardware (verified 2026-09-15 on the dev box):** RTX 5090 32 GB (driver 616.92, PCIe
Gen5 x16, ReBAR on, power limit 600 W = max, no headroom), Ryzen 9 9950X, 2×16 GB G.Skill
F5-6000J2836G16G in A2/B2 running at 6200 MT/s, three NVMe SSDs, Windows 11 26200,
Balanced power plan. The user is already in the Performance Log Users group.

**Cost model:** free, no telemetry, no accounts, no cloud calls. Donations via `support.json`
like Strata Photo. **Public repo** (the distribution model is people posting reports and
share cards; that only works if the project is visible).

The original idea document is kept verbatim at [spec-original.md](spec-original.md). This
plan is the engineering version of it: same five capabilities, same build order, with the
data sources and process model pinned down against this machine. Where the plan departs from
the spec, Appendix A says why.

---

# Part I — Foundations

## 1. Assumptions

| # | Assumption |
|---|---|
| A1 | Windows 11 only. NVIDIA first; AMD/Intel GPUs get the read-only paths (sensors, audit) and no OC. |
| A2 | Everything the user sees is interpreted: a verdict, a cost, a fix. Raw data exists but is behind a button. |
| A3 | Collection is dumb and cheap; analysis runs after capture. The tool must never be the stutter. |
| A4 | One clock. Every sample carries a `QueryPerformanceCounter` timestamp. |
| A5 | The UI never touches hardware. A separate elevated collector does, over localhost. Same shape as Strata Photo's Python sidecar, but .NET, because the libraries that matter are .NET. |
| A6 | The app runs with GPU acceleration disabled, always. It is a dashboard; there is nothing on screen that needs a GPU, and this is the only way to be sure the monitor does not perturb a stress test. |
| A7 | Nothing writes to hardware until Phase 8. Phases 1–7 cannot damage a machine and are a complete product. |
| A8 | The score measures potential realised, not speed. A well-configured 4060 can beat a misconfigured 5090. |
| A9 | Model tables, PSU curves and expected-value cohorts ship as editable JSON in the repo. No server, ever. |
| A10 | GPU co-tenancy with Strata Code / Photo / Video follows the existing `gpu.lock` convention (§20). Stress tests take the lock; passive monitoring never does. |
| A11 | Anti-cheat: PresentMon is ETW-only (no injection, no overlay). Test against one live anti-cheat title in Phase 5 before building on top. |
| A12 | **Lightweight on every machine** (user, 2026-09-16): the app must run well on laptops and modest PCs, not just the dev box. §17c sets the budget; every phase is measured against it before its PR. |

## 2. Goals, ranked

1. Tell someone, in five ranked lines, what is wrong with their PC and what it costs them
2. Explain each stutter — including "nothing on your end fixes this"
3. Answer "what local AI models can this machine run, and how fast"
4. Give an honest whole-system power number, every figure tagged measured or estimated
5. Find a stable undervolt automatically, with rollback that cannot brick a boot

## 3. Non-goals

- Raw-speed benchmarking or a leaderboard (3DMark and Cinebench own that)
- Overlay / in-game HUD (that is RTSS; it also trips anti-cheat)
- Writing a kernel driver. Ever.
- CPU or RAM overclocking from software. Detect, quantify, guide to BIOS.
- Fan control (Fan Control exists and is excellent)
- Mobile clients, cloud sync, accounts

---

# Part II — Architecture

## 4. System shape

```
┌──────────────────────────────────────────────────────┐
│  Strata Tune — Electron 34 + React 18 + TS + Tailwind │  non-elevated
│  GPU acceleration OFF (app.disableHardwareAcceleration)│
│  ┌─────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │ Audit   │ │ Live   │ │ Capture│ │ AI    │ │ Tune │ │
│  │ (5 fixes│ │ monitor│ │ +report│ │ advisor│ │ (OC) │ │
│  └─────────┘ └────────┘ └────────┘ └───────┘ └──────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Analysis (TS): classifier · power model · score  │ │
│  │ Same code renders the in-app view and the HTML   │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP + SSE, 127.0.0.1:<dynamic>, token
                           ▼
┌──────────────────────────────────────────────────────┐
│  strata-tune-collector.exe  (.NET, elevated, own PID) │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │ LibreHardware│ │ NVML         │ │ PDH counters  │ │
│  │ MonitorLib   │ │ (nvml.dll)   │ │ disk queue,   │ │
│  │ CPU/board/   │ │ clocks, W,   │ │ per-proc CPU, │ │
│  │ fans/SSD @10Hz│ │ throttle bits│ │ page faults   │ │
│  └──────────────┘ └──────────────┘ └───────────────┘ │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │ PresentMon   │ │ Static       │ │ Ring buffer   │ │
│  │ child proc,  │ │ snapshot     │ │ QPC-stamped,  │ │
│  │ CSV stdout,  │ │ WMI/powercfg/│ │ 10 min full + │ │
│  │ --qpc_time   │ │ SMBIOS       │ │ 1 Hz summary  │ │
│  └──────────────┘ └──────────────┘ └───────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Tune supervisor: state machine, watchdog,        │ │
│  │ flight recorder, NVAPI writes (Phase 8 only)     │ │
│  └───────────────────────┬──────────────────────────┘ │
└──────────────────────────┼───────────────────────────┘
                           │ spawn, heartbeat file every 2 s
                           ▼
              ┌────────────────────────────┐
              │ strata-tune-worker.exe     │  disposable
              │ ComputeSharp (DX12 compute)│
              │ hash kernel · bandwidth    │
              │ sweep · heavy/light/burst  │
              └────────────────────────────┘
```

**Why a .NET collector and not Python.** LibreHardwareMonitor is a .NET library. That is the
whole reason. NVML, PDH and WMI are all one P/Invoke or one NuGet away in C#. A Python
sidecar would wrap LHM through a .NET bridge and lose the one thing the sidecar exists for.
Publish it self-contained single-file (`dotnet publish -r win-x64 --self-contained
-p:PublishSingleFile=true`) so users do not install a runtime.

**Why NVML for reads, not NVAPI.** NVML (`nvml.dll`, ships with every driver) exposes clocks,
power, temperatures, PCIe gen/width, BAR1 size, VRAM, utilisation and — the highlight of
the spec — `nvmlDeviceGetCurrentClocksEventReasons`, the perf-limit bitmask. All of it
without admin and without a driver. NVAPI is kept for the one thing NVML cannot do:
write a VF curve offset (Phase 8). Verified on this box: `nvidia-smi
--query-gpu=clocks_event_reasons.*` returns the same bits.

**Why PresentMon as a child process, not the SDK.** `PresentMon.exe --output_stdout
--qpc_time --process_id <pid>` streams one CSV row per present with `CPUBusy`, `CPUWait`,
`GPUBusy`, `GPUWait`, `GPULatency`, `DisplayedTime` — every column the classifier needs,
timestamped on the same QPC clock as our sensors. No native binding to maintain, and the
PresentMon SDK's own service is not needed. Pin a version and vendor the exe under
`tools/presentmon/` (MIT).

**Why ComputeSharp for the worker.** The stress/hash kernel must be deterministic and
vendor-neutral. ComputeSharp compiles C# to DX12 compute shaders; no CUDA toolkit, works on
AMD later. The worker is a second .NET exe so that when it TDRs, the collector lives.

## 5. Process model and elevation

Three processes, three trust levels:

| Process | Elevated | Lifetime | Owns |
|---|---|---|---|
| Electron UI | no | user session | rendering, analysis, reports |
| Collector | **yes** | started by UI, exits with it | sensors, ETW, ring buffer, tune supervisor |
| Worker | inherits | one per test candidate | the GPU |

Elevation flow: the UI launches the collector with `ShellExecute("runas")`, one UAC prompt
per app start. An elevated child cannot pipe stdout to a non-elevated parent, so the
handshake is a file: the collector writes `%LOCALAPPDATA%\Strata Tune\collector.json`
`{ port, token, pid, startedAt }` and the UI polls for it (timeout 15 s). Every HTTP call
carries the token. The collector exits when the UI's PID disappears.

What needs admin and what does not, on this machine:

| Need | Admin? | Note |
|---|---|---|
| LHM sensors (CPU package power, VRM, board temps, fans) | **yes** | Needs the **PawnIO** driver. WinRing0 is on Microsoft's vulnerable-driver blocklist and is blocked by HVCI on fresh Windows 11 installs; recent LibreHardwareMonitor builds use PawnIO instead. Ship a one-time "install PawnIO" step in setup (signed, separate installer). Verify the exact LHM version/PawnIO pairing in Phase 0. |
| PresentMon ETW session | no, **if** the user is in Performance Log Users | This user already is. Setup offers to add the user to the group (that part needs admin once) so the ETW path is unelevated in future. |
| NVML reads | no | |
| NVML/NVAPI writes (power limit, clocks) | yes | Phase 8 only |
| PDH counters, WMI, powercfg | no | |

Because LHM needs admin anyway, v1 keeps the whole collector elevated. Splitting it in two
is a later optimisation, not a design change.

**Install-location rule.** LHM loads `nvapi64.dll`, `nvml.dll`, `Ftd2xx.dll` and `ControlLib.dll`
by bare name. The collector calls `SetDefaultDllDirectories(SYSTEM32 | APPLICATION_DIR)` so the
working directory and `%PATH%` are out of the search, and the *exe directory* half is closed by
installing the collector only where non-admins cannot write (Program Files / ProgramData with a
restricted ACL) — an elevated process must never load a DLL from a user-writable folder.

## 6. Data layer

**One clock.** `Stopwatch.GetTimestamp()` in .NET is QPC. PresentMon `--qpc_time` emits
raw QPC. Sensor samples are stamped at read time. Nothing uses `DateTime.Now` except the
session header.

**Streams.** Each stream is an append-only array of fixed-shape rows:

| Stream | Rate | Row |
|---|---|---|
| `sensors` | 10 Hz (LHM + NVML) | one float per subscribed sensor id |
| `frames` | per present | PresentMon row, PID-filtered |
| `procs` | 1 Hz | top-8 CPU consumers by PID, page faults/s |
| `disk` | 10 Hz | queue depth, read/write bytes per physical disk |
| `events` | sparse | throttle-bit changes, TDR (Event ID 4101), game start/stop, user marks |
| `snapshot` | once | static config (§8 inputs), hardware tree |

**Ring buffer sized by time.** 10 minutes at full rate in RAM. Older data is folded into
1 Hz summary rows (min/max/mean per sensor, stutter count per second) so a two-hour
session still fits. A session is "stopped" by the user or by game exit; then the buffer is
written to `%LOCALAPPDATA%\Strata Tune\sessions\<date>-<game>.stsession` — a folder of
gzipped newline-JSON, one file per stream, plus `session.json`. CSV export (§9) is a
straight dump of the same.

**Sensor identity.** LHM sensor ids (`/amdcpu/0/power/0`) are stable per machine; NVML
fields get synthetic ids (`/nvml/0/clocks/sm`). The UI subscribes to a list; the collector
reads only subscribed sensors plus a fixed core set, so the "All sensors" view (§9) can
cost more than the default view without the default view paying for it.

**Live feed.** One SSE endpoint, 2 Hz, sending the latest row of each stream. The UI never
polls sensors itself and never opens a second sensor session.

## 7. Data sources — verified against this box

| Fact | Source | Verified here |
|---|---|---|
| RAM rated speed | `Win32_PhysicalMemory.PartNumber` → regex for the speed in the kit part number (`F5-6000J…` → 6000), with a small kit table for parts that do not encode it | 6000 rated |
| RAM actual speed | `Win32_PhysicalMemory.ConfiguredClockSpeed` | 6200 (user runs above EXPO) |
| RAM slot map | `Win32_PhysicalMemory.DeviceLocator` | A2 + B2 → correct pair |
| GPU PCIe link | NVML `CurrPcieLinkGeneration/Width` vs `MaxPcieLink*` | Gen5 x16 of Gen5 x16 |
| Resizable BAR | NVML `BAR1MemoryInfo.total` ≈ VRAM total → enabled; 256 MiB → disabled | 32768 MiB of 32607 MiB VRAM → on |
| Power plan | `powercfg /getactivescheme` GUID | Balanced |
| Disk type per path | volume → partition → `Get-PhysicalDisk.MediaType/BusType` via WMI (`MSFT_PhysicalDisk`) | all NVMe SSD |
| Free space | `DriveInfo` | D: 142 of 195 GB (73 %) |
| GPU clocks, power, temps, VRAM, throttle bits | NVML | active reasons `0x400` at idle — a bit newer than the public header; decode known bits, show unknown as hex |
| CPU package power, Tctl, VRM, fans, board temps | LHM (needs PawnIO) | yes — Tctl 49 °C, Package 64 W, NCT6687D-R fans/temps/13 rails, per-core SMU W + VID, 12VHPWR per-pin V/A |
| Per-frame timing | PresentMon | yes — 28-column QPC-stamped CSV from a desktop app; not yet against a game (Phase 4) |
| Disk queue, per-process CPU, page faults | PDH `PhysicalDisk`, `Process` | standard |
| TDR | Windows event log, `Display` source, Event ID 4101 | standard |
| GPU driver version and install date | NVML `DriverVersion`; `Win32_PnPSignedDriver.DriverDate` | 616.92 |

Note the WMI `Speed` field reports the *configured* speed on this board (6200 = 6200), not
the SPD rated speed, which is why the EXPO check parses the part number instead. True SPD
reads over SMBus are a Phase 9 nicety.

---

# Part III — Features

## 8. System audit (Phase 1 — the v1)

Runs in under five seconds, no game needed, cannot change anything. Each check returns
`{ id, state, costEstimate, severity, fix }` and the page shows the **top five by
estimated cost**. The rest are one click away under "show all".

| Check | Rule | Cost text |
|---|---|---|
| EXPO/XMP | `configured < rated − 5 %` | "10–15 % in CPU-bound games" |
| RAM channels | two sticks not in A2/B2 (or four not fully populated) | "up to 20 %" |
| PCIe link | current gen/width < max, GPU not idle-downclocked (re-read under a 2 s load burst; Gen/width drop at idle on some boards) | "2–8 %" |
| Resizable BAR | BAR1 ≪ VRAM | "0–10 %, title dependent" |
| Power plan | laptop: not High Performance; **desktop Zen 4/5: Balanced is AMD's recommended plan, do not flag** | "large on laptops" |
| Boot drive space | > 90 % full | "severe" |
| Game on HDD | `MediaType == HDD` for a launched game's path | "traversal stutter" |
| Thermal headroom | 20 s **heavy** worker load (a light load lets the boost governor idle the clocks — measured 2812→1717 MHz at 28 °C on the dev box, pure noise). Verdict from the NVML reason bits over the steady window (t ≥ 3 s): thermal/brake bits → bad; power cap with steady clocks → ok ("power-limited at N W, normal"); clock sag ≥ 8 % with peak ≥ 75 °C → warn; sag with no bits and cool → info, never hardware advice. 'unknown' unless the load engaged (power ≥ 50 % of limit) | "throttling" |
| GPU driver age | > 180 days | "occasional title bugs" |
| Background hogs | 5 s idle sample, any process > 5 % CPU or > 2 GB RAM | names the process |
| Power limit headroom | `power.limit == power.max_limit` | "no headroom to raise — undervolt instead" (informational; this box) |
| NVMe link width | PCIe current vs max link width/speed per NVMe controller (`DEVPKEY_PciDevice_*`, no admin) | "a drive on x2 halves its sequential speed — its M.2 slot shares lanes" (this box: the 980 PRO runs x2) |
| GPU unit counts (missing ROPs) | NVAPI `GetROPCount` / `GetGpuCoreCount` vs the reference in `gpus.json`; bench fill-rate cross-check (pixels/s divided by clock, with bands) when the direct read is unavailable | "168 of 176 ROPs: an early RTX 50-series unit with a raster engine disabled, about 4 % slower; the vendor replaces it" (user, 2026-09-16) |
| Timer resolution | `NtQueryTimerResolution` current vs min/max and which process requested it | "a background app holds the timer at 0.5 ms — costs battery on laptops" / "15.6 ms with no game raising it — uneven frame pacing" (info) |

Ranking: `severity × costEstimate`. Ties broken by "fixable in BIOS in ten minutes" first.

## 9. Full sensor view (Phase 2)

Behind an "All sensors" button, opens as a second window. LHM hardware tree grouped by
component, plus the NVML group. Per sensor: current, min, max, mean over the session.
Search box, "only changed" toggle, pin-to-main-bar, CSV export. Sensors at a limit
(throttle bit set, at power cap, at temp target) are highlighted in the tree. 2 Hz, no
animation, plain DOM.

## 9a. Hardware sheet (Phase 2, user request 2026-09-16)

Click a device name in the Monitor header strip and a sheet slides in with the full spec of
that part, grouped the way hardware databases group them — for the GPU: **Graphics processor**
(die, variant, architecture, foundry, process, transistors, die size), **Graphics card**
(release, generation, launch price, bus interface, **your board** — the retail name from §10's
shortlist, subsystem ids, length/slots/weight), **Clock speeds** (base / boost / memory, with
the live clocks beside them), **Memory** (size, type, bus, bandwidth — spec and measured),
**Render config** (shading units, TMUs, ROPs, SMs, tensor and RT cores, caches), **Theoretical
performance** (pixel/texture rate, FP16/FP32/FP64 vector), **Matrix performance** (dense
table + "sparse 2×", advertised AI TOPS), **Numeric formats** (vector and matrix lists per
architecture), **Board design** (slot width, dimensions, TDP, suggested PSU, outputs, power
connector). CPU: family/model/stepping, cores/threads, base/boost, cache, TDP/PPT, memory
support, NPU; live: current clocks, the user's PPT. Board: chipset, BIOS + date, slots
(DIMM map from §17a), super-IO chip, PCIe layout. RAM: per DIMM part, rated/configured speed,
timings from SPD when LHM exposes them.

Every value is tagged **spec** (from `gpus.json` / `cpus.json` / `boards.json`, each row citing
its source page) or **read** (from the snapshot or live). Unknown rows are omitted, never
shown as "—". **No third-party review data**: a "relative performance" ranking is review-derived
and someone else's work; instead the sheet offers a *spec comparison* — bandwidth, dense FP16,
VRAM, TDP — as bars against the other rows in our table, labelled "spec, not a benchmark".
Same components later render the share card's hardware line (§14).

## 9b. HWiNFO bridge — optional enrichment (user request 2026-09-16)

HWiNFO reads things LibreHardwareMonitor cannot on this box: the Zen 5 SMU PM table (PPT /
TDC / EDC limits *and* usage — the honest answer to the CPU power bar's reference), GPU hotspot
and VRM temps on cards whose EC exposes them, and it names retail boards from its own
subsystem-id database. It runs elevated with its own driver and is not ours to bundle.

**Bridge rule:** when HWiNFO64 is running with *Shared Memory Support* enabled, the collector
opens the documented read-only mapping (`Global\HWiNFO_SENS_SM2`, signature `HWiS`, sensor +
reading arrays with label, unit, value, min/max/avg) and adds those readings to the stream
as ids `/hwinfo/<sensor>/<reading>` tagged **source: HWiNFO**; rules that need them (§8 CPU
package power vs the real PPT, §17a hotspot) use them when present and fall back to the
setting / omission when not. Never a dependency: the app is complete without HWiNFO. The
free edition disables shared memory 12 hours after launch — the bridge shows "HWiNFO bridge:
off (restart HWiNFO to re-enable)" rather than stale values (readings carry a poll-time
stamp; stale > 5 s = off). Command-line report generation is Pro-only, so hardware
identification from HWiNFO is a **one-time manual report** the user can import (Report →
Create → Text) to fill the §9a sheet's unknowns and to check our tables; the importer keeps
the file local and redacts serials before anything is displayed or exported.

## 10. Local AI model advisor (Phase 3)

Inputs come from the snapshot: VRAM total/free, RAM total/free, GPU memory bandwidth
(NVML does not expose it; a small `gpus.json` keyed by name — 5090: 1792 GB/s), CPU cores,
free space on the model drive, Ollama's model list if it is installed.

```
weights   = params × bytes_per_weight     (FP16 2.0 · FP8/Q8 1.0 · Q6_K 0.82 · Q5_K 0.70 · Q4_K_M 0.56 · NVFP4 0.5)
kv_cache  = 2 × layers × kv_heads × head_dim × context × kv_bytes     (GQA: kv_heads, not heads)
required  = weights + kv_cache + 0.6 GB CUDA/activations + 1.0 GB desktop reserve
tok/s     ≈ bandwidth / weights × 0.65      (offloaded fraction runs at RAM bandwidth, ~1/20)
```

Buckets: Runs fast / Runs, tight (< 1.5 GB headroom) / Runs slowly (spills; show the tok/s
cliff) / Won't run. Context length is a slider. Sorted by largest model that still runs
fast. Download size checked against free space.

**AI stats card (user request 2026-09-15).** At the top of the page, before the model list:

| Stat | Source | Tag |
|---|---|---|
| Tensor TOPS by precision (FP16 / FP8 / INT8 / FP4, dense and sparse) | `gpus.json` spec row for the detected GPU; NPU TOPS from the CPU row when a Ryzen AI / Core Ultra NPU is present | spec |
| Memory bandwidth | `gpus.json` spec **and** the worker's bandwidth sweep kernel (§16 stage 2 reused read-only) | spec + measured |
| Matmul throughput | worker FP16/INT8 matmul kernel, achieved TFLOPS vs spec | measured |
| Tokens/s calibration | if Ollama is running: time a fixed 256-token generation on each resident/installed model, compare with the estimate | measured |
| **Best model for…** | chat · coding · vision · reasoning — the largest model in `models.json` tagged for that use that still "runs fast", with its estimated tok/s (and measured, when calibrated) | estimate |

Measured bandwidth replaces the spec number in the tok/s formula once it exists; the card
shows both so the gap (a throttled or shared card) is visible. Same measured/estimated
tagging rule as §13.

**Reference spec vs this card (user, 2026-09-16).** Every table number (TPU, vendor pages) is
the *reference design*. A board-partner card runs above it by default (Astral LC OC: 2580 MHz
boost vs 2407) and a tuned one further still (this box: memory 1979 MHz vs 1750 → ~31.7 Gbps →
~2,026 GB/s vs the 1,792 spec; core held ~3.2 GHz under load). So: (1) ceilings for sanity
checks come from **live clocks**, not tables — bandwidth ceiling = memory clock × data-rate
factor × bus width, boost ceiling = the card's own `nvmlDeviceGetMaxClockInfo`; measured above
reference spec is expected on an overclocked card, never treated as a measurement bug;
(2) the stats card shows **spec (reference) · this card (rated) · measured**, three columns,
so the gap reads as "your tune is worth +13 %" rather than "our number is wrong"; (3) OC
detection (§8) and the score's expected values (§14) baseline on the card's own rated
figures, and the offsets on top of them. (4) **No third-party database is named in the UI**
(user, 2026-09-16, "delete this" on the card's TechPowerUp link): the reference figures are
labelled *spec* and link to the vendor page only; the `tpuUrl` fields in `gpus.json` stay as the
author's provenance and never render.

**Lead with the advertised number, tag it, then the truth beneath (user, 2026-09-16).** People
arrive knowing one figure from a search — "RTX 5090: 3,352 AI TOPS" — and a card that shows only
dense numbers looks wrong to them. So the card's first line is the vendor's headline **AI TOPS
exactly as advertised**, with its precision and sparsity as a tag ("3,352 AI TOPS · FP4 sparse";
Ada quotes FP8 sparse, Ampere INT8 sparse, AMD RDNA 4 INT4/FP4 sparse, Intel Arc INT8), then the
architecture line (die · VRAM · bandwidth), then compute rows as **dense / sparse pairs** (FP16
419 / 838 TFLOPS, FP8 838 / 1,676, FP4 1,676 / 3,352, FP32 104.8) so the marketing figure and
the number that predicts speed sit side by side. `gpus.json` therefore carries an explicit
`advertisedAiTops: { value, precision, sparse, source }` per row — verified from the vendor's
own spec page, never derived. The tok/s estimate still uses bandwidth, never TOPS.

**The headline is this card's, the advertised figure beneath (user, 2026-09-16, screenshot:
"this is spec; I should see [the number] for this card").** Tensor and shader peaks scale with
the SM clock at a fixed unit count, so the card's own figure is the reference peak × (this
card's clock ÷ the reference boost): on this box 3,352 × 3090 / 2407 ≈ 4,303 AI TOPS FP4 sparse,
and FP32 shader 21,760 × 2 × 3.09 GHz ≈ 134 TFLOPS. The clock is the same one the BOOST tile
shows — the highest SM clock seen held under load, else the driver's ceiling — and the tag
says which ("at 3090 MHz held under load"). The advertised number stays as the muted second
line ("NVIDIA advertises 3,352 at the 2407 MHz reference boost"), and the dense / sparse
table follows the same rule: this card's pairs, reference in the sub-line. When no clock is
known (no collector) the card falls back to the advertised figure, tagged *spec*. The scaling
assumes the reference unit count; when NVAPI reports fewer shaders than `gpus.json` (§8
missing-units rule) the headline scales by that ratio too and says so. Still an estimate,
still not a benchmark, and the tok/s estimate still uses bandwidth.

Two corollaries from the same afternoon: `nvmlDeviceGetMaxClockInfo` (3090 MHz on every 5090) is
the VF-curve top, not the board's boost — the BOOST tile leads with the SM clock *held under load*,
then board boost (boards.json) · reference · driver ceiling, and the headline never scales by the
ceiling. And the card keeps the highest clocks it has ever seen: when a run holds less than that
record (the user's GPU Tweak was closed and its memory offset went with it — 14001 MHz held instead
of 16032, so 1463 GB/s against a 1792 ceiling was *correct* and looked like a bug), the bandwidth
block says so in one muted line instead of leaving the user to guess.

And a **MEMORY CLOCK** tile in MHz beside the Gbps one (user, 2026-09-16: "I don't see a memory
frequency ref vs this"): people know their memory as GPU Tweak and GPU-Z print it — 1750 MHz
reference, 1979 MHz tuned, "+229 MHz" — so the tile shows this card's clock in that convention
(NVML memMhz ÷ 8 for GDDR7/GDDR6X, ÷ 4 for GDDR6; `gpus.json` carries `memoryClockMhz` from the
cited page so nothing is derived from a marketing Gbps figure), the held clock first, the
reference and the offset beneath.

**GPU identity and spec tiles (user, 2026-09-16, TechPowerUp as the reference).** The GPU
panel header and the advisor's stats card open with a **spec-tile row** in the style hardware
databases use — die · shading units · TMUs · ROPs · VRAM size + type · bus width · base/boost ·
memory clock (effective Gbps) · bandwidth · TDP — every value from `gpus.json`, each row citing
its TechPowerUp GPU-database page (`https://www.techpowerup.com/gpu-specs/<slug>.c<id>`) or the
vendor page. Our own rendering; no third-party photos — the card schematic (§17a) stays ours.
`gpus.json` also carries `suggestedPsuW` (TPU lists it; 950 W for the 5090) for the §13 PSU
verdict, and the matrix table as dense figures with the "sparse = 2×" rule, so the 5090 row
reads FP4 1,676 / FP6 838 / FP8 838 / INT8 838 / FP16 419 / BF16 209.5 / TF32 104.8 TFLOPS,
FP32 104.8, advertised 3,352 AI TOPS (= FP4 × 2, sparse).

**Exact retail board.** TPU's per-GPU "retail boards" table (73 boards for the 5090, with each
board's boost clock — e.g. ASUS ROG Astral LC RTX 5090 at 2437 MHz, its OC Edition at 2580)
seeds `boards.json`. Identification: PCI subsystem vendor (0x1043 = ASUS) + the card's own rated
boost from `nvmlDeviceGetMaxClockInfo` → a shortlist of that vendor's boards at that boost; one
match names the card, several offer a pick, and the choice is remembered with the panel rename.
Never guessed: an ambiguous card shows "ASUS · GeForce RTX 5090" until the user picks. The
board's own boost is also the reference for OC-offset detection (§8), not the 2407 MHz
reference-design figure; the board's power limit (600 W on the Astral) is the reference for
efficiency, the reference TDP (575 W) only for cohort comparison.

**No local model is the normal case (user, 2026-09-16).** Most people who open this page have
never installed Ollama or any model. The page is designed for them first:

- Everything renders from the snapshot + spec tables with **no Ollama, no model, no download**:
  the stats card, every model row, the buckets, the estimated tok/s, best-model-for picks.
  The calibrated factor shipped in `advisor.ts` comes from *our* measurements (Phase 3
  integrate on the dev box), so estimates are already calibrated for everyone.
- The Ollama-dependent parts (measured tok/s, "loaded now") are an optional extra that
  appears only when Ollama answers on :11434 — never an empty table, a spinner, or an error
  when it does not. One quiet line: "Install Ollama to measure real tokens/s on your models."
- Each row carries a copyable `ollama pull <tag>` and the download size against free disk,
  because for this audience the next step is a first download, not a model swap.
- The audit's "AI model in video memory" check is omitted entirely when Ollama is not
  running — it is an observation for AI users, not a finding for everyone.
- Worker measurements (bandwidth, matmul) need no model and stay available to all.

`models.json` seeds with what this family already uses: qwen3-vl:30b, qwen2.5-coder:32b,
qwen3:4b, llama3.3:70b, gemma, deepseek-r1 sizes, plus the LTX-2.5 / Gemma 4 12B pair from
Strata Video as a "diffusion" row type. **Calibration:** Ollama is installed here, so Phase
3 ends with a measured tok/s for three models against the estimate, and the 0.65 factor is
set from that, not guessed.

Later: Strata Code's setup wizard (which currently picks a model by VRAM alone) could read
this advisor's output. Not in scope now.

## 11. Frame capture and stutter classifier (Phases 4–5, the real lift)

**Capture.** Start/stop by button, by the Game Mode process list lifted from Strata Video
(`game-mode.ts`: allowlist + exclusive-fullscreen probe), or by picking a PID. PresentMon
is started with `--process_id` so Strata Tune's own presents are never in the stream. The
first 300 frames are ignored (level load).

**Detection.** A frame is a stutter when `frame_time > 2.0 × rolling_median(120)` **or**
`> 50 ms`. Report stutter count, % of playtime lost, and separately frame-time stdev
outside stutters (pacing).

**Classification.** First match wins. All inputs are on one timeline, so "concurrent" means
within ±100 ms of the frame's QPC stamp.

| # | Signature | Verdict | Fixable |
|---|---|---|---|
| 1 | two shapes, both **decaying** over the session: (a) `GPUBusy` spike, `CPUBusy` normal; (b) DX12/Vulkan — `CPUBusy` spike with the GPU waiting (the driver compiles on the game's thread; same per-frame shape as case 8) whose rate in the last third is ≤ half the first third's, ≥ 6 stalls early; magnitude trend sets the confidence | Shader compilation | plays out |
| 2 | SM clock drop + `HwThermalSlowdown`/`SwThermalSlowdown` bit or temp ≥ target | Thermal throttle | fan curve, airflow |
| 3 | SM clock drop + `SwPowerCap` bit, temps normal | Power limit | raise limit / undervolt |
| 4 | VRAM used ≥ 95 % + spike on new assets | VRAM exhaustion | lower textures |
| 5 | disk queue depth spike concurrent | Storage | SSD, free space |
| 6 | another PID's CPU spike concurrent | Background process | names it |
| 7 | a **cluster** of stutters sharing one per-frame shape on one beat: ≥ 8 events at CV < 0.08 (high), 5–7 at CV < 0.02 (low); clusters split where a gap exceeds 3× the beat — session-wide CV claimed a tick in 94 % of randomly spaced sessions (Monte Carlo, 2026-09-16), per-cluster 1 % | GC / streaming tick | **no — engine** |
| 8 | `CPUBusy` spike, `GPUWait` high, nothing else | Engine stall | **no — engine** |
| 9 | alternating long/short, no resource correlation | Pacing / sync | cap FPS, check vsync/frame gen |

Confidence: high if two signals agree, low if one weak correlation. Shown in the report; a
low-confidence single-signal verdict starts with "Probably". Order (2026-09-16): 1(a), 2–6,
1(b), 7, 8, 9 — the CPU-side compile shape is decided only after the resource cases, since a
resource can explain such a frame and a compile cannot be confirmed; stalls in the last third
are left to case 8, because that third is the settled rate the decay was measured against.
Bench sessions (§11a) carry `benchSummary` and the report renders a designed-vs-classified
table per segment with a score ("3 of 4 designed segments classified as designed") — the
classifier's own honesty check, shown to the user.
The throttle-bit inputs (cases 2, 3) are why NVML matters: the GPU says *why* it slowed,
we do not infer it from a temperature chart.

**Report:** headline verdict → cause breakdown by % → what to do → raw at the bottom.
Cases 7 and 8 produce the sentence *"no setting on your end changes this"* in the
headline.

## 11a. Built-in stutter bench (Phase 5, user request 2026-09-15)

A capture needs a game; a **bench** does not. `StrataTune.Bench` is a small DX12 rendering
workload with a real swapchain, so PresentMon sees it like any game, and it plays a fixed
90-second script designed to trip specific classifier cases on purpose:

| Segment | What it does | Signature it should produce |
|---|---|---|
| 0–10 s | warm-up, ignored (level load rule) | — |
| 10–30 s | steady scene, many pipeline states compiled on first use, then reused | case 1 shader compilation, decaying |
| 30–45 s | streams textures from disk in bursts, growing VRAM use | case 4/5 (VRAM / storage) if the machine is weak there |
| 45–60 s | CPU-heavy simulation step every 2 s with the GPU waiting | case 8 engine stall (the "not fixable" verdict, on purpose) |
| 60–90 s | sustained GPU load at ~90 % | case 2/3 (thermal / power) if the cooler or limit is the issue |

Everything else stays identical between runs, so bench results are comparable across
machines and over time — which is what makes it usable as the **Smoothness** workload in
§14 and the before/after workload in §15. Built with Vortice.Windows (MIT DX12 bindings for
.NET), vendor-neutral, lives beside the worker in `collector/`. The report it feeds is the
same renderer as a game capture (§11, §19): headline verdict, one-sentence summary with %
of playtime lost, frame-time chart with stutters marked, cause breakdown by % with a plain
paragraph each, what to do, measurements table last. Design reference noted, not copied.

## 12. CPU-bound vs GPU-bound (Phase 5, falls out)

Per-frame `GPUBusy` vs `CPUBusy` plus GPU utilisation: report which side is the limiter
for the capture. *"Your GPU sat at 60 % while your CPU was pegged — lowering graphics
settings will not help you."*

## 13. Whole-system power (Phase 6)

Every number carries `measured` or `estimated`, visibly.

| Part | Method | Tag |
|---|---|---|
| CPU package | LHM `Package` power — on Zen 4/5 this is the MSR `C001_029B` energy accumulator (RAPL-style, core + SoC), *not* SVI3; LHM has no SVI3/PM-table readout for Zen 5, so no per-rail volts/amps or PPT/TDC/EDC | measured |
| GPU board | NVML `power.draw` | measured |
| VRM input | LHM, if the board exposes it | measured (board dependent) |
| RAM | `count × (2.5 W idle … 5 W loaded)` per DDR5 DIMM, weighted by memory bandwidth counter | estimated |
| Drives | per-device idle/active model (NVMe 0.5/6 W), weighted by queue depth | estimated |
| Fans, RGB, chipset, USB | device counts × flat model, board chipset table | estimated |

`wall = (measured + estimated) / efficiency(load_fraction, psu_rating)` with an 80 PLUS
curve table in `psu.json`. **The headline number ships early**: the Monitor page's SYSTEM POWER
row (Phase 1, user request 2026-09-15) computes it in the renderer from the existing CPU/GPU
sensors with the rest estimated; Phase 6 adds the PSU prompt UI, cost and performance-per-watt. PSU model and 80 PLUS rating asked once. Unlocks: "do I need a
bigger PSU" (peak sustained vs rated, from their own sessions), electricity cost, and
performance-per-watt — the number that sells undervolting in §16.

**Stated in the UI, not a footnote:** polling is 10 Hz; PSU OCP transients are microseconds;
a clean graph does not prove a healthy PSU.

## 14. System score and share card (Phase 7)

Four subscores, each clickable to the findings that cost points:

| Subscore | Source |
|---|---|
| Configuration | §8 audit, deterministic |
| Thermals | sustained clock vs rated, % of load time with a throttle bit set |
| Smoothness | §11, **cases 7 and 8 excluded** |
| Efficiency | §13 performance per watt |

Stability caps the total: any compute error or TDR in validation ceilings the score.
Expected values day one come from spec (`gpus.json`: rated boost, TDP, bandwidth;
`cpus.json`: boost, TDP). Later, opt-in anonymised cohorts shipped as JSON through GitHub
releases.

Validity: fixed workload (the worker's heavy pattern, 60 s) and duration; the run is marked
invalid if background load, throttling or thermal drift tripped during capture. A silently
bad score is worse than none.

Share card: 1200×630 PNG drawn on a 2D canvas (works with GPU acceleration off) — total,
four bars, top fix, hardware line, `St` monogram.

## 15. Fix verification (Phase 7, trivial once §14 exists)

After any change, re-run the identical workload, show the delta, store
`{ what, before, after, date }` in `history.json`. The score's movement over time is that
history.

## 16. OC auto-tune (Phase 8 — last, opt-in, behind a warning)

The warning modal's wording and the acknowledgement it records are specified in §27a (the
hardware-risk paragraph is shown every time Tune is enabled, not once).

**Undervolt first, not overclock.** On this box the power limit is already at its maximum,
so an undervolt is the only lever with any gain anyway.

Two corrections to the manual method, both from the spec, both kept:

- **Two-phase validation.** Hunt the ceiling with fans high, then re-validate at the user's
  real fan curve under sustained load. Ship the second number.
- **Memory by bandwidth, not stability.** Sweep upward, measure bandwidth per step, back off
  to the last rising point. GDDR7 corrects silently and just gets slower.

**Failure ladder** — stop at the first stage that trips:

| # | Stage | Detector | Cost |
|---|---|---|---|
| 1 | silent compute/memory error | deterministic kernel, hash vs stock-clock reference | none |
| 2 | bandwidth regression | throughput drops as memory retries | none |
| 3 | TDR | Event 4101; worker dies, collector lives | ~5 s |
| 4 | hard hang | `PENDING` flag on disk, caught at next boot | a reboot |

**Three load patterns per candidate** (heavy, near-idle, rapid switching). VF-curve
instability shows up at *low* load; an undervolt that survives an hour of heavy load and
crashes on the desktop is the common failure.

**Bisect, one variable at a time.**

**Rollback state machine** (in the collector, persisted to `tune-state.json` *before* each
apply):

```
KNOWN_GOOD → PENDING → VALIDATING → KNOWN_GOOD
                 ↓ (crash / flag found at next launch)
              REVERTED  (tell the user exactly which value did it)
```

`VALIDATING` requires one clean shutdown; only a clean boot after a clean shutdown
promotes. Also register a Windows Task Scheduler entry at logon that runs
`strata-tune-collector.exe --revert-if-pending`, so the revert happens even if the user
never opens the app again.

**Flight recorder.** During any test, the last 30 s of the timeline is flushed to disk every
second. After a hard hang the app opens on "here is what temps, clocks, power and limit
bits were doing in the seconds before it died".

**Live monitor during tests** lives in the UI, fed by the collector at 2 Hz: total W
(tagged), CPU/GPU W, requested vs effective clock, mem clock, GPU core/hotspot/memory
junction, CPU package, fan %, **perf-limit reasons as a label**, VRAM, test state (candidate,
ladder position, pattern, elapsed, error count, bandwidth). A **test validity indicator**
turns red if a throttle bit is set during a ceiling hunt.

**Another tool's tune on the card (found 2026-09-16).** GPU Tweak's offsets do not show in the
NVAPI P0 deltas we read and write (baseline read 0 / 0 while the card held 15837 MHz memory
against a 14001 ceiling), so the two tools write through different driver routes and cannot see
each other. Before any hunt, if the card is holding clocks above the driver ceiling with no P0
delta of ours, the hunt refuses: "another tool is tuning this card — zero its offsets or close
it first"; the same check runs before *restore baseline*, which must never be the thing that
looks like it wiped a vendor tune. And a vendor tool's Apply can be dropped silently by the
driver (the user's +4072 sat on the slider while the card kept +3672 until a re-apply): the
Monitor shows what the card holds, never what a slider says.

**A shutdown is not a hang (found 2026-09-16).** The logon revert found a Pending marker after
the overnight shutdown and logged it as "a hard hang, stage 4". The marker must record whether
the collector saw an orderly stop (SIGTERM / `/shutdown` / session end event) so a clean
shutdown mid-candidate reverts quietly and only a genuinely dirty exit is called a hang.

**The power cap is the normal state, not an invalid rung (user, 2026-09-16: "600 W is the power
budget, that's fine — we still have the core and memory knobs; look at my current OC vs spec").**
Tonight's three test hunts declared every rung "Invalid: a power or thermal limit was set on
77–80 % of the heavy pattern's samples" — on a 600 W 5090 every heavy pattern sits on the cap,
and the user's own tune runs there: +319 core holds 3225 MHz *at* 600 W against a 2407 reference
(3000 MHz on a light load, driver ceiling 3090), +4072 memory holds 16008 MHz (32.0 Gbps, +14 %
bandwidth). A core offset under a cap shifts the V/F curve — same watts, higher clock — and a
memory offset barely touches power. So a rung is judged by what matters: (1) the hash — no
silent errors; (2) the **light and transient patterns**, which run at the top of the curve where
the offset is actually exercised; (3) heavy-pattern **throughput at the cap** — did the offset
buy work per watt; a rung whose light/transient patterns pass and whose heavy throughput did not
fall is certified whether or not the cap bit was set. The memory ladder runs first and on its
own (cheap win, orthogonal to the cap). The result page shows the user's current OC · the board's
rated figures · the reference · the ladder's certified numbers in one table. **The hunt starts from whatever the card holds now (user, 2026-09-16: "just increment on
whatever the current OC applied is, in steps of 5–15 MHz on both core and memory").** The
baseline is the card as found — its held SM and memory clocks under the reference pass, vendor
tune included — and our P0 deltas step on top of it: core +15 MHz per rung (fine step 5),
memory +15 MHz NVML (30 effective) per rung (fine step 5). The first rung doubles as the
additivity check: the light pattern must hold a clock higher than the baseline by about the rung
size, or the hunt stops with "the driver is not adding our offset on top of your tune" instead
of climbing blind. The result names both: "your tune holds 3225 / 16008; certified +45 core /
+60 memory on top → 3270 / 16068; first silent error at +60 core (stage 1)". The vendor-tool
guard above therefore refuses only a vendor tool that is *changing* clocks during a run (a
profile timer, a fan-curve app re-applying), not a tune that is simply applied and steady.

**Write path.** NVML can set power limit and locked clocks (admin); VF-curve offsets need
NVAPI (`NvAPI_GPU_GetPstates20` is public, the set side is the semi-private call every
third-party OC tool uses). Risk R2 covers this. Output is also a **copy-pasteable value set
for Afterburner / GPU Tweak**, so people who do not trust the tool to apply settings can
still use its results, and so AMD users get something from day one.

---

# Part IV — Product

## 17. UI

Five pages on the family's bottom-bar page switcher, in the order people need them:

`Audit · Monitor · Capture · AI Models · Tune`

- **Audit** is the home page: score at the top once it exists, five ranked findings, "All
  sensors" button, pinned-sensor strip.
- **Monitor** is the 2 Hz live view; also the view shown during a Tune test.
  Includes a **core grid** (user request 2026-09-15, Ryzen Master-style): one tile per
  physical core showing load %, effective clock, and nominal clock, laid out by CCD when the
  CPU has more than one (9950X: 2 × 8), with per-core SMU power and VID on hover. All of it
  is already in LHM's tree (`/amdcpu/0/load/N`, `/amdcpu/0/clock/N` + `(Effective)`,
  `/amdcpu/0/power/N (SMU)`, `/amdcpu/0/voltage/N VID`) — this is presentation, not a new
  source. Effective clock is the honest number (a parked core reports 5.7 GHz nominal and
  ~0 effective); the tile colour follows load, the big figure is the effective clock. Intel
  CPUs get the same grid from their per-core sensors, P/E cores grouped instead of CCDs.
- **Capture** lists sessions; opening one shows the report (same renderer as the HTML).
- **AI Models** is the advisor with the context slider.
- **Tune** is hidden behind a settings toggle plus a warning modal until Phase 8 ships.
- **About** is a utility hub in the CPU-Z tradition (user, 2026-09-16), not a credits card:
  version · author · licence · Windows edition, version and build · DirectX level · GPU driver ·
  collector / PawnIO / HWiNFO-bridge status; and a **Tools** block: *Save system report*
  (.txt / .html — our own: snapshot, spec sheet, current sensors, serials redacted — the file
  people attach to a forum post), *Clocks* (a live per-core / GPU clock table window), *Timers*
  (Windows timer resolution current/min/max via `NtQueryTimerResolution`, QPC frequency, HPET/TSC
  source — also an §8 audit check), *Validation* (the §14 share card), *Copy hardware summary*,
  *Open logs folder*, *Support development*. A **Legal** block renders `LICENSE`, `DISCLAIMER.md`,
  `THIRD-PARTY-NOTICES.md` and the privacy statement from the bundled files (§27a).

Right-hand chat panel like the other apps — but here it is *optional* and *later*: the
family's Ollama agent could explain a report in plain words, but the report already is
plain words. Not before Phase 9.

Rendering rules everywhere: `app.disableHardwareAcceleration()` before `ready`; no canvas
charts during an active test; report charts are inline SVG.

## 17a. Monitor page design (user direction 2026-09-15)

The Monitor page is an instrument panel, not a table of numbers. It should look like a
professional hardware tool — dense, calm, dark, every value with a bar or a gauge so the
eye reads state before it reads digits. Still plain DOM/SVG at 2 Hz, no canvas, no
continuous animation (CSS transitions ≤ 200 ms on bar width only), so it costs nothing
while a test runs (A6).

**Layout (desktop ≥ 1280 px), top to bottom:**

1. **Header strip** — CPU name · GPU name · board · session time · collector status.
2. **CPU panel** (left half)
   - *Chip diagram*: an SVG outline of the package with one cell per core, arranged by CCD
     (two 4×2 blocks for the 9950X; P/E clusters on Intel). Cell fill = load (0 % dim →
     100 % accent), cell label = effective GHz, small nominal GHz beneath; hover → SMU W,
     VID, load. CCD header shows its Tdie; the IOD/package cell shows Tctl and Package W.
   - *Bars beside the chip*: Tctl vs Tjmax (95 °C on Zen 5) with the throttle line marked;
     Package power vs PPT (or vs the 9950X's 230 W stock PPT when the SMU value is not
     readable); average effective clock vs max boost; per-CCD temps.
3. **GPU panel** (right half)
   - *Card schematic* (user direction 2026-09-15: the bar is ASUS GPU Tweak III's thermal
     map / power detector, and ours must be clearly better — same glance, more analysis, with
     history). A schematic SVG of a card, not vendor art, outlined in the vendor colour:
     - **Top edge — 12V-2x6 connector block.** Six pins as vertical bars on a 0–9.5 A scale
       (the per-pin continuous rating), each labelled with A and W and its 12 V reading in a
       small row beneath (LHM on the ROG Astral LC 5090 exposes per-pin voltage, current and
       power, plus connector totals). Under the pins: total A / W against the connector's
       600 W rating with a limit tick, and the two numbers GPU Tweak never computes —
       **spread** (max − min) and **max/mean** — coloured emerald ≤ 10 % spread, amber
       10–20 %, red > 20 % or any pin above 8 A. Hover a pin → its 60 s sparkline. **Only cards with
       per-pin shunts expose this** — ASUS ROG Astral / Matrix and a handful of others; a Founders
       Edition or most partner cards report board power only. **No per-pin sensors → the whole
       12V-2x6 block is hidden** (user, 2026-09-16), the GPU panel reflows around it, and the
       spread / max-mean analysis and any connector-balance audit row do not exist for that card.
       Board power is already on the GPU bars, so nothing is lost and nothing is faked.
     - **Centre — die block**: core temp large, core voltage and SM clock small; hotspot
       only when the driver exposes it (NVML thermal sensors), otherwise omitted, never "—".
     - **Around the die — memory blocks**: VRAM used/total as a fill, memory-junction temp,
       memory clock.
     - **Flanks — engine loads** as micro-bars (3D, copy, video decode/encode, optical flow,
       JPEG): rows at 0 collapse, so an idle card shows two rows and a rendering card six.
     - **Bottom edge — PCIe edge connector** with gen × width and an Rx/Tx throughput
       sparkline (the link check made visible).
     - **Fans** as circles with RPM and duty (on a liquid-cooled card these are the radiator
       fans; label them Fan 1/2, not "GPU Fan").
     - Perf-limit pills directly beneath the card. Everything has a 60 s sparkline on hover.
   - *Bars*: core temp vs target, hotspot and memory junction when present, board power vs
     limit (with the max limit marked), SM clock requested vs effective (the gap *is*
     throttling — draw both on one bar), memory clock, GPU/memory-controller/bus load.
   - *Perf-limit reasons* as pill labels under the bars: none / power cap / thermal / voltage
     / reliability / sync boost / idle — decoded from the NVML bitmask, the spec's highlight.
4. **Board & memory panel** (full width, shorter)
   - Rails as bars with tolerance bands: +12 V, +5 V, +3.3 V, Vcore, SoC, DIMM (DDR5 1.1–1.45 V
     band), each amber outside ±5 %.
   - Board temps (VRM MOS, chipset, socket, system) and every fan header with RPM and duty %.
   - DIMM slots drawn as a slot map (A1 A2 B1 B2) with populated slots filled, speed and
     capacity on each; the EXPO state from the audit as a badge.
5. **Storage & system panel** — one row per NVMe/SSD: temperature bar, free-space bar,
   current disk queue; total RAM used bar with the top hog named.
6. **Sparklines** — every bar carries a 60 s history sparkline (SVG polyline, 30 points at
   2 Hz… 120 at 2 Hz for 60 s) drawn from the ring buffer window so a spike that just
   happened is still visible.

**Visual rules:** one accent (emerald) for "good/active", amber for "near a limit", red for
"at a limit / throttling", slate for idle or absent.

**Vendor identity (user direction 2026-09-15).** Each device panel carries its vendor's colour
as an *identity* accent — the panel header text, the 1 px left border, the chip/board outline
and the load tint in the chip cells: NVIDIA `#76B900`, AMD `#ED1C24`, Intel `#0071C5`,
Qualcomm/Snapdragon `#3253DC`; board panels by board vendor when known (MSI `#C8102E` (a deeper crimson than AMD's red so an AMD CPU panel and an MSI board panel stay distinct side by side — user confirmed MSI = red shade, 2026-09-15),
ASUS `#00539B`, Gigabyte `#F58220`, ASRock `#00A651`), else slate. **State colours are never
vendor colours**: bars, ticks and pills keep emerald / amber / red / slate for good / near /
at-limit / idle, so an AMD panel's red header never reads as "throttling". Vendor is
detected from the snapshot (`cpu.name`, `gpus[].name`, `motherboard.manufacturer`), one map
in `src/data/vendors.json`, unknown → slate. Bars are thin (6–8 px), rounded, with
the limit drawn as a tick, not a second bar. **No text is ever clipped**: tiles and rows wrap or shorten by
content; a CSS `truncate` on a label is a defect (user, 2026-09-16). Numbers in a tabular monospace figure font;
labels in the UI font at 11 px, uppercase, tracked. Panels have a 1 px border and a
slightly lighter surface; no shadows, no gradients except the load fill on the chip cells.
Nothing blinks. Absent sensors collapse their row rather than showing "—" walls.

**Responsive:** below 1280 px the two halves stack; the diagrams keep their aspect ratio
and scale with `max-width: 100%`.

**Phase 1 ships** the CPU panel (chip diagram + bars), the GPU panel (bars, perf-limit pills,
the full 12V-2x6 connector block with spread/max-mean analysis), rails and fans, and
sparklines. The card schematic around that block came in with Phase 1's polish pass
(user feedback 2026-09-16, `.claude/workflows/phase1-polish.md`, with named and movable
panels); the storage panel and the DIMM map are Phase 2's first items, with the full sensor
view. Same components later render inside the Tune live monitor (§16).

## 17c. Footprint budget (user direction 2026-09-16)

Measured on each PR, on the dev box and on a laptop when one is available:

| Budget | Target | How measured |
|---|---|---|
| Collector idle CPU | ≤ 1 % of one core at 2 Hz LHM / 10 Hz NVML; ≤ 0.3 % on battery | Process V2 counter over 60 s |
| Renderer idle CPU | ≤ 1 % with Monitor open, ≈ 0 on other pages | same |
| RAM | collector ≤ 120 MB, renderer ≤ 200 MB, worker/bench only while running | working set |
| Package | ≤ 150 MB installed: one shared .NET runtime folder for collector, worker and bench (framework-dependent publish into one `runtime/`), not three self-contained bundles; renderer assets minified, no unused fonts/icons | installer size |
| Startup | UI ≤ 1.5 s to first paint, collector first tick ≤ 1.5 s after UAC | log timing lines |
| GPU | none, ever (A6); no canvas, no WebGL, no continuous animation | `app.getGPUFeatureStatus` |
| Small screens | usable at 1366×768 and 125–150 % DPI: panels stack, bars stay legible, no horizontal scroll | screenshot at that size |
| Battery | on DC power: LHM 1 Hz, NVML 2 Hz, sparklines 1 Hz; Monitor tab hidden → no ticks | `powercfg` / Electron `powerMonitor` |
| No NVIDIA | AMD/Intel: NVML absent → the GPU panel shows LHM's AMD/Intel sensors; audit rules that need NVML report 'unknown', never fail; the advisor works from the table | run with NVML export disabled in tests |
| Idle Ollama/apps | never poll a service the user does not run; discover once, back off | log |

**Every long action can be stopped** (user, 2026-09-16: the audit had no way to interrupt it).
Audit, capture, bench, measure, calibrate, tune hunt, validation: a Stop button next to the
progress line from the first second; Stop cancels the underlying process (collector `POST
/load/{id}/cancel` kills the worker or bench and releases the lock; PresentMon is terminated;
Ollama generation is aborted), the collector returns to idle within 2 s, and the page shows the
partial result marked *interrupted* rather than a blank. Escape does the same while the run
is focused. A stopped run never leaves a PENDING tune state, a lingering process, or a held
gpu.lock.

Rules of thumb: subscribe to sensors, never read everything; batch IPC at 2 Hz; unmount pages fully; no timers on hidden pages; the ring buffer's memory is bounded by time (§6).

## 18. Brand

- **Strata Tune**, `St` monogram, geometric construction like Sc/Sp/Ss (no typeface), from
  the family's `monograms.py` — add an `St` entry.
- Accent: **emerald `#10b981`**; the family script's luminance rule puts near-black marks on it
  (same as gold). Indigo is Code, gold is Photo/Snap; green reads as diagnostics/health and
  does not collide.
- "Created by Kaustubh Jawanjal" in About and the Help menu footer only — **not** in the title
  bar (user decision 2026-09-15; Strata Photo's title-bar byline is that app's rule, not the family's).
- `support.json` with the same shape as Strata Code; donate button hidden while the URL is
  empty.
- Title bar: `St` monogram · STRATA TUNE · Help · window controls.
- Bottom bar: collector/capture state · page switcher. No monogram or wordmark — the title bar
  already carries them (user, 2026-09-15).

## 19. The HTML report

One React renderer, two outputs: the in-app Capture view and a standalone HTML file. The
build produces `report-template.html` with `vite-plugin-singlefile` (all JS/CSS inlined);
exporting a report injects the session's analysis JSON into a `<script type="application/
json">` tag. No external requests, opens from a Discord download, renders in any browser.
Raw stream data is not embedded (size); the report carries the analysis, the summary rows
and the top-N stutter windows.

## 20. Sharing the GPU with the family

Strata Code, Photo and Video coordinate through `gpu.lock` plus Ollama's loaded-model list.
Strata Tune:

- **Passive monitoring never takes the lock.** Reading NVML while Strata Video renders is
  free and is in fact a useful thing to watch.
- **Stress tests and score runs take the lock**, and refuse to start if another Strata app
  holds it or Ollama has a model resident (the test would be invalid anyway — background
  load trips the validity indicator).
- The Game Mode probe is shared code: copy `game-mode.ts` now, factor into a family package
  later if a third app needs it.

---

# Part V — Execution

## 21. Project structure

```
strata-tune/
  docs/
    master-plan.md           this file
    spec-original.md         the idea document, verbatim
  electron/
    main.ts                  frameless window, GPU accel off, collector lifecycle
    collector-client.ts      handshake file, token, SSE, typed API
    game-mode.ts             from Strata Video
    preload.cjs
  src/
    pages/{Audit,Monitor,Capture,Advisor,Tune}.tsx
    analysis/
      audit.ts               §8 rules
      stutter.ts             §11 detection + classifier
      bound.ts               §12
      power.ts               §13
      score.ts               §14
      advisor.ts             §10
    report/                  shared renderer, singlefile build target
    components/              TitleBar, BottomBar, SensorTree, Monogram
    data/
      models.json  gpus.json  cpus.json  psu.json  kits.json
  collector/                 .NET solution
    StrataTune.Collector/    Kestrel minimal API, SSE, ring buffer, LHM, NVML, PDH,
                             PresentMon host, tune supervisor, revert-if-pending
    StrataTune.Worker/       ComputeSharp kernels, heartbeat
    StrataTune.Bench/        DX12 rendering workload with a swapchain (§11a), Phase 5
    StrataTune.Shared/       row types, wire types
  tools/
    presentmon/              vendored PresentMon.exe (gitignored binary, script fetches)
  scripts/
    setup-tools.ps1          downloads + hash-checks PresentMon, reports PawnIO/.NET/group state (PawnIO is not ours to redistribute; it links to pawnio.eu)
    build-collector.ps1      dotnet publish self-contained → resources/collector/
  assets/                    strata-tune-st.ico, logo data URL
  support.json  package.json  vite.config.ts  tailwind.config.js  tsconfig.json
  run-strata-tune.bat  run-strata-tune.vbs  Install-Shortcuts.ps1
```

## 22. Toolchain setup (Phase 0)

At planning time this machine had no .NET SDK and no PresentMon; PawnIO 2.2.0 turned out to be
installed already (2026-08-30). Pinned versions and verified API facts live in
[dependencies.md](dependencies.md). Phase 0 is mostly installs:

1. .NET SDK 10.0.401 (`winget install Microsoft.DotNet.SDK.10`) — installed 2026-09-15.
2. `LibreHardwareMonitorLib` 0.9.6 — the only stable release that pairs with PawnIO 2.1+;
   PawnIO 2.2.0 is already installed here. Confirm LHM enumerates CPU package
   power, Tctl, VRM and fan RPM on this X670E/X870 board with HVCI on. **This is the
   go/no-go for the whole sensor layer**; if PawnIO+LHM does not read this board, the
   fallback is HWiNFO's shared-memory interface (read-only, requires HWiNFO running) and
   the plan gets a §7 amendment.
3. PresentMon 2.5.1 (GitHub `GameTechDev/PresentMon`), vendored by `scripts/setup-tools.ps1`. Run it once with
   `--qpc_time` and confirm the CSV columns match §11 (done against a desktop app; the first game capture is Phase 4).
4. `ComputeSharp` 3.2.0 (needs `AllowUnsafeBlocks`); a uint-only hash kernel proving
   determinism across runs.
5. Electron shell scaffolded from Strata Video (same versions: Electron 34, React 18, Vite
   6, TS 5.7, Tailwind), `disableHardwareAcceleration` on, `St` monogram generated.

## 23. Phases — with a calendar

Days, not months, like the Video plan. The dev box is the only test machine until Phase 4;
a second machine (a laptop, an AMD card, a box with EXPO off) is wanted from Phase 4 on.

### Phase 0 — Toolchain (day 1)
§22. Ends when LHM lists this board's sensors from an elevated .NET console app and
PresentMon writes QPC-stamped rows.

### Phase 1 — Sensor layer + audit (days 1–3) — **ships as v0.1**
Collector: handshake, token, ring buffer, LHM + NVML at 10 Hz, snapshot, SSE. UI: Audit
page with the §8 rules, top five, "show all". Every check exercised on this box (EXPO on,
ReBAR on, Gen5 x16, Balanced-on-Zen5 not flagged, D: at 73 % not flagged, C: fine).

### Phase 2 — Full sensor view + hardware sheet (days 4–5)
§9 and §9a. Presentation over Phase 1. Pins, min/max/mean, CSV export; the spec sheet per device.

### Phase 3 — AI model advisor (days 4–5) — **v0.2, the shareable one**
§10 with `models.json`, `gpus.json` TOPS/bandwidth rows, the AI stats card (spec + measured), best-model-for picks, context slider, and the Ollama calibration run.

### Phase 4 — Frame capture (days 6–7)
PresentMon host, PID filter, Game Mode start/stop, `frames` stream, session save/load,
stutter *detection* and the pacing number. No classification yet. **Anti-cheat check** on
one live title (A11).

### Phase 5 — Classifier + bound verdict + bench (days 8–11) — **v0.3**
§11 nine cases with confidence, §11a built-in bench, §12, report renderer, singlefile HTML export. Gate: a
capture of a known shader-compilation-heavy title gets case 1 with high confidence; a
capture with Strata Video rendering in the background gets case 6 naming it.

### Phase 6 — Power (days 11–12)
§13, `psu.json`, PSU prompt, the transient disclaimer, performance-per-watt.

### Phase 7 — Score, share card, fix verification (days 12–14) — **v0.4**
§14 fixed workload via the worker's heavy kernel (needs Phase 8's worker, built early —
read-only use), validity rules, PNG card, §15 history.

### Phase 8 — Tune (days 15–20, opt-in) — **v1.0**
§16 in order: rollback state machine and logon revert task **first**, flight recorder,
worker ladder (hash → bandwidth → TDR → PENDING), three load patterns, bisect, two-phase
validation, NVML power/clock writes, then NVAPI VF offset. Undervolt only in 1.0; core
offset and memory sweep in 1.1. Afterburner value-set export ships with 1.0 regardless.

### Phase 9 — Later
SPD reads over SMBus, AMD (ADL/ADLX) read paths, opt-in cohort JSON, Ollama explainer
panel, sharing the advisor with Strata Code's setup wizard.

## 24. Expected result

On this box, v0.1 says: EXPO on and above rated; ReBAR on; Gen5 x16; power limit already at
max — undervolt is the lever; driver 616.92 current; no background hogs; nothing to fix.
That is the right answer for a tuned machine and it is worth showing that the tool can say
"you're fine". v0.3 on a real game capture is the first output a stranger would post. v1.0
finds a stable undervolt, re-validates it at the real fan curve, and shows the FPS-vs-watts
trade in one sentence.

## 25. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | PawnIO + LHM does not read this board's sensors under HVCI | Phase 0 go/no-go; HWiNFO shared memory as the fallback read path |
| R2 | NVAPI VF-curve set call is semi-private and Blackwell may have changed it | Undervolt via NVML locked clocks + power limit first (fully public); VF offset second; Afterburner export always works |
| R3 | PresentMon column set changes between releases | Pin the version, vendor the exe, parse by header name not index |
| R4 | The 2 Hz dashboard still perturbs a bandwidth sweep | GPU accel off app-wide; validity indicator; compare sweep results with the UI minimised |
| R5 | EXPO detection from part numbers misses kits | `kits.json` grows; unknown kit → "could not determine rated speed", never a false flag |
| R6 | Classifier over-confident on single-signal cases | Confidence shown; low-confidence cases render as "probably" |
| R7 | A hard hang leaves the machine on a bad value | PENDING flag + logon revert task; state persisted *before* apply |
| R8 | Elevated collector exposes an HTTP endpoint | Loopback only, random port, per-launch token, no writes without the token, exits with the UI |
| R9 | Only one test machine | Phase 4 onward wants a laptop and an AMD box; ask the family/friends |

## 26. First three commits

1. `Toolchain: .NET collector solution, LHM+PawnIO sensor dump, PresentMon vendored` — a
   console app printing this board's sensor tree and ten QPC-stamped frame rows.
2. `Electron shell from Strata Video, GPU acceleration off, St monogram, collector
   handshake` — the app launches, elevates the collector, shows the live sensor strip.
3. `Audit page: eleven checks, top five ranked, verified on the dev box` — v0.1.

## 27. Open decisions

- **Spelling**: "Strata Tune" (two words, like Photo/Code/Video) is used here; StrataSnap is
  one word because it is the Android app. Flip it before commit 2 if preferred.
- **Licence**: MIT for the repo. LHM is MPL-2.0 (library use is fine), PresentMon MIT,
  ComputeSharp MIT, PawnIO is a separately installed driver (check its licence for
  redistribution of the installer vs linking to it).
- **Elevation UX**: one UAC prompt per launch (v1) vs installing the collector as a Windows
  service once (later). v1 is the prompt. The user finds the per-launch collector start slow (2026-09-15):
  Phase 1's fix pass adds a startup budget (handshake before LHM `Open()`, staged sensor
  groups, one NVML session, timing lines; target first tick < 1.5 s after the UAC click), and
  the service install moves up to the first post-v0.1 item so the collector is already warm
  when the app opens.
- **.NET 10 vs 8**: 10 unless a library lags.
- **Release model (user, 2026-09-16): every Strata app ships as freeware** — free downloads for
  anyone, no paid tier, no subscription, donations via `support.json`. For Strata Tune that adds a
  release phase after Phase 8: an installer (electron-builder NSIS, per-user install into
  `%LOCALAPPDATA%` for the UI, the collector/worker/bench under an admin-only folder per §5's
  install-location rule), Authenticode signing (Smart App Control, §27 above), GitHub Releases
  with the installer and a portable zip, a one-page download site, the plain-language
  disclaimer shown on first launch and on the installer's licence page (§27a) and the third-party
  notices, and the repo flipped public at that point. The same checklist applies
  to Strata Code, Photo, Video and Snap when they follow.
- **Code signing (found 2026-09-16)**: Smart App Control on the dev box (Windows 11 Home) blocks the
  loose, unsigned collector DLLs from `bin/` (CodeIntegrity 3077/3118, HRESULT 0x800711C7) but
  allows the self-contained single-file publish. Dev launches prefer the published bundle. Before
  v0.1 ships publicly, the collector, worker and bench exes need an Authenticode signature
  (an OV cert, or Azure Trusted Signing) or Smart App Control users get a silently blocked
  collector; the client must also detect that exit and say so in the status pill.

## 27a. Legal (user direction 2026-09-16)

The user's words: "all the required legal stuff, and I will not be responsible for anything".
Strata Tune reads sensors, runs stress loads and — in Phase 8 — changes clocks and voltages.
That is exactly the kind of tool whose author gets blamed for a dead card, so the legal
surface is part of the product, not a footnote. Not legal advice; the author reads every text
before v0.1 ships. Everything below is plain language first, legalese only where a term of art
is needed.

**One source, many surfaces.** The texts live in the repo root beside `LICENSE`:
`DISCLAIMER.md` (no warranty · no liability · hardware risk · readings and advice are
informational · not affiliated with any vendor) and `THIRD-PARTY-NOTICES.md` (exists). The app
bundles both files verbatim (electron-builder `extraResources`) and renders them; nothing is
retyped into a component, so the wording can only drift in one place.

| Surface | What it shows | When |
|---|---|---|
| **First launch** | `DISCLAIMER.md` in a modal with one button, *I understand*; the app does not start the collector until it is pressed. Acceptance is stored as `{ version, acceptedAt }` in settings and re-shown when the disclaimer's version changes. | once per disclaimer version |
| **Tune warning modal** (§16) | the Phase 8 four-section warning already there, plus the hardware-risk paragraph of the disclaimer and an explicit line: raising clocks or voltages can crash the machine, lose unsaved work in other apps, shorten the life of or damage the card, and may void the vendor's warranty; the user does this at their own risk. Acknowledged with the settings toggle each time Tune is enabled; the acknowledgement (date, app version, GPU name) is written to the tune log so a later bug report shows it. | every enable |
| **About → Legal** (§17) | tabs: *Licence* (MIT), *Disclaimer*, *Third-party notices*, *Privacy*; a *Copy* button per tab. | on demand |
| **Installer** | the NSIS licence page shows `LICENSE` followed by `DISCLAIMER.md`; declining exits setup. The portable zip carries both files at its root. | install |
| **README / download page** | a *Legal* section: two-sentence summary, links to the three files, the trademark line. | always |
| **Reports and share cards** (§14, §19) | one footer line: "Readings come from your drivers and sensors and can be wrong; nothing here is professional advice." Serials stay redacted (§17 system report). | every export |

**What `DISCLAIMER.md` says** (the plain-language points, in this order):

1. *Free software, as is.* No warranty of any kind — not that it works, not that readings are
   right, not that it is fit for any purpose. (The MIT licence already says this for the code;
   the disclaimer says it for the app people download.)
2. *No liability.* The author is not responsible for any damage or loss from using the app:
   hardware damage, data loss, downtime, lost warranty, anything else, whatever the legal theory.
   Where a jurisdiction does not allow a full exclusion, liability is limited to the greatest
   extent it does allow — and the app is free, so nothing was paid to refund.
3. *Hardware risk is real and it is the user's.* Phases 1–7 change nothing (A7). Tune is off by
   default, behind a warning, and applies only what the user enables; overclocking, undervolting,
   power-limit and fan changes can crash, corrupt unsaved work, damage components and void
   warranties. Run it on a machine you can afford to lose work on, back up first, and stop if
   anything looks wrong.
4. *Readings and advice are informational.* Sensor values come from drivers, firmware and
   third-party libraries and can be wrong or missing; the audit's findings, the advisor's model
   and token-rate estimates, PSU sizing and the stutter verdicts are estimates from published
   references and the app's own tests, not professional, engineering or purchasing advice.
   Verify before acting on anything that costs money or touches hardware.
5. *Not affiliated.* NVIDIA, GeForce, AMD, Ryzen, Radeon, Intel, ASUS, ROG, MSI, Gigabyte,
   Windows, DirectX, HWiNFO, Ollama and every other name in the app are trademarks of their
   owners; Strata Tune is an independent project, not endorsed by or connected with any of them.
   Model names in the advisor are their publishers' and each model has its own licence.
6. *Your data stays yours.* No telemetry, no accounts, no network calls except the ones the
   user starts (a local Ollama on `127.0.0.1`, external links the user clicks, and the optional
   update check when it exists — off until asked). Sessions, logs and settings live under
   `%LOCALAPPDATA%\Strata Tune`; exported reports and share cards may carry hardware names and
   clocks — the user decides where those go, and serials are never in them.
7. *Third-party components* are listed with their licences in `THIRD-PARTY-NOTICES.md`; PawnIO
   is a separately installed driver under its own terms; HWiNFO, when the user runs it, is theirs
   under HWiNFO's terms (§9b); Ollama and the models it serves are the user's own installs.
8. *Donations* are voluntary gifts, buy nothing, and are not tax-deductible unless the user's
   own rules say so.
9. *Governing text.* The English text is the one that counts; translations, when they exist,
   are for convenience.

**Repo hygiene that backs the words.** The `LICENSE` copyright line, the About author line and
the disclaimer's "the author" all name the same person; `THIRD-PARTY-NOTICES.md` is regenerated
on every dependency bump (its own header says how); the MPL-2.0 components stay unmodified
(modifying an LHM file would require publishing that file — the plan never does; §9b's bridge
reads HWiNFO's shared memory, which is a documented interface, not HWiNFO code). Every Strata
app ships the same `DISCLAIMER.md` skeleton with its own hardware-risk paragraph (Photo and
Video have none; Snap's is the camera), per the family freeware rule in §27.

---

# Appendix A — Where this plan departs from the spec

| Spec says | Plan does | Why |
|---|---|---|
| NVAPI for GPU reads (link width, ReBAR, perf-limit reasons) | NVML for all reads; NVAPI for writes only | NVML is public, no admin, no driver, and exposes the perf-limit bitmask directly. ReBAR comes from BAR1 size — verified here (32768 MiB). |
| "EXPO: compare SPD rated vs actual" | Part-number parse vs `ConfiguredClockSpeed` | WMI `Speed` reports the configured value on this board; real SPD needs SMBus and is Phase 9 |
| Windows power plan flagged when not High Performance | Not flagged on desktop Zen 4/5 | AMD recommends Balanced there; flagging it would be the first false positive a Ryzen owner sees |
| Ryzen Master SDK for CPU detect | Not used | LHM already exposes PPT/TDC/EDC and clocks; no need for a flaky SDK even for detection |
| "Admin is required" (whole app implied) | Only the collector is elevated; ETW can be unelevated via Performance Log Users | Chromium should not run as admin; this user is already in the group |
| PresentMon hosted by the collector (§4 diagram) | PresentMon hosted by Electron main (`electron/presentmon.ts`), unelevated | Phase 4 was built while another workflow owned `collector/`; PresentMon needs no elevation for a Performance Log Users member and stamps its own QPC, so correlation with the collector's sensor window is unchanged. Elevated games show as `<unknown>` — revisit if that bites. |
| Monitor window: "disable GPU acceleration for the monitor window" | Whole app has GPU acceleration off | Electron only supports the switch app-wide before `ready`; nothing here needs a GPU |
| Stress worker unspecified | ComputeSharp (DX12) second .NET exe | Vendor-neutral, deterministic, no CUDA toolkit |
| Rollback on next app launch | Plus a logon scheduled task | The user might never reopen the app after a bad hang |
| Four capabilities (lists five) | Five | Counting |
| Open source | Public repo, MIT | Stated explicitly because the other Strata repos are private |
