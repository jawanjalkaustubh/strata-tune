# PC Tuning & Diagnostics App — Technical Spec

Free, open source, offline. No telemetry, no accounts, no cloud calls.

Four capabilities on one shared data layer:

1. **System audit** — static misconfiguration, no benchmark needed
2. **Stutter analysis** — what caused each hitch, and whether it's fixable
3. **Whole-system power** — measured where possible, estimated where not, always labelled
4. **OC auto-tune** — find stable values automatically, with crash rollback
5. **Local AI model advisor** — what models this machine can actually run, and how fast

---

## 1. Core architecture

Everything feeds **one timeline**. This is the design decision that matters most — the reference tool only has frame data, so it can tell you a stutter happened but not that your GPU was thermal throttling at that exact moment. Correlation across streams is the entire advantage.

```
Collector (background service, elevated)
  ├─ PresentMon ETW session      → frame events, per-present
  ├─ LibreHardwareMonitor        → sensors @ 1–10 Hz
  ├─ Windows perf counters       → disk queue, per-process CPU, page faults
  └─ Static config snapshot      → captured once at session start
              ↓
      Ring buffer (timestamped, single monotonic clock)
              ↓
      Analysis pass (runs after capture, not during)
              ↓
      HTML report + in-app view (same renderer)
```

### Rules

- **One clock.** Use `QueryPerformanceCounter` for every sample. Do not mix wall-clock and ETW timestamps.
- **Analysis is offline.** Collection stays cheap and dumb — buffer only. All classification runs after the session ends so the tool never becomes the cause of a stutter.
- **Ring buffer sized by time, not count.** Default 10 minutes at full rate; older data downsampled to 1Hz summary rows.
- **Report output is a standalone HTML file.** Same renderer as the in-app view. Shareable — someone posting their report in a Discord thread is the distribution model.

### Dependencies

| Need | Use | Why |
|---|---|---|
| Frame timing | Intel **PresentMon** (ETW-based) | No injection, no overlay, so it won't trip anti-cheat |
| Sensors | **LibreHardwareMonitor** | Ships a signed kernel driver — do not write your own |
| GPU control | **NVAPI** (NVIDIA) / ADL (AMD) | Clock offsets, power limit, VF curve |
| CPU control | Ryzen Master SDK — *detect only* | Flaky, AMD changes it constantly. Guide to BIOS instead. |

**Admin is required** for the PresentMon ETW session. This shapes the installer — plan for elevation from day one, and test against at least one live anti-cheat title before building much on top.

---

## 2. System audit (ship this first)

Runs in seconds, needs no game running, cannot damage anything. This alone is a complete v1.

Each check outputs: **state → estimated cost → plain-English fix**.

| Check | How | Typical cost if wrong |
|---|---|---|
| EXPO/XMP enabled | Compare SPD rated speed vs actual | 10–15% in CPU-bound games |
| RAM slot population | SPD slot map | Up to 20% if in wrong pair |
| GPU PCIe link | NVAPI current link width/gen | 2–8% if running x8 or Gen3 |
| Resizable BAR | NVAPI BAR state | 0–10%, title dependent |
| Windows power plan | Power scheme GUID | Large on laptops, small on desktop |
| Boot drive free space | Volume query | Severe past ~90% full |
| Game on HDD not SSD | Path → physical disk type | Traversal stutter |
| Thermal headroom | Idle vs load delta over a short ramp | Throttling, fan noise |
| GPU driver age | Driver version vs install date | Occasional title-specific bugs |
| Background CPU hogs | Per-process sampling at idle | Varies |

Rank output by estimated cost. **Show at most five items.** A list of twenty findings gets ignored; five ranked ones get acted on.

---

## 3. Stutter analysis

### Detection

A frame is a stutter when **either**:

- `frame_time > 2.0 × rolling_median(last 120 frames)`, **or**
- `frame_time > 50ms` absolute

Rolling median rather than mean — a single 200ms hitch shouldn't hide the next one. Ignore the first 300 frames of a session (level load).

Also report separately, since these are different problems:
- **Stutter count and % of playtime lost** — the hitch problem
- **Frame pacing consistency** (stdev of frame time when no stutter present) — the "feels bad at high FPS" problem

### Classification

This is the product. A spike is just a spike until you say *why*. Evaluate in this order, first match wins:

