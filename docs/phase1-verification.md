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

# Phase 1 polish — dev box, 2026-09-16

The nine items in `.claude/workflows/phase1-polish.md` (the user's feedback on the live app
beside Ryzen Master and GPU Tweak III), built after PR #2 by a collector agent and a UI agent
against contracts written first in `src/collector-types.ts`, `src/settings.ts` and
`src/analysis/audit.ts`, then integrated here. Same box as above; driver 616.92, BIOS 2.AC4.

## Gates

| Gate | Result |
|---|---|
| `dotnet build collector\StrataTune.sln -c Release` | 0 warnings, 0 errors (Shared, Collector, Worker, Bench) |
| `npm run typecheck` | clean over the whole tree, the concurrent Phase 3 files included |
| `npm test` | 14 files, 251 tests (the Phase 1 suites: audit rules incl. the five CPU rules, the PBO inference at 245 W over a 230 W stock PPT, the offsets fixture at +150/+500 MHz, the Monitor render suite over the dev box's sensor tree) |
| `npm run build` | renderer, main process and the report template |
| `STRATA_SELFTEST=1 npx electron .` | `ok: true`, `hardwareAccelerationDisabled: true`, renderer SwiftShader, Electron 34.5.8 |
| Contract check | `GpuFacts.pciSubsystem` / `clockOffsets`, `LoadKind` `'cpu'`, `LoadRun.cpuSamples`, `Health.warming` / `Tick.warming`: the C# records in `collector/StrataTune.Shared` and the TS types agree field for field, and the UI reads exactly those names (`vendors.ts`, `audit.ts`, `Monitor.tsx`, `cache.ts`). Settings `cpuPptW`, `panelNames`, `monitorLayout`; audit ids `cpu-thermal`, `cpu-allcore-clock`, `cpu-package-power`, `cpu-smt`, `cpu-idle-clock`, `gpu-oc-offsets`, `gpu-power-limit` (renamed from `power-limit-headroom`) are the ones the Audit page links and the tests assert. |

## Found and fixed while integrating

- **The CPU load drew 138 W on a 230 W part.** The worker's first `--cpu-load` was a scalar
  integer chain with one dependency per step, so each core ran a fraction of one ALU: the
  collector agent's 8 s run peaked at 154 W and the UI agent's 20 s audit run averaged 138 W,
  which left the package-power rule with nothing to say and made the PBO inference (over
  230 × 1.05 W) unreachable on the very box it was written for. `CpuLoad.cs` is now the
  logistic map over eight independent float vectors per thread (AVX-512 FMA on this box,
  AVX2 FMA or scalar elsewhere; chaotic so the bits keep toggling, bounded so nothing goes
  denormal). Unelevated check: 32 threads, 100 % processor time, ~5.1 G 512-bit ops/s per
  thread (both FMA pipes full), clocks at 125 % of nominal. The elevated numbers are below.
- **NVML clock offsets: the core offset lives under GRAPHICS, not SM.** An unelevated
  `nvmlDeviceGetClockOffsets` probe (`nvmlClockOffset_v1_t`, version `(1 << 24) | 24`) on
  the RTX 5090: type GRAPHICS answers with a −1000…+1000 MHz range, MEM with −2000…+6000,
  SM and VIDEO answer `NVML_ERROR_INVALID_ARGUMENT` (2), at every pstate. The collector's
  SM-then-GRAPHICS fallback worked by accident and its comment claimed the reverse; it now
  asks GRAPHICS first. The live offsets read 0 / 0 with GPU Tweak III not running, and the
  first version of this note took that as "no overclock". It is not: the same runs held
  3226–3232 MHz SM and 16032 MHz memory under load against the driver's own ceilings of
  3090 / 14001 MHz (`nvmlDeviceGetMaxClockInfo` SM / MEM, re-read unelevated 2026-09-16:
  max GRAPHICS 3090, SM 3090, MEM 14001; offsets GRAPHICS 0, MEM 0, SM INVALID_ARGUMENT),
  so the card is overclocked by a route the offsets API does not report (the vendor tool's
  VF curve, applied at boot). The polish fix pass carries both ceilings in `GpuFacts.
  clockOffsets` (`maxClockSmMhz` / `maxClockMemMhz`, the driver's clock-table top, never
  the board's rated boost) and the audit judges the held clocks against them; the fixture
  reads 3090 / 14001 and the wording is "the driver reports no clock offsets", never a
  fact about the card.
- **The Monitor waited for the slowest source.** The collector's staged start opens the
  CPU, board and GPU groups within 0.5 s but `warming` only ends after PDH, whose first
  `PerformanceCounterCategory` call costs ~4.5 s (t+2.9 s → t+7.4 s in every log), and the
  Monitor re-fetched the sensor list only then: the board, the fans and the 12V-2x6 pins
  appeared 7.4 s after launch. It now re-fetches whenever a tick during warming is wider
  than any before it (each group that opens widens the tick) and once more at the tick that
  ends warming; only the newest fetch may land.
- Windows Smart App Control refuses the loose `dotnet build` output on this box (CodeIntegrity
  3077, `0x800711C7`) and accepts the single-file bundle from `scripts/build-collector.ps1`;
  the app runs the newer of the two in development (README), so a publish after a build is
  the way through. The UI agent lost two UAC prompts to it before the rule was in place.

## The real app, end to end (2026-09-16, 08:08–08:14 UTC)

One elevated launch, the user at the machine, the app driven over the Chrome DevTools
Protocol from a fresh profile (`--user-data-dir` under the scratchpad, so the user's own
settings were not touched). The collector was the published bundle.

**Start-up, from the collector log (`t+X` lines, item 8):**

```
t+0 ms     start pid 33064 version 0.1.0 parent 32996
t+62 ms    listening on 127.0.0.1:62752, handshake written
t+95 ms    NVML open, driver 616.92
t+101 ms   lhm driver open, sampling; groups follow
t+158 ms   lhm cpu open
t+461 ms   lhm motherboard open
t+705 ms   lhm gpu open
t+3019 ms  lhm memory open
t+3222 ms  lhm storage open
t+7715 ms  PDH open
t+7716 ms  warm: every source has opened
```

The app's stream client connected at t+217 ms (08:08:58.303 against t+0 at 08:08:58.086),
so the first tick reached the renderer inside the 1.5 s budget; the 15 September run was
connected 9.7 s after the click. On the Monitor page the 12V-2x6 pins and the board fans
appeared 333–440 ms after the page opened (the wider-tick re-fetch; before the fix they
waited for PDH at 7.7 s). The wall-clock from the launch to the driver's first "connected"
was 20 s, all of it the UAC prompt and the driver's own start; the collector took 2.9 s
from the launch to its `t+0`, which is the prompt plus the single-file host's start.

**Monitor (1920 × 1080 and 1280 × 800, screenshots `int-monitor-*.png`, `int-gpu-*.png`):**

- Header strip: `CPU AMD Ryzen 9 9950X 16-Core Processor · GPU ASUS · GeForce RTX 5090 ·
  Board MSI MAG X870E TOMAHAWK WIFI (MS-7E59)`, then `PPT 300 W` once set, session time,
  `CONNECTED`, the gear. Panel headers in the vendor colours: `CPU AMD RYZEN 9 9950X
  16-CORE PROCESSOR` (AMD red), `GPU ASUS · GEFORCE RTX 5090 driver 616.92` (NVIDIA green;
  the partner from PCI subsystem vendor 0x1043, device 0x89EC), `BOARD MSI MAG X870E
  TOMAHAWK WIFI (MS-7E59) BIOS 2.AC4 · 2026-09-02` (MSI crimson).
- GPU schematic live: Fan 1 1163 rpm 46 % and Fan 2 1135 rpm 48 % as duty arcs, VRAM
  28.9 / 31.8 GiB as chip fill (two Ollama models resident), MEM 38 °C · 7001 MHz, DIE
  26 °C · 0.890 V · 1342 MHz, engines 3D and Copy (the idle rows collapsed), PCIe 5.0 ×16
  edge with RX 31.1 MB/s · TX 9.0 MB/s sparkline, 12V-2x6 stub 60 W. Pins block: 0.8–0.9 A
  per pin, 9–10 W, 12.15–12.16 V, spread 0.08 A · 10 %, max/mean 1.04×, connector 4.9 A
  60 W of 600. Perf-limit pill `idle (0x400)`. Bars in two columns; the "Bus" row is gone
  (LHM's NVAPI bus-utilisation domain reads 57–100 % on this idle card, so it misled).
- CPU Package bar `59.6 W of 230 W stock` before the limit is set, `68.7 W of 300 W` after.
  Board fans: `0 rpm` with `no tacho at 100 %` on its own muted line, `PUMP FAN #1 2933 rpm
  76 %`, `8 HEADERS UNUSED`; nothing clipped. `main.scrollWidth == clientWidth` at both
  widths; at 1920 × 1080 `scrollHeight == clientHeight` (1004), so no empty band.
- Move, rename, persist: the CPU header dragged onto the Board panel gave the order gpu,
  power, board, cpu (`monitorLayout` `[{gpu,3,rows 2},{power,3},{board,6},{cpu,3}]`); the
  GPU panel renamed to `ROG Astral LC RTX 5090` (pencil → inline edit → Enter) updated the
  header and the strip (`panelNames['/nvml/0']`). After `Page.reload` the order and the
  name came back identical. Reset layout and an emptied name restored the defaults.

**Audit, 51 s, five steps, nothing skipped** (snapshot, 5 s idle sample, 3 s light PCIe
load, 20 s heavy thermal ramp, 20 s CPU all-core load; `int-audit-*.png`):

```
[warn]    cpu-thermal        The CPU held 95 °C under the all-core load, 0 °C from its 95 °C limit, with clocks holding (5360 to 5356 MHz effective). Ryzen boosts until it meets its limit, so this is by design under an all-core load; games load it less.
[info]    cpu-allcore-clock  All-core 5.4 GHz effective under load (spec base 4.3 GHz, single-core boost 5.7 GHz).
[info]    cpu-package-power  PBO / raised PPT active — measured 264 W over the stock 230 W; set your PPT limit here.   [Set the CPU power limit]
[ok]      cpu-smt            16 cores, 32 threads: SMT on.
[info]    cpu-idle-clock     Idle: 677 MHz effective while the cores report up to 5725 MHz; the effective figure is the real rate, the other is the boost the cores stand ready to reach.
[info]    gpu-power-limit    Power limit slider is at its maximum (600 W) — nothing to raise there. Clock and memory offsets are a separate lever.
[ok]      gpu-oc-offsets     No clock offsets applied; held 3226 MHz under load (spec boost 3090).
[ok]      thermal-headroom   Power-limited at 600 W, normal: clocks held (3226 to 3226 MHz) at a peak of 49 °C with the card at its 600 W limit.
[warn]    background-hogs    Busy while idle: llama-server (0 % CPU, 3.7 GB).
[info]    ai-model-resident  qwen3.8:27b holds 17.5 GB of VRAM and qwen3:4b holds 12.7 GB of VRAM; fine for AI work, costs games headroom.
[ok]      expo               Running at 6200 MT/s, rated 6000 MT/s (G.Skill).
[ok]      ram-channels       Two modules in DIMMA2 and DIMMB2: one per channel.
[ok]      pcie-link          PCIe 5.0 x16 under load, the most this card and slot can do.
[ok]      rebar              On: the CPU can address all 32 GB of video memory at once (BAR 32768 MiB).
[ok]      power-plan         Balanced: AMD recommends the Balanced plan for Ryzen, because it lets idle cores sleep and boosts faster than High performance.
[ok]      boot-drive-space   C: has 715 GB free of 1081 GB (66 %).
[ok]      gpu-driver-age     Driver 616.92, 12 days old.
[unknown] game-on-hdd        Checked when a game is captured.
```

The CPU load's samples through the collector API (a separate 20 s run on the same build,
2 Hz): idle reference 64 W · 44 °C · 452 MHz effective; the worker starts ~2.3 s after the
request (the single-file host), power 181 W at 2.6 s, 265 W at 3.1 s, then 262–270 W for
the rest with Tctl at 95.25 °C from 4.6 s on and the effective clock 5384 → 5352 MHz
(0.6 % sag): with a 300 W PPT this 9950X is capped by its cooler, not its power limit,
which is what the thermal and package-power rows say together. The `Set the CPU power
limit` button on the package-power card opened the Monitor with the settings popover;
`300` + Enter made the bar `of 300 W` with no stock tag and put `PPT 300 W` in the strip.

**Close.** `window.strata.close()` → `POST /shutdown from the UI` at 08:13:55.857, `exit 0`
at 08:13:55.882; no `electron`, `strata-tune-collector` or `strata-tune-worker` process
6 s later, `collector.json` removed, no `orphan.log`.

**Shared-collector note.** Another app instance (default profile, no debug port) held the
single-instance lock from 07:58 to 08:08 with its own collector; the app reuses a live
collector rather than launching another, and one instance's `/shutdown` ends it for the
other. Nothing here changes that; a second instance is a developer situation.

# Phase 1 polish — fix pass, dev box, 2026-09-16

The reviewers' findings on the polish (`.claude/workflows/phase1-polish.md`, items 3, 4, 6
and 7 and the collector's warm-up) fixed and re-verified. Same box; the user's own app
instance (default profile, collector pid 23336 from 08:26 UTC) was running throughout and
was left alone.

## Gates

| Gate | Result |
|---|---|
| `dotnet build collector\StrataTune.sln -c Release` | 0 warnings, 0 errors |
| `npm run typecheck` | clean over the whole tree |
| `npm test` | 16 files, 309 tests (new: `tests/layout.test.ts`, `tests/settings.test.ts`; the audit, monitor and render suites extended) |
| `npm run build` | renderer, main process and the report template |

## What changed, and the evidence

- **Layout holes (item 3).** `placeLayout` in `src/components/monitor/layout.ts` packs the
  panels densely and gives every panel an explicit grid cell; the GPU panel's two-row span
  is honoured only while the panels after it fill both rows beside it, otherwise it takes
  one row. Real app over CDP, 1920 × 1080 at DPR 1: default `holes 0`, `scrollHeight ==
  clientHeight` (1004); the integration run's moved order (gpu, power, board, cpu) now
  places the CPU panel at row 2 column 4 beside the GPU panel, `holes 0`, no scroll
  (`polish-real-monitor-moved-1920.png`). Holes remain only where the spans cannot tile
  (a CPU panel dragged to four columns after the full-width board: two cells, by the
  user's own arrangement; reset is one click). A saved layout with `rows: 2` still parses;
  the layout survives a reload and Reset layout restores the default.
- **Chip text (plan 17a's 11 px floor).** `chip-label` / `chip-nominal` 8 → 10 px in the
  diagrams' own units; the GPU schematic takes 42 % of its panel (300–380 px) and the CPU
  chip 40 % (280–340 px). Rendered at 1920 × 1080, DPR 1: label and nominal 12.7 px, figure
  13.9 px, big 19 px; at 1280 × 800 the diagrams sit at their natural size (10 / 11 / 15 px).
  The die block is 80 units wide so "hot spot N °C" fits when a driver exposes it.
- **CPU panel at 1280.** One `.split` threshold (560 px) for both panels; bar rows are a
  `.bar-row` class with a fixed 9 rem figure column (every track in a column ends on the
  same line: the GPU column's six tracks all end at x = 1269) and a compact form under a
  360 px column (7.5 rem label, 3 rem track minimum, 5.5 rem figure, the "of N W" on its
  own line). At 1280 the chip (280 × 202) sits beside the bars (296 px column, compact);
  the GPU bars go to two columns from 560 px, so the GPU panel is 534 px tall there
  instead of ~700.
- **12V-2x6 block (item 4).** Plain DOM: six pin columns fill the panel's right column
  (516 px at 1920, 282 at 1280) with the bars scaling and the figures fixed at 12 / 10 px;
  the pin number above, A / W / V beneath, and each pin's 60 s current as a sparkline under
  that; spread and max/mean sit over the pins; idle pins are slate, like the figures;
  "12V-2x6" keeps its case. The connector bar is watts when sensed, else amps against
  50 A, never amps × 12; the schematic's stub says "12V-2x6 N A" in that case.
- **AMD red under load.** The chip cells' load fill tops out at 0.36 opacity of the vendor
  colour (a tint), and a die's amber/red outline is 1.5 px, so at 100 % load the amber CCD
  outlines and the red Package figure read against dark-red cells (harness,
  `polish-monitor-load-1920.png`).
- **CPU thermal card.** The Ryzen pinned-with-clocks-holding branch keeps `warn` (plan §8)
  but carries its own cost text ("Nothing lost now: the clocks held, but there is no
  headroom left…") and fix ("Nothing required; a lower PPT or a Curve Optimizer undervolt
  in the BIOS buys headroom…", no fix tag); the repaste advice is the `bad` branch's alone.
  Real audit on this box: `[warn] cpu-thermal … 5354 to 5347 MHz effective … by design`,
  with exactly those texts.
- **GPU overclock (item 7).** The audit judges the held clocks against the driver's
  ceilings (see the corrected note above); with the polished collector the row on this
  box reads "The driver reports no clock offsets, yet the card held 3230 MHz core /
  16032 MHz memory under load, above its 3090 / 14001 MHz maximums: an overclock is
  applied by another route (a vendor tool or a VF curve)" (unit test over the measured
  numbers). The real run below went through the user's live collector, which predates
  the field rename, so its row read "The driver reports no clock offsets; held 3230 MHz
  under load." — no ceiling, no claim.
- **Settings.** `updateSettings` merges over a fresh `loadSettings()`; `tests/settings.test.ts`
  interleaves a Monitor write, the Advisor's `saveSettings` and another Monitor write and
  finds every field intact.
- **SMT from the table.** `cpus.json` rows with `threads === cores` (Core Ultra 200-series)
  answer "this part has no SMT"; equal counts on a part the table lists with more threads
  is "off" with the BIOS fix; an uncounted part is hedged.
- **Collector.** The warming task is `try / catch / finally`: a source that throws is a
  logged gap and `Warming` always ends; `NvmlSampler` is constructed through `Open()`;
  every non-success code from `nvmlDeviceGetClockOffsets` is null for that field (logged
  once) rather than a throw that costs the card; warming ends only after the LHM sampler
  has completed two more samples past the last group (bounded at six periods), and
  `OpenGroups` holds a gate per stage that `Dispose` also takes, so a quick close never
  runs `Close()` under a group constructor. **Not exercised on this box in this pass:** two
  elevated launches of the polished bundle (`scratchpad/collector-polish`) timed out
  unanswered at the UAC prompt (122 s each, nobody at the machine); the build is clean
  and the wire fields were confirmed from the driver unelevated.
- Also: the hogs rule words a working-set-only process as "holds N GB while idle" and
  skips Ollama's runner when the AI-model finding already names it; the package-power fix
  points at the Monitor gear and the button under the card; the Audit's machine line uses
  the panel's name and " / "; the cost text is UI-font and hidden when the detail already
  says it; the System Power header lost its roadmap note; the board's CPU-named
  temperature is judged against Tjmax like the CPU panel (tick at 95 °C).

## The real app (UI side, 2026-09-16 09:16–09:18 UTC)

A second Electron instance (`--user-data-dir` under the scratchpad, `--remote-debugging-port`)
adopted the user's live collector ("Connected (reusing a running collector)"), so no UAC
prompt and the user's instance untouched; it was ended with `Stop-Process`, not
`/shutdown`, for the same reason. Log: `shots/polish-real-run.log`; screenshots
`polish-real-*.png` (1920 default, moved, resized, 1280, the GPU and CPU panels at 2×,
the Audit page).

```
default order: cpu@12,92 942x367 [1 / span 1 | 1 / span 3]  gpu@966,92 942x557 [1 / span 2 | 4 / span 3]  power@12,471 942x178 [2 / span 1 | 1 / span 3]  board@12,661 1896x371 [3 / span 1 | 1 / span 6]
default holes: {"rows":3,"holes":0} overflow: {"sw":1920,"cw":1920,"sh":1004,"ch":1004}
rendered chip fonts at 1920 (DPR 1): {"chip-label":"12.7px","chip-nominal":"12.7px","chip-figure":"13.9px","chip-big":"19.0px","pinFigure":"12px"}
pins: 1 0.9 10 W 12.2 V | 2 0.9 11 W 12.2 V | 3 0.9 11 W 12.2 V | 4 0.9 11 W 12.2 V | 5 0.9 10 W 12.2 V | 6 0.8 10 W 12.2 V
spread: Spread0.06 A · 7 % · Max/mean1.03×
bar right edges (gpu column 1): 1269,1269,1269,1269,1269,1269
board CPU Core row: CPU Core44.0 °C tick=true
moved order: gpu@12,92 942x557 [1 / span 2 | 1 / span 3]  power@966,92 942x178 [1 / span 1 | 4 / span 3]  board@12,661 1896x371 [3 / span 1 | 1 / span 6]  cpu@966,282 942x367 [2 / span 1 | 4 / span 3]
moved holes: {"rows":3,"holes":0} overflow: {"sw":1920,"cw":1920,"sh":1004,"ch":1004}
1280 cpu split: chip 280x202 at 25,137; first bar at 321,137 width 296 cols=120px 64.3333px 88px
audit took 53 s
  [warn] cpu-thermal: The CPU held 95 °C under the all-core load, 0 °C from its 95 °C limit, with clocks holding (5354 to 5347 MHz effective). Ryzen boosts until it meets its limit, so this is by design under an all-core load; games load it less.
      cost: Nothing lost now: the clocks held, but there is no headroom left for a hotter room or a longer load.
      fix (none): Nothing required; a lower PPT or a Curve Optimizer undervolt in the BIOS buys headroom at little cost.
  [ok] gpu-oc-offsets: The driver reports no clock offsets; held 3230 MHz under load.
  [info] cpu-package-power: PBO / raised PPT active — measured 261 W over the stock 230 W; set your PPT limit here.
      fix (app): Enter the limit you set in the BIOS or Ryzen Master with the button below (Monitor page, gear > CPU power limit (PPT)), so the Package bar and this check use it.
  [ok] ai-model-resident: Ollama is running but holds no model.
```
