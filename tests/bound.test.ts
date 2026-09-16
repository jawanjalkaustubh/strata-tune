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

  it('skips the level load like the detector does', () => {
    const frames = steady(30, 8, (_, i) => (i < 300 ? { ms: 8, gpuBusy: 7.9, cpuBusy: 2 } : { ms: 8, gpuBusy: 3, cpuBusy: 7.9 }));
    expect(judgeBound(session(frames)).limiter).toBe('cpu');
  });
});