| # | Signature | Verdict | Fixable? |
|---|---|---|---|
| 1 | GPU busy spike, CPU idle, first visit to area, decays over session | **Shader compilation** | Temporary — plays out in ~30 min |
| 2 | Clock drop + GPU temp ≥ throttle limit | **Thermal throttle** | Yes — fan curve, dust, case airflow |
| 3 | Clock drop + power draw at limit, temps normal | **Power limit** | Yes — raise power limit |
| 4 | VRAM allocation ≥ 95% of total, spike on new assets | **VRAM exhaustion** | Yes — lower texture quality |
| 5 | Disk queue depth spike concurrent with frame spike | **Storage bottleneck** | Yes — move to SSD, free space |
| 6 | Another process CPU spike concurrent | **Background process** | Yes — name the process |
| 7 | Inter-stutter interval has low variance (regular period) | **GC / streaming tick** | No — engine behaviour |
| 8 | CPU busy spike, GPU waiting, no other correlation | **Engine / asset streaming stall** | No — how the game was built |
| 9 | Alternating long/short frames, no resource correlation | **Pacing / sync issue** | Yes — cap framerate, check vsync/frame gen |

Attach a **confidence** to each: high when two or more signals agree, low when it's a single weak correlation. Show confidence in the report — an honest "probably" beats a confident wrong answer.

### The verdict that matters

The most valuable output is **"no setting on your end changes this."** Cases 7 and 8 mean stop fiddling. Nothing else on the market tells people to stop, and it's what earns trust in a tool that also offers to overclock their GPU.

Report structure: headline verdict → cause breakdown by % → what to actually do → raw measurements at the bottom for people who want them.

---

## 4. Whole-system power

The gap: you can see CPU and GPU watts in several tools, but total system draw requires a PSU with telemetry. Everything below is about closing that gap honestly.

**Rule: every number is tagged `measured` or `estimated`, visibly, in the UI.** One unified number with no provenance and the first person with a smart plug posts a screenshot showing you're 40W off.

### Measured

| Source | Method | Accuracy |
|---|---|---|
| CPU package (PPT) | SVI3 telemetry via LHM | Good |
| GPU board power | NVAPI total board draw | Good |
| VRM input power | Some boards expose it | Board dependent |

CPU + GPU is 80–90% of the variance in a gaming rig, so measuring those two carries most of the weight.

### Estimated

- **RAM** — DDR5 moved the VRM onto the DIMM and PMIC telemetry isn't exposed. Model from module count and load.
- **Drives** — per-device idle/active model, weighted by queue depth
- **Fans, RGB, chipset, USB** — count devices, apply a flat model

### Wall watts

```
wall_watts = (measured_dc + estimated_dc) / psu_efficiency(load_fraction)
```

Ask for PSU model once. Ship an efficiency curve table keyed by 80+ rating (Bronze/Gold/Platinum/Titanium) and load point. Gets within a few percent.

### Features this unlocks

- **"Do I need a bigger PSU?"** — peak sustained draw vs their rated PSU, from their own data. Most-asked question on every PC forum, never answered with real numbers.
- **Electricity cost** — watts × hours × local rate, entered once
- **Performance per watt** — feeds directly into OC mode. *"You gave up 2% FPS and saved 90 watts"* is the argument that sells undervolting, and nothing else makes it.

### Stated limitation — put this in the UI, not the footnotes

Polling runs at 1–10Hz. The transient spikes that trip PSU overcurrent protection and cause random shutdowns happen in **microseconds**. This tool cannot see them. A clean power graph does not mean a healthy PSU. Say so plainly.

---

## 5. OC auto-tune

Replaces the manual loop: nudge clock → stress → hang → reboot → repeat. Opt-in, behind a warning, and last to ship.

### Two corrections to the manual method

**Fans at 100% finds a false ceiling.** Silicon needs more voltage as it heats. A value validated cold at max fan will hang 40 minutes into a real session on a normal fan curve. This is exactly why manual OCs feel stable and then aren't.

> **Two-phase validation:** hunt the ceiling fast with fans high, then **re-validate at the user's actual fan curve under sustained load** and ship *that* number. The shipped value is always the thermally-honest one.

**Memory doesn't crash when overpushed.** GDDR6X/7 error-corrects silently and just gets slower. "It didn't crash" is the wrong test.

