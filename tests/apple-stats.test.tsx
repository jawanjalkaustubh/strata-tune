import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gpuSpecOf } from '../src/components/advisor/rows';
import { lookupGpu } from '../src/analysis/hardware-tables';
import { sameGpu } from '../src/components/advisor/hardware';
import type { GpuBench } from '../electron/bench';

/** The renderer's localStorage and a bare window, as tests/advisor-card.test.tsx sets them: settings.ts and support.ts read them at import. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
(globalThis as { window?: unknown }).window = globalThis;
const { StatsCard } = await import('../src/components/advisor/StatsCard');

/** An M5 Max as the macOS collector names it (docs/MACOS.md): the Apple rows fill the tiles, the machine fills the clock and the working set. */
const NAME = 'Apple M5 Max (40-core GPU)';
const WORKING_SET_MIB = 38339;

const bench: GpuBench = {
  device: 'Apple M5 Max',
  luid: '1',
  bandwidthGBs: 548,
  bandwidthMedianGBs: 545,
  bufferBytes: 1 << 30,
  matmulN: 4096,
  matmulTflopsFp32: 14.9,
  matmulTflopsFp16: 65,
  matmulTopsInt8: 107.2,
  matmulTflopsFp16tensor: 62.7,
  elapsedMs: 900,
  driver: 'Metal (macOS 26.5.1)',
  measuredAt: '2026-09-20T00:00:00Z'
};

describe('Apple Silicon on the AI stats card', () => {
  it('lookupGpu matches the Apple rows by chip and core count, never by VRAM, and gpuSpecOf fills what Apple leaves blank from the machine', () => {
    expect(lookupGpu(NAME)).toMatchObject({ vendor: 'Apple', unified: true, shadingUnits: 5120, tmus: 320, rops: 160, busBits: 512, bandwidthGBs: 614, neuralEngineCores: 16, tdpW: 0, boostMhz: 0 });
    expect(lookupGpu('Apple M5 Max (32-core GPU)')?.shadingUnits).toBe(4096);
    expect(lookupGpu('Apple M5 Max')).toBeNull();
    const spec = gpuSpecOf(NAME, WORKING_SET_MIB, { maxClockMhz: 1620 })!;
    expect(spec.unified).toBe(true);
    expect(spec.vramGiB).toBe(37);
    expect(spec.tiles.boostMhz).toBe(1620);
    expect(spec.fp32Tflops).toBeCloseTo((5120 * 2 * 1620) / 1e6, 1);
    expect(gpuSpecOf(NAME, WORKING_SET_MIB)!.tiles.boostMhz).toBe(0);
  });

  it("the bench's Metal device name matches the collector's name with the core count", () => {
    expect(sameGpu('Apple M5 Max', NAME)).toBe(true);
    expect(sameGpu('Apple M5 Pro', NAME)).toBe(false);
  });

  it('leads with the measured int8 TOPS, says it is measured and dense, and shows the tiles Apple publishes without inventing a TDP', () => {
    const spec = gpuSpecOf(NAME, WORKING_SET_MIB, { maxClockMhz: 1620 })!;
    const html = renderToStaticMarkup(
      <StatsCard gpuName={NAME} gpuColour="#A2AAAD" spec={spec} card={null} laptop integrated={false} ramBandwidthGBs={548} latest={null} npuTops={null} bench={bench} applies measuring={false} canMeasure error="" onMeasure={() => {}} />
    );
    expect(html).toContain('AI TOPS');
    expect(html).toContain('int8 · dense · measured on this GPU');
    expect(html).toContain('107');
    expect(html).toContain('5,120');
    expect(html).toContain('614');
    expect(html).toContain('not published');
    expect(html).toContain('GPU working set');
    expect(html).toContain('Neural Engine');
    expect(html).not.toContain('PSU');
    expect(html).not.toContain('0 W');
  });

  it('before Measure the headline says what to do rather than showing a dash or a made-up figure', () => {
    const spec = gpuSpecOf(NAME, WORKING_SET_MIB, { maxClockMhz: 1620 })!;
    const html = renderToStaticMarkup(
      <StatsCard gpuName={NAME} gpuColour="#A2AAAD" spec={spec} card={null} laptop integrated={false} latest={null} npuTops={null} bench={null} applies={false} measuring={false} canMeasure error="" onMeasure={() => {}} />
    );
    expect(html).toContain('press Measure');
    expect(html).not.toContain('AI TOPS');
  });
});
