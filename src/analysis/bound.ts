/**
 * CPU-bound or GPU-bound (master plan §12): over the analysed frames, how much of each
 * frame the GPU was busy against how much the CPU was, with the GPU utilisation from
 * the timeline as the number the sentence quotes. Pure; no sensors touched.
 */
import { WARMUP_FRAMES, frameTimeMs } from './frames';
import type { BoundVerdict, CaptureSession } from './session-types';
import benchmarks from '../data/benchmarks.json';

/** Busy for this much of the frame and the side is saturated. */
const SATURATED = 0.85;
/** Under this on both sides, nothing is limiting: a cap or vsync sets the pace. */
const HEADROOM = 0.7;
/** Shares this close together are one verdict, not two. */
const CLOSE = 0.15;

const pct = (share: number) => `${Math.round(share * 100)} %`;

/**
 * The built-in bench (plan §11a) holds its frame-rate cap by waiting on its own thread
 * (Bench.cs Pacing.SleepUntil), which PresentMon counts as CPU busy: 9.1 ms of an 8.3 ms
 * frame on a 9950X. The wait up to the cap period is pacing, not work, so only CPU time
 * beyond it counts, and the bench never tells its owner to buy a faster CPU. 0 for a game.
 */
const pacingMs = (session: CaptureSession): number =>
  session.game.exe.toLowerCase() === benchmarks.builtIn.exe && benchmarks.builtIn.fpsCap > 0 ? 1000 / benchmarks.builtIn.fpsCap : 0;

export function judgeBound(session: CaptureSession): BoundVerdict {
  const frames = session.frames.length > WARMUP_FRAMES ? session.frames.slice(WARMUP_FRAMES) : session.frames;
  const pacing = pacingMs(session);
  let frameMs = 0;
  let gpuMs = 0;
  let cpuMs = 0;
  for (const f of frames) {
    if (f.msGpuBusy === null || f.msCpuBusy === null) continue;
    frameMs += frameTimeMs(f);
    gpuMs += f.msGpuBusy;
    cpuMs += Math.max(0, f.msCpuBusy - pacing);
  }
  if (frameMs <= 0) {
    return { limiter: 'unknown', gpuBusyShare: 0, cpuBusyShare: 0, text: 'The capture did not carry the CPU and GPU busy columns, so there is no verdict on which side limits you.' };
  }
  const gpuBusyShare = Math.min(1, gpuMs / frameMs);
  const cpuBusyShare = Math.min(1, cpuMs / frameMs);

  const first = frames[0].timeInQpc;
  const last = frames[frames.length - 1].timeInQpc;
  const util = session.gpuTimeline.filter((g) => g.qpc >= first && g.qpc <= last).map((g) => g.facts.utilisation.gpu);
  const gpuUtil = util.length ? util.reduce((a, b) => a + b, 0) / util.length / 100 : gpuBusyShare;

  if (Math.max(gpuBusyShare, cpuBusyShare) < HEADROOM) {
    return {
      limiter: 'unknown', gpuBusyShare, cpuBusyShare,
      text: pacing > 0
        ? `Neither side was the limit: the bench paced itself at ${benchmarks.builtIn.fpsCap} fps, with the GPU busy for ${pct(gpuBusyShare)} of each frame and the CPU for ${pct(cpuBusyShare)} beyond the pacing wait. That is fine.`
        : `Neither side was the limit: the GPU was busy for ${pct(gpuBusyShare)} of each frame and the CPU for ${pct(cpuBusyShare)}, so a frame-rate cap or vsync set the pace. That is fine.`
    };
  }
  if (Math.abs(gpuBusyShare - cpuBusyShare) <= CLOSE) {
    return {
      limiter: 'balanced', gpuBusyShare, cpuBusyShare,
      text: `Your CPU and GPU were both busy for most of each frame (${pct(cpuBusyShare)} and ${pct(gpuBusyShare)}), so neither has spare room: a settings change on either side moves the frame rate.`
    };
  }
  if (gpuBusyShare > cpuBusyShare) {
    const spare = cpuBusyShare < SATURATED ? 'had room to spare' : 'was close behind';
    return {
      limiter: 'gpu', gpuBusyShare, cpuBusyShare,
      text: `Your GPU was busy for ${pct(gpuBusyShare)} of each frame while your CPU ${spare} — lowering graphics settings (resolution, ray tracing, shadows) will raise your frame rate.`
    };
  }
  return {
    limiter: 'cpu', gpuBusyShare, cpuBusyShare,
    text: `Your GPU sat at ${pct(gpuUtil)} while your CPU was pegged — lowering graphics settings will not help you. Look at draw distance, crowd and physics settings, background programs, or a faster CPU.`
  };
}