> **Test memory by effective bandwidth, not stability.** Sweep upward, measure bandwidth at each step, and back off to the last point where bandwidth was still *rising*. The peak of that curve is the real limit.

### Stability detection — catch it before the hang

You don't prevent hard hangs, you arrange for **softer failures to trip first** and make the rare hang cheap. GPU instability degrades in stages:

| # | Stage | Detection | Cost to user |
|---|---|---|---|
| 1 | Silent compute/memory error | Run a deterministic kernel, hash output, compare against a known-good hash captured at stock clocks | Nothing — no crash at all |
| 2 | Bandwidth regression | Throughput *drops* as memory retries and corrects | Nothing |
| 3 | TDR (driver reset) | Windows resets the driver after a ~2s GPU hang. Display event 4101. Worker dies, system lives | ~5 seconds |
| 4 | Hard hang | On-disk PENDING flag, caught at next boot | A reboot |

Step upward in coarse increments and stop at the **first** stage that trips. Done properly you rarely reach stage 4. Stage 1 is the primary detector — it's the same approach memtest_vulkan uses, and it catches instability with nothing crashing.

**Two-process design.** The supervisor never touches the GPU. A disposable worker process runs the stress and writes a heartbeat every 2s. Worker TDRs or dies → supervisor records "unstable at X", no reboot, continue to the next candidate. This converts most failures from a reboot cycle into a five-second event.

**Three load patterns per candidate.** VF curve instability usually appears at *low* load, not maximum — the low-voltage points on the curve are the fragile ones, which is why an undervolt survives an hour of furmark and then crashes on the desktop.

1. Sustained heavy load
2. Light / near-idle
3. Rapid transient switching between the two

Testing only heavy load is the single most common reason a manually-found undervolt feels stable and isn't.

**Bisect, don't linear-scan.** Far fewer crash cycles to reach the same answer.

**Residual risk, stated to the user up front:** some settings will still hard-hang. Budget one or two across a full tuning run. That's what the PENDING flag exists for.

### Live monitor during tests

While a test runs, the user sees what the machine is doing. This lives in the **supervisor** process, so it survives worker crashes and can show the moment a TDR happened rather than dying with it.

**Displayed live (2Hz is plenty):**

| Group | Fields |
|---|---|
| Power | Total system W (tagged measured/estimated), CPU package W, GPU board W |
| Clocks | GPU core requested vs *effective*, GPU memory clock, CPU max core clock |
| Thermals | GPU core, GPU hotspot, GPU memory junction, CPU package, fan RPM/% |
| Limits | **NVAPI perf-limit reasons** — power / thermal / voltage / reliability |
| Memory | VRAM used vs total |
| Test state | Current candidate value, ladder position, load pattern (heavy/light/transient), elapsed, error count, measured bandwidth |

**Perf-limit reasons are the highlight.** NVAPI exposes exactly why the GPU isn't running faster, and almost nothing surfaces it plainly. It turns "why am I not hitting my clocks" from a forum question into a label on screen.

**Requested vs effective clock** is the other one — the gap between them *is* throttling, visible at a glance without reading a temperature chart.

### The monitor must not perturb the test

Rendering a dashboard on the GPU being stress-tested contends with the test, skews bandwidth numbers, and can cause false instability readings.

- **Disable GPU acceleration for the monitor window.** CPU-rendered, plain widgets.
- **2Hz refresh, no animation, no WebGL/canvas charts during an active test.** Rich charts belong in the post-run report.
- Sensor polling already runs for the collector — the UI reads that buffer, it does not open its own sensor sessions.
- Show a **test validity indicator**: if the GPU is thermal or power throttling during a ceiling hunt, the result is invalid. Say so on screen rather than shipping a bad number.

### Flight recorder

Continuously write the last 30 seconds of the timeline to disk during any test, flushed every second.

After a hard hang, the user reboots and the app shows what temps, clocks, power draw and limit flags were doing in the seconds before the machine died. Cheap to implement, and it's the difference between "it crashed" and "it crashed at 1.02V with memory junction at 94°C."

### Rollback state machine

The thing that separates a tool people trust from one that ruins a weekend. Afterburner will happily apply a curve that crashes on boot and leave you to work it out.

```
States: KNOWN_GOOD → PENDING → VALIDATING → KNOWN_GOOD
                         ↓ (crash)
                    REVERTED
```

