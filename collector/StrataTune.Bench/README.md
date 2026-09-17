# StrataTune.Bench — the built-in stutter bench

`strata-tune-bench.exe` is the plan §11a workload: a small DX12 scene behind a real
flip-model swapchain, so PresentMon sees it exactly like a game, playing a fixed 90-second
script whose segments trip specific classifier cases on purpose. Nothing in it varies with the
machine except how long each hitch takes, which is the point: bench results compare across
machines and over time, and the same run is the Smoothness workload of §14 and the before/after
workload of §15.

Vendor-neutral (Vortice.Windows 3.8.3, MIT: `Vortice.Direct3D12`, `Vortice.DXGI`,
`Vortice.D3DCompiler`; the HLSL is compiled at start-up by `d3dcompiler_47.dll`, which ships
with Windows, so the build needs no shader toolchain). No other dependencies; the window is
plain Win32.

## The script

The scene is 4096 instanced cubes over a full-screen background pass, both generated in the
shaders from `SV_VertexID` / `SV_InstanceID` (no vertex buffers), fed by a per-frame constant
buffer. Everything is timed from the run's start, never counted in frames, so the script plays
the same at any frame rate.

| Segment | Full | Short | What it does | Signature |
|---|---|---|---|---|
| warm-up | 0–10 s | 0–2 s | steady scene, paced to the fps cap | ignored (the level-load rule) |
| shader-compile | 10–30 s | 2–6 s | once a second, N new pipeline states are created on this thread and used from then on; N starts at 8 and tails off to 1 (85 states in full, 20 in short). The HLSL is precompiled at start-up, so the hitch is the driver's own compile, like a game entering a new area. A fresh salt per run keeps every variant out of the driver's on-disk shader cache. | case 1, decaying |
| texture-stream | 30–45 s | 6–9 s | five bursts, each committing new 4096² RGBA8 textures (64 MiB each) in VRAM and filling them from a pre-filled upload buffer on the graphics queue. The total is `--vram-target` percent of the adapter's dedicated memory (default 40 %). Freed when the segment ends. | case 4 / 5 where the machine is weak there |
| cpu-stall | 45–60 s | 9–12 s | every 2 s (1 s in short) the render thread spins for 30 ms of real arithmetic with nothing queued for the GPU | case 8, the "not fixable" verdict |
| gpu-load | 60–90 s | 12–15 s | the background pass runs a bounded multiply-add loop whose iteration count is adjusted from GPU timestamp queries until a frame's GPU time is ~10 ms, and the loop then paces frames so the card is busy ~90 % of the time | case 2 / 3 if the cooler or the limit is the issue |

Outside gpu-load the loop is paced to `--fps-cap` (default 120 fps) so the baseline frame time
is the same on every card and the hitches stand out against a machine-independent median.

## Flags

```
strata-tune-bench [--script full|short] [--vsync] [--vram-target PERCENT] [--fps-cap N]
                  [--width W] [--height H] [--adapter LUID] [--json] [--debug]
strata-tune-bench --fillrate [--seconds N] [--width W] [--height H] [--adapter LUID] [--json] [--debug]
```

| Flag | Default | Meaning |
|---|---|---|
| `--script short` | `full` | the 15 s version of the same five segments, for smoke tests |
| `--vsync` | off | `Present(1)`; off presents with `ALLOW_TEARING` when the system supports it |
| `--vram-target N` | 40 | percent of dedicated VRAM the texture-stream segment fills (1–90) |
| `--fps-cap N` | 120 | pacing outside gpu-load; `0` removes it |
| `--width W --height H` | 1280×720 | client area in pixels (the process is per-monitor DPI aware, so this is the swapchain size too) |
| `--adapter LUID` | DXGI high-performance adapter | the luid `strata-tune-worker --devices` prints; the same number the summary reports |
| `--json` | | one JSON line on stdout at exit, nothing else on stdout |
| `--debug` | | D3D12 debug layer when the Graphics Tools feature is installed; its messages land on stderr at exit |
| `--fillrate` | | the pixel-rate measurement instead of the script (below); `--vsync`, `--vram-target`, `--fps-cap` and `--script` do not apply |
| `--seconds N` | 6 | seconds of measured fill after the 1 s warm-up, 1–60; only with `--fillrate` |

Esc or the close button ends the run early.

## Output

Without `--json`, key/value lines: the device, the per-burst texture count, a line as each
segment starts, then per-segment frames, average fps, longest frame and average GPU time.
With `--json` the same as one line, member order fixed:

```
{"script":"short","device":"NVIDIA GeForce RTX 5090","luid":78720,"pid":6784,"width":640,"height":360,
 "vsync":false,"fpsCap":120,"vramTargetPercent":5,"completed":true,"frames":1704,"seconds":15.01,
 "segments":[{"name":"warm-up","start":0,"end":2,"frames":240,"avgFps":119.9,"maxFrameMs":8.66,"avgGpuMs":0.012}, ...],
 "pipelineStates":20,"texturesUploaded":30,"uploadedMiB":1920,"heavyIterations":27430}
```

`avgGpuMs` is the GPU time of the bench's own command list per frame (timestamp queries);
`heavyIterations` is where the gpu-load controller settled, a rough speed figure for the card.
`pid` is what a PresentMon host passes to `--process_id`.

## The fill-rate mode (plan §8, the missing-ROPs cross-check)

