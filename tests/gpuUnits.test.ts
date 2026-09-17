import { describe, expect, it } from 'vitest';
import { BAND_HIGH, BAND_LOW, ROP_PARTITION, fillRateEstimate, judgeFillRate, meanSmClockHz, ropBand } from '../src/analysis/gpuUnits';
import { loadRun } from './fixtures';

/**
 * The arithmetic of the plan §8 cross-check, written out (an RTX 5090 at 2.9 GHz):
 *   176 ROPs × 2.9 GHz × 1 pixel/ROP/clock = 510.4 GPixel/s ceiling; band [0.85, 1.0] = 433.8–510.4
 *   168 ROPs (one 8-ROP partition fewer)   = 487.2 GPixel/s ceiling; band = 414.1–487.2
 */
const CLOCK = 2.9e9;
const REF = 176;

describe('bands', () => {
  it('a count explains a range of pixel rates at a clock, one pixel per ROP per clock', () => {
    const b = ropBand(REF, CLOCK);
    expect(b.ceiling).toBeCloseTo(510.4e9, -6);
    expect(b.low).toBeCloseTo(510.4e9 * BAND_LOW, -6);
    expect(b.high).toBeCloseTo(510.4e9 * BAND_HIGH, -6);
    expect(ropBand(REF - ROP_PARTITION, CLOCK).low).toBeCloseTo(414.12e9, -6);
    expect(ropBand(REF - ROP_PARTITION, CLOCK).high).toBeCloseTo(487.2e9, -6);
  });

  it('the 176 and 168 bands overlap, which is why a reading inside the reference band never becomes a verdict against it', () => {
    const reference = ropBand(REF, CLOCK);
    const lower = ropBand(REF - ROP_PARTITION, CLOCK);
    expect(lower.high).toBeGreaterThan(reference.low);
  });
});

describe('judgeFillRate', () => {
  it('450 GPixel/s = 0.882 of the ceiling: consistent with 176, and says the 168 band holds it too', () => {
    const e = judgeFillRate(450e9, CLOCK, REF);
    expect(e.verdict).toBe('consistent');
    expect(e.consistentWith).toBe(176);
    expect(e.estimatedRops).toBeCloseTo(155.17, 1);
    expect(e.fractionOfReference).toBeCloseTo(0.882, 3);
    expect(e.line).toBe('consistent with 176 ROPs (450 GPixel/s at 2.9 GHz; inside the 168-ROP band (414–487 GPixel/s) as well, so the two counts overlap at this reading)');
    // Above the 168 ceiling there is no overlap to mention.
    expect(judgeFillRate(500e9, CLOCK, REF).line).toBe('consistent with 176 ROPs (500 GPixel/s at 2.9 GHz)');
  });

  it('a 168-ROP card at the dev box\'s own 0.867 efficiency reads 0.827 of the 176 ceiling: below the 176 band, inside the 168 band, so inconsistent with 176', () => {
    const e = judgeFillRate(0.867 * 168 * CLOCK, CLOCK, REF);
    expect(e.verdict).toBe('inconsistent');
    expect(e.consistentWith).toBe(168);
    expect(e.line).toBe('below the 176-ROP band (422 GPixel/s at 2.9 GHz is 83 % of the 510 GPixel/s ceiling; the band starts at 85 %) and inside the 168-ROP band (414–487 GPixel/s)');
  });

  it('400 GPixel/s = 0.784: below both bands is no conclusion, never a verdict', () => {
    const e = judgeFillRate(400e9, CLOCK, REF);
    expect(e.verdict).toBe('inconclusive');
    expect(e.consistentWith).toBeNull();
    expect(e.line).toBe('no conclusion: 400 GPixel/s at 2.9 GHz is below the 168-ROP band (414–487 GPixel/s) as well as the 176-ROP band (434–510 GPixel/s); the run did not reach the raster limit');
  });

  it('a rate above the ceiling means the clock samples do not describe the run: no conclusion', () => {
    const e = judgeFillRate(520e9, CLOCK, REF);
    expect(e.verdict).toBe('inconclusive');
    expect(e.line).toBe('no conclusion: 520 GPixel/s at 2.9 GHz exceeds the 176-ROP ceiling of 510 GPixel/s, so the clock samples do not match the run');
  });

  it('the band edges belong to the bands; the lower count can be given explicitly', () => {
    expect(judgeFillRate(510.4e9, CLOCK, REF).verdict).toBe('consistent');
    expect(judgeFillRate(433.84e9, CLOCK, REF).verdict).toBe('consistent');
    expect(judgeFillRate(433.83e9, CLOCK, REF).verdict).toBe('inconsistent');
    expect(judgeFillRate(414.12e9, CLOCK, REF).verdict).toBe('inconsistent');
    expect(judgeFillRate(414.1e9, CLOCK, REF).verdict).toBe('inconclusive');
    // A 5080 (112 ROPs) losing a partition reads 104; 300 GPixel/s at 2.9 GHz = 0.924 of 112 × 2.9, inside the 104 band too (256–302).
    expect(judgeFillRate(300e9, CLOCK, 112).line).toBe('consistent with 112 ROPs (300 GPixel/s at 2.9 GHz; inside the 104-ROP band (256–302 GPixel/s) as well, so the two counts overlap at this reading)');
    expect(judgeFillRate(265e9, CLOCK, 112, 104).consistentWith).toBe(104);
  });
});

describe('from a load run', () => {
  const run = (pixelsPerSecond: number | null, shape = (t: number) => ({ smMhz: 2900 })) => ({
    ...loadRun('fillrate', 6, shape),
    fillRate: pixelsPerSecond === null ? null : { pixelsPerSecond, seconds: 6.01, frames: 2300, width: 4096, height: 4096 }
  });

  it('the clock is the steady-window mean of the SM samples (t ≥ 3 s), in Hz', () => {
    expect(meanSmClockHz(run(500e9))).toBe(2.9e9);
    // The first three seconds (start-up, boost ramp) are left out of the mean.
    expect(meanSmClockHz(run(500e9, t => ({ smMhz: t < 3 ? 1500 : 3000 })))).toBe(3.0e9);
    // Idle samples (clock 0) never drag the mean down; too few samples is no clock.
    expect(meanSmClockHz(run(500e9, t => ({ smMhz: t >= 5 ? 0 : 2900 })))).toBe(2.9e9);
    expect(meanSmClockHz({ ...run(500e9), gpuSamples: [] })).toBeNull();
    expect(meanSmClockHz({ ...run(500e9), qpcEnd: null })).toBeNull();
  });

  it('pairs the bench line with the clock; anything short of a finished fillrate run with a result is null', () => {
    expect(fillRateEstimate(run(500e9), REF)?.line).toBe('consistent with 176 ROPs (500 GPixel/s at 2.9 GHz)');
    expect(fillRateEstimate(run(null), REF)).toBeNull();
    expect(fillRateEstimate({ ...run(500e9), state: 'failed' }, REF)).toBeNull();
    expect(fillRateEstimate({ ...loadRun('heavy', 6), fillRate: run(500e9).fillRate }, REF)).toBeNull();
    expect(fillRateEstimate({ ...run(500e9), gpuSamples: [] }, REF)).toBeNull();
    expect(fillRateEstimate(null, REF)).toBeNull();
    expect(fillRateEstimate(undefined, REF)).toBeNull();
  });
});