1. Persist candidate setting to disk with `PENDING` **before** applying
2. Apply setting
3. Run stress test under a watchdog (heartbeat file every 2s)
4. On clean completion → mark `VALIDATING`, require one clean shutdown
5. On next launch: flag still `PENDING`/`VALIDATING` → **the machine hard-crashed**. Revert to last `KNOWN_GOOD`, tell the user exactly which setting did it.
6. Only after a clean boot following a clean shutdown → promote to `KNOWN_GOOD`

Never test more than one variable at a time. Bisect, don't linear-scan — far fewer crash cycles.

### What's actually controllable

| Component | Reach | Approach |
|---|---|---|
| **GPU core/mem/power/VF curve** | Full, via NVAPI | Fully automated |
| **CPU (PBO, Curve Optimizer)** | Partial, unreliable SDK | Detect state, guide to BIOS with exact steps |
| **RAM / EXPO** | None — BIOS only | Detect it's off, quantify the loss, guide |

**Start with undervolting, not overclocking.** Same practical gains, fails safe (an undervolt that's too aggressive crashes but degrades nothing), and it's the honest default for a tool whose first release is about *not* breaking things.

### Output

Produce a copy-pasteable value set for Afterburner / GPU Tweak, so people who don't trust the tool to apply settings can still use the results. This also makes the tool useful to people on hardware you don't support yet.

---

## 6. Local AI model advisor

"What can my PC run?" is asked constantly and every answer online is a guess from a spec sheet. This machine already has the sensor layer — it can just read the answer off the hardware.

### Inputs

- VRAM total and currently free
- System RAM total and free
- GPU architecture and supported precisions (Blackwell adds FP8/FP4 paths)
- GPU memory bandwidth
- Free disk space on the model directory's drive
- CPU core count (for offload throughput)

### VRAM requirement model

```
weights_bytes   = params × bytes_per_weight

  FP16   = 2.0     Q8  ≈ 1.0     Q6_K ≈ 0.82
  FP8    = 1.0     Q5_K ≈ 0.70   Q4_K_M ≈ 0.56

kv_cache_bytes  = 2 × layers × kv_heads × head_dim × context_len × kv_bytes
                  (GQA models are dramatically smaller here — check kv_heads, not heads)

overhead        = ~0.6 GB  (CUDA context, activations, fragmentation)
desktop_reserve = ~1.0 GB  (Windows compositor; more if gaming simultaneously)

required = weights + kv_cache + overhead + desktop_reserve
```

### Speed estimate

Token generation is memory-bandwidth-bound, not compute-bound:

```
theoretical_tok_s = memory_bandwidth_bytes_per_s / weights_bytes
realistic_tok_s   ≈ theoretical × 0.6–0.7
```

That single formula is why this feature is useful — it explains *why* a bigger quant is slower, not just that it is.

If the model doesn't fit in VRAM, recompute with the offloaded fraction running at **system RAM bandwidth** (roughly 1/20th of a modern GPU's). This is why partial offload collapses performance, and the report should show that cliff rather than just saying "slow".

### Output buckets

| Verdict | Condition |
|---|---|
| **Runs fast** | Fits fully in VRAM with reserve intact |
| **Runs, tight** | Fits but < 1.5GB headroom — reduce context or expect OOM under load |
| **Runs slowly** | Spills to system RAM — show the estimated tok/s cliff |
| **Won't run** | Exceeds VRAM + RAM |

### Presentation

- Sort by "largest model that still runs fast" — that's the question being asked
- Show **context length as a slider**, since KV cache is often what actually breaks the fit, and people don't realise it
- Include download size and check it against free disk space
- Ship the model table as an editable local JSON file so it stays current without an app update and without a server

---

## 7. System score

Deliberately **not** a speed benchmark. 3DMark and Cinebench already own "how fast is your PC," and a raw-speed leaderboard just rewards whoever spent the most.

> **Score potential realised, not raw performance.** The unanswered question is *"am I getting what I paid for?"* — a number where a well-configured 4060 can beat a misconfigured 5090. That inversion is the appeal and it's what makes the score useful rather than a flex.

### Four subscores

Each one clickable, opening the findings that cost points.