`--fillrate` is a second workload in the same process, for one question: how many pixels per
second does this card write? Early RTX 50-series batches shipped with a raster engine disabled
(a 5090 with 168 ROPs instead of 176, about 4 % slower; NVIDIA confirmed it in February 2025),
and while the collector reads the ROP count directly through NVAPI, a driver that refuses that
private call leaves the audit with this measurement instead.

Each frame draws 64 full-screen quads (one oversized triangle each, `Fill.hlsl`) into a
4096×4096 RGBA8 offscreen target with a constant-colour pixel shader, no blend and no depth.
That is 1.07 Gpixel per frame: about 2 ms on a 5090, tens of milliseconds on a small laptop
part, far under the 2 s TDR budget with three frames in flight. After a 1 s warm-up the queue
is drained, the clock starts, frames are submitted until `--seconds` have passed, the queue is
drained again and the clock stops, so every counted pixel was written inside the measured span.

The measured frames never touch the swapchain (`Gpu.BeginOffscreen`, fence-bounded at three in
flight like any frame): the audit starts this mode from the collector while Strata Tune holds
the foreground, so the window comes up behind it and the desktop composes it, and a composed
window's `Present` is throttled to the display's refresh — 64 quads × 16.8 Mpixel × 60 Hz is
~64 GPixel/s, a tenth of a 5090, and the cross-check would answer "did not reach the raster
limit" every time. The window is presented at most every 50 ms, one small uncounted quad, only
to show the run is alive; a 60 Hz compositor never queues a present at 20 Hz, so `Present`
returns at once and paces nothing.

The bench is deliberately NVML-free and prints only what it measured:

```
{"pixelsPerSecond":461000000000,"seconds":6.004,"frames":2580,"width":4096,"height":4096}
```

The collector's load runner (`POST /load { kind: "fillrate", seconds }`) starts this mode,
samples the SM clock at 2 Hz while it runs and keeps the line as `LoadRun.fillRate`;
`src/analysis/gpuUnits.ts` divides the two, because the raster back end writes at most one
32-bit pixel per ROP per clock, and judges the result against the reference count's band
(85–100 % of ROPs × clock) and the band of the next lower plausible count. A 4.5 % question is
never decided from a bare number: the audit line always carries its band, and a reading that
fits no band is "no conclusion".

Esc, the close button and Ctrl+C end the run early with exit 2; the JSON line is still printed.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the script played to the end |
| 1 | bad arguments or an unexpected failure (printed) |
| 2 | interrupted: Ctrl+C, Esc or the window closed before the script ended; the summary still prints with `completed: false` |
| 3 | no DX12 hardware adapter (WARP is refused rather than benched) |
| 10 | device removed (TDR); the reason is printed |
| 11 | `gpu.lock` is held by another Strata app; the message names it |

## Sharing the GPU (plan §20)

Before anything is created the bench takes the family lock, `%STRATA_AI_DEV%\Claude\.strata\gpu.lock`
(`C:\AI_dev` by default), with the same JSON shape strata-video's `electron/gpu-lock.ts` writes:

```json
{ "holder": "strata-tune-bench", "pid": 6784, "since": "2026-09-16T07:33:27.9934810Z" }
```

A lock whose pid is alive and not ours means exit 11 with a plain sentence ("Strata Video is
using the GPU (pid 1234); the bench needs the card to itself."); a lock whose pid is gone is a
crash leftover and is cleared. The lock is released on every exit path, including Ctrl+C, and
never over a newer holder's file. The Ollama-resident-model half of the §20 rule is the app's
to check before it launches the bench, as it does for worker load runs.

## Build and run

```
dotnet build collector\StrataTune.Bench\StrataTune.Bench.csproj -c Release
collector\StrataTune.Bench\bin\Release\net10.0\win-x64\strata-tune-bench.exe --script short --width 640 --height 360
```

Built through `collector\StrataTune.sln` (a member since the Phase 5 integrate step) the output lands
under `bin\x64\Release\...` like the siblings. `AllowUnsafeBlocks` is on because `LibraryImport`
emits unsafe stubs and mapped GPU memory is written through pointers.

## Verified 2026-09-16 on the dev box

The short script at 640×360 with `--vram-target 5`, PresentMon 2.5.1 alongside
(`--process_name strata-tune-bench.exe --output_stdout --qpc_time --timed 10
--terminate_after_timed --session_name StrataTuneBenchProbe`): 914 rows, 28 columns, runtime
`DXGI`, mode `Composed: Flip`, sync interval 0. The hitches sit where the script puts them:

```
t(s)  MsBetweenPresents  MsCPUBusy  MsGPUBusy
2.05  67.4  67.3  0.22   shader-compile, 8 states
3.03  44.8  44.7  0.26   6 states
4.02  32.3  32.2  0.26   4 states
5.01  20.3  20.2  0.25   2 states
6.01  26.5  26.3  1.23   texture burst, 6 x 64 MiB
6.60  17.3  17.2  1.21
7.20  17.0  16.8  1.24
```

Two things the classifier work should know: pipeline-state creation is CPU-side work in the
driver, so a shader-compile hitch shows as a `MsCPUBusy` spike with the GPU idle, not as
`MsGPUBusy`; and on a Resizable BAR system the driver may place the upload buffer in VRAM, so a
texture burst here costs allocation time and little PCIe time (1.2 ms of GPU for 384 MiB).

The full 90 s run, and what it does to the frame-time chart end to end, is Phase 5's integrate
step; this folder only proves the workload and the PresentMon view of it.
