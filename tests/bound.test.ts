import { describe, expect, it } from 'vitest';
import { judgeBound } from '../src/analysis/bound';
import { gpuTimeline, session, steady } from './fixtures/frames';

describe('judgeBound', () => {
  it('GPU-bound: the GPU fills the frame while the CPU has room', () => {
    const b = judgeBound(session(steady(30, 8, () => ({ ms: 8, gpuBusy: 7.8, cpuBusy: 3 })), { gpuTimeline: gpuTimeline(30, () => ({ utilisation: 98 })) }));
    expect(b.limiter).toBe('gpu');
    expect(b.gpuBusyShare).toBeCloseTo(0.975, 3);
    expect(b.cpuBusyShare).toBeCloseTo(0.375, 3);
    expect(b.text).toMatch(/lowering graphics settings .* will raise your frame rate/);
  });

  it('CPU-bound: the CPU fills the frame while the GPU sits at 60 %', () => {
    const b = judgeBound(session(steady(30, 8, () => ({ ms: 8, gpuBusy: 4.8, cpuBusy: 7.8 })), { gpuTimeline: gpuTimeline(30, () => ({ utilisation: 60 })) }));
    expect(b.limiter).toBe('cpu');
    expect(b.text).toBe('Your GPU sat at 60 % while your CPU was pegged — lowering graphics settings will not help you. Look at draw distance, crowd and physics settings, background programs, or a faster CPU.');
  });

  it('quotes the busy share when no GPU utilisation was sampled', () => {
    const b = judgeBound(session(steady(30, 8, () => ({ ms: 8, gpuBusy: 4.8, cpuBusy: 7.8 }))));
    expect(b.limiter).toBe('cpu');
    expect(b.text).toMatch(/^Your GPU sat at 60 %/);
  });

  it('balanced: both sides busy for most of the frame', () => {
    const b = judgeBound(session(steady(30, 8, () => ({ ms: 8, gpuBusy: 7.6, cpuBusy: 7.2 }))));
    expect(b.limiter).toBe('balanced');
    expect(b.text).toMatch(/neither has spare room/);
  });

  it('capped: neither side busy enough to be the limit', () => {
    const b = judgeBound(session(steady(30, 8)));
    expect(b.limiter).toBe('unknown');
    expect(b.text).toMatch(/frame-rate cap or vsync/);
  });

  it('has no verdict without the busy columns', () => {
    const frames = steady(30, 8).map((f) => ({ ...f, msGpuBusy: null, msCpuBusy: null }));
    const b = judgeBound(session(frames));
    expect(b.limiter).toBe('unknown');
    expect(b.gpuBusyShare).toBe(0);
    expect(b.text).toMatch(/no verdict/);
  });

  it('the built-in bench: the pacing wait up to the 120 fps cap period is not CPU work, so a paced run limits neither side', () => {
    // The dev box's real run: 8.3 ms frames, the CPU "busy" for 9.1 ms of each (Pacing.SleepUntil), the GPU for 2.8 ms.
    const bench = { ...session(steady(30, 8.33, () => ({ ms: 8.33, gpuBusy: 2.8, cpuBusy: 9.1 })), { gpuTimeline: gpuTimeline(30, () => ({ utilisation: 34 })) }), game: { pid: 7, exe: 'strata-tune-bench.exe', path: null } };
    const b = judgeBound(bench);
    expect(b.limiter).toBe('unknown');
    expect(b.cpuBusyShare).toBeCloseTo(0.092, 2);
    expect(b.text).toBe('Neither side was the limit: the bench paced itself at 120 fps, with the GPU busy for 34 % of each frame and the CPU for 9 % beyond the pacing wait. That is fine.');
    // A game with the same columns is CPU-bound as before: no cap is assumed for it.
    expect(judgeBound(session(steady(30, 8.33, () => ({ ms: 8.33, gpuBusy: 2.8, cpuBusy: 9.1 })))).limiter).toBe('cpu');
    // A weak GPU under the bench's gpu-load segment still reads GPU-bound: the discount is on the CPU side only.
    const weak = { ...session(steady(30, 20, () => ({ ms: 20, gpuBusy: 19.5, cpuBusy: 9 }))), game: { pid: 7, exe: 'strata-tune-bench.exe', path: null } };
    expect(judgeBound(weak).limiter).toBe('gpu');
  });

  it('skips the level load like the detector does', () => {
    const frames = steady(30, 8, (_, i) => (i < 300 ? { ms: 8, gpuBusy: 7.9, cpuBusy: 2 } : { ms: 8, gpuBusy: 3, cpuBusy: 7.9 }));
    expect(judgeBound(session(frames)).limiter).toBe('cpu');
  });
});