| Subscore | Measures | Source |
|---|---|---|
| **Configuration** | EXPO, PCIe link, ReBAR, power plan, drive space | Section 2 audit — deterministic, no benchmark |
| **Thermals** | Sustained clock vs rated, % of load time throttling | Sensor timeline |
| **Smoothness** | Stutter rate, frame pacing consistency | Section 3 classifier |
| **Efficiency** | Performance per watt | Section 4 power model |

Most people lose the bulk of their points on **Configuration**, which is the point — it's the subscore they can fix in ten minutes without spending anything.

**Engine-caused stutters do not count against the user.** Classifier cases 7 and 8 are excluded from Smoothness. Penalising someone for how a game was built would undermine the one verdict the tool is best at giving.

### Stability caps the total

If validation found compute errors or TDRs, the total is ceilinged regardless of clocks achieved. Without this you've built a scoreboard that rewards pushing unstable overclocks, and eventually someone's machine pays for it.

### Cohort comparison, still no server

- **Day one:** expected values derived from spec — rated TDP, boost clocks, memory bandwidth. Scoring works with zero users.
- **Later:** an anonymised aggregate dataset shipped as JSON through GitHub releases. Opt-in submission only, no accounts, no hosting cost.
- Enables lines like *"your 5090 runs 6°C hotter than typical for this cooler."*

### Validity rules

The score is noise unless these hold:

- **Fixed workload and duration**, identical across runs
- A run is marked **invalid and non-comparable** if the test validity indicator tripped — background load, throttling, or thermal drift during capture
- A silently bad score is worse than no score

### Share card

Compact image: total score, four subscore bars, top fix, hardware summary. This is what gets posted in Discord and Reddit threads, and it's the distribution model for the whole app.

---

## 8. Fix verification and bottleneck verdict

### Prove the fix worked

After any change — EXPO enabled, undervolt applied, texture quality lowered — re-run the identical workload and show the delta.

Nobody currently knows whether their tweak did anything; they just feel like it did. The collector already exists, so this is nearly free to add, and **a tool that proves its own advice is in a different trust category from one that only gives it.**

Store each verified change as a small entry: what changed, measured before/after, date. That history is also what makes the score movement meaningful over time.

### CPU-bound vs GPU-bound

Both utilisation streams are already on the timeline. Report which one is the limiter during the capture.

> *"Your GPU sat at 60% while your CPU was pegged — lowering graphics settings will not help you."*

This corrects the single most common misunderstanding in PC gaming, and it's another instance of the tool's best move: telling people to stop fiddling.

---

## 9. Full sensor view — the HWiNFO layer

Every sensor the machine exposes, available on demand, **behind a button.**

### The principle

The default view is five ranked findings and a score. A button — "All sensors" — opens the complete readout. Power users get everything; everyone else never sees it.

> Giving people 400 unlabelled readings *is* the problem the app exists to solve. Ship the data, just don't make it the front door.

### What it contains

- Full device tree from LibreHardwareMonitor, grouped by component — it already enumerates everything, so this is mostly presentation
- **Min / max / average per sensor** over the session, not just the instantaneous value
- Search and filter box
- **Pin favourites** — pinned sensors appear in the compact bar on the main view, so people can build their own small dashboard without leaving the simple UI
- **"Only show changed"** toggle to hide the dozens of static readings
- **CSV export** of the session timeline for people who want to do their own analysis

### Presentation rules

- Opens as a panel or separate window, never replacing the interpreted view
- Highlight any sensor currently at a limit (throttle, power cap, temp target) in the tree, so the firehose still points at what matters
- Same 2Hz refresh and CPU-only rendering rules as the live monitor when a test is running

---

## 10. Build order

1. **Sensor layer** — LHM integration, ring buffer, one clock
2. **System audit** — ships as a complete, useful, zero-risk v1
3. **Full sensor view** — mostly presentation over the layer built in step 1, cheap to add
4. **AI model advisor** — reuses the sensor layer, no new infrastructure, high shareability
5. **Frame capture + stutter classifier** — the biggest engineering lift
6. **CPU/GPU-bound verdict** — falls out of the classifier work for almost nothing
7. **Power telemetry** — layers onto the existing timeline
8. **System score + share card** — needs the audit, thermals, smoothness and efficiency inputs above to exist first
9. **Fix verification** — trivial once the score and a fixed workload exist
10. **OC auto-tune** — last, opt-in, after users already trust the diagnosis

Steps 1–4 are a real product on their own and cannot damage anyone's machine. Earn trust there before shipping anything that writes to hardware.

