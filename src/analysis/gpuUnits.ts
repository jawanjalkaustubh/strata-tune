/**
 * The fill-rate cross-check of the missing-ROPs rule (master plan §8): what a measured pixel
 * rate says about a card's ROP count when the direct NVAPI read is unavailable.
 *
 * The bench's --fillrate mode writes full-screen quads with a constant-colour pixel shader,
 * no blend and no depth, into a 32-bit target, and reports pixels per second; the collector
 * samples the SM clock while it runs. The raster back end writes at most one 32-bit pixel
 * per ROP per clock, so
 *
 *     pixelsPerSecond ≤ rops × clockHz × PIXELS_PER_ROP_PER_CLOCK
 *
 * and pixelsPerSecond / clockHz is the ROP count that would explain the rate at 100 %. A
 * real pass reaches 0.85–0.95 of that ceiling (clears and tile edges cost a little, and the
 * clock is sampled at 2 Hz, not per pixel; the dev box reads 0.867), so a count N is
 * "consistent" with a reading inside N × clock × [BAND_LOW, BAND_HIGH]. The band's floor is
 * the achieved floor itself: any lower and a 168-ROP card at the dev box's own efficiency
 * (0.867 × 168 / 176 = 0.827 of the 176 ceiling) would pass as 176. The bands of 176 and 168
 * ROPs still overlap (168 / 176 = 0.955, inside a 15 % band), which is why a reading is only
 * ever called inconsistent with the reference when it is BELOW the reference band AND inside
 * the band of the next lower plausible count, and a reading inside both bands is consistent
 * with the reference but says the two counts overlap there; anything else that is not inside
 * the reference band is no conclusion, never a verdict. On an RTX 5090 at 2.9 GHz:
 *
 *     176 ROPs: ceiling 510.4 GPixel/s, band 433.8–510.4
 *     168 ROPs: ceiling 487.2 GPixel/s, band 414.1–487.2
 *     450 GPixel/s = 0.882 of the ceiling → consistent with 176 (and, being inside both bands,
 *                    with 168 too: the cross-check cannot tell them apart here, and says so)
 *     425 GPixel/s = 0.833 → below the 176 band, inside the 168 band → inconsistent with 176
 *     400 GPixel/s = 0.784 → below both bands → no conclusion (the run did not reach the raster limit)
 *     520 GPixel/s = 1.019 → above the ceiling → no conclusion (the clock samples do not match the run)
 *
 * Every result carries its band; there is never a bare number.
 */
import type { LoadRun } from '../collector-types';

/** One 32-bit pixel per ROP per clock: the raster back end's write ceiling. */
export const PIXELS_PER_ROP_PER_CLOCK = 1;
/** A fill pass achieves 0.85–0.95 of the ceiling; the band starts at that floor, or a card one partition short would pass as whole. */
export const BAND_LOW = 0.85;
export const BAND_HIGH = 1.0;
/** NVIDIA ROP partitions hold eight ROPs; every affected RTX 50-series card lost exactly one (176 → 168 on the 5090, 112 → 104 on the 5080, 96 → 88 on the 5070 Ti). */
export const ROP_PARTITION = 8;
/** The audit's steady window: the bench's start-up and the boost governor's first seconds are not the measurement. */
const STEADY_FROM_S = 3;

/** The pixel-per-second range a count of ROPs explains at a clock. */
export interface RopBand {
  rops: number;
  ceiling: number;
  low: number;
  high: number;
}

export type FillRateVerdict = 'consistent' | 'inconsistent' | 'inconclusive';

export interface RopEstimate {
  pixelsPerSecond: number;
  clockHz: number;
  /** pixelsPerSecond / clockHz: the ROPs that would explain the rate at 100 % of the ceiling. */
  estimatedRops: number;
  /** pixelsPerSecond over the reference ceiling. */
  fractionOfReference: number;
  reference: RopBand;
  lower: RopBand;
  verdict: FillRateVerdict;
  /** The count the reading is consistent with: the reference, the lower count, or null. */
  consistentWith: number | null;
  /** The one sentence the audit shows; always with the band it was judged against. */
  line: string;
}

export function ropBand(rops: number, clockHz: number): RopBand {
  const ceiling = rops * clockHz * PIXELS_PER_ROP_PER_CLOCK;
  return { rops, ceiling, low: ceiling * BAND_LOW, high: ceiling * BAND_HIGH };
}

const gpix = (pixelsPerSecond: number) => `${Math.round(pixelsPerSecond / 1e9)} GPixel/s`;
const ghz = (hz: number) => `${(hz / 1e9).toFixed(1)} GHz`;
const range = (band: RopBand) => `${Math.round(band.low / 1e9)}–${Math.round(band.high / 1e9)} GPixel/s`;
const inside = (band: RopBand, pixelsPerSecond: number) => pixelsPerSecond >= band.low && pixelsPerSecond <= band.high;

/**
 * Judges a measured pixel rate against the reference ROP count and the next lower plausible
 * one (the reference minus one ROP partition unless told otherwise).
 */
export function judgeFillRate(pixelsPerSecond: number, clockHz: number, referenceRops: number, lowerRops = referenceRops - ROP_PARTITION): RopEstimate {
  const reference = ropBand(referenceRops, clockHz);
  const lower = ropBand(lowerRops, clockHz);
  const estimatedRops = pixelsPerSecond / clockHz / PIXELS_PER_ROP_PER_CLOCK;
  const fractionOfReference = pixelsPerSecond / reference.ceiling;
  const at = `${gpix(pixelsPerSecond)} at ${ghz(clockHz)}`;
  const base = { pixelsPerSecond, clockHz, estimatedRops, fractionOfReference, reference, lower };
  if (inside(reference, pixelsPerSecond)) {
    const overlap = inside(lower, pixelsPerSecond) ? `; inside the ${lowerRops}-ROP band (${range(lower)}) as well, so the two counts overlap at this reading` : '';
    return { ...base, verdict: 'consistent', consistentWith: referenceRops, line: `consistent with ${referenceRops} ROPs (${at}${overlap})` };
  }
  if (pixelsPerSecond < reference.low && inside(lower, pixelsPerSecond)) {
    return {
      ...base, verdict: 'inconsistent', consistentWith: lowerRops,
      line: `below the ${referenceRops}-ROP band (${at} is ${Math.round(fractionOfReference * 100)} % of the ${gpix(reference.ceiling)} ceiling; the band starts at ${Math.round(BAND_LOW * 100)} %) and inside the ${lowerRops}-ROP band (${range(lower)})`
    };
  }
  if (pixelsPerSecond > reference.high) {
    return {
      ...base, verdict: 'inconclusive', consistentWith: null,
      line: `no conclusion: ${at} exceeds the ${referenceRops}-ROP ceiling of ${gpix(reference.ceiling)}, so the clock samples do not match the run`
    };
  }
  return {
    ...base, verdict: 'inconclusive', consistentWith: null,
    line: `no conclusion: ${at} is below the ${lowerRops}-ROP band (${range(lower)}) as well as the ${referenceRops}-ROP band (${range(reference)}); the run did not reach the raster limit`
  };
}

/**
 * The SM clock the fill rate was measured at: the mean over the run's steady window
 * (t ≥ 3 s, which is inside the bench's measured span after its 1 s warm-up), in Hz.
 * Null when the run has too few samples to average.
 */
export function meanSmClockHz(run: LoadRun): number | null {
  if (run.qpcEnd === null || run.qpcEnd <= run.qpcStart) return null;
  const span = run.qpcEnd - run.qpcStart;
  const steady = run.gpuSamples.filter(x => (x.qpc - run.qpcStart) / span * run.seconds >= STEADY_FROM_S && x.smMhz > 0);
  if (steady.length < 4) return null;
  return steady.reduce((sum, x) => sum + x.smMhz, 0) / steady.length * 1e6;
}

/** The estimate for a finished 'fillrate' run, or null when the run is not one, failed, or lacks its result or clock samples. */
export function fillRateEstimate(run: LoadRun | null | undefined, referenceRops: number): RopEstimate | null {
  if (!run || run.kind !== 'fillrate' || run.state !== 'done' || !run.fillRate || !(run.fillRate.pixelsPerSecond > 0)) return null;
  const clockHz = meanSmClockHz(run);
  if (clockHz === null) return null;
  return judgeFillRate(run.fillRate.pixelsPerSecond, clockHz, referenceRops);
}
