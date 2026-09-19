import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScoredRun, TuneExport, TuneResult, TuneStatus } from '../src/collector-types';
import { THERMAL_OR_BRAKE } from '../src/analysis/nvmlBits';
import {
  additive,
  atCeiling,
  atStart,
  bandwidthPoints,
  computePoints,
  confidence,
  converged,
  CORE_RESOLUTION_KHZ,
  CORE_STEP_KHZ,
  DEVICE_CLASS_LABEL,
  deviceClass,
  estimateMinutes,
  exportText,
  failingLadders,
  foreignTune,
  holdsDiffer,
  holdsNowLine,
  isFailure,
  isRefusal,
  judge,
  judgeAdditivity,
  median,
  MEM_RESOLUTION_KHZ,
  MEM_STEP_KHZ,
  midpoint,
  moved,
  movedFromPrevious,
  meanClockNoiseMhz,
  throughputNoise,
  gainedOnCap,
  capExceeded,
  capsForStart,
  leftSentence,
  nextRung,
  patternVerdict,
  percentOver,
  planVendor,
  REFERENCE_BANDWIDTH_GBS,
  REFERENCE_COMPUTE_GSPS,
  REFERENCE_POINTS,
  regressed,
  regressionFloor,
  RUNG_SHAPE,
  score,
  SCORED_REPEATS,
  scoreLine,
  signedPercent,
  sliderTotal,
  spread,
  stage,
  stepDown,
  THERMAL_BITS,
  THROTTLE_BITS,
  throughputFell,
  vendorDeltas,
  vendorForStart,
  vendorMatches,
  vendorMemoryNvml,
  vendorReproduced,
  vendorSlider,
  type DeviceClass,
  type RungFacts
} from '../src/analysis/tune';

describe("ladder steps (plan §16, the user's 5–15 MHz rule, mirrored from TuneLadder.cs)", () => {
  it('climbs in 15 MHz rungs on both axes from the card as found and stops at the driver max', () => {
    expect(CORE_STEP_KHZ).toBe(15_000);
    expect(MEM_STEP_KHZ).toBe(15_000);
    expect(nextRung(0, CORE_STEP_KHZ, 1_000_000)).toBe(15_000);
    expect(nextRung(45_000, MEM_STEP_KHZ, 3_000_000)).toBe(60_000);
    expect(nextRung(990_000, CORE_STEP_KHZ, 1_000_000)).toBeNull();
    expect(nextRung(985_000, CORE_STEP_KHZ, 1_000_000)).toBe(1_000_000);
  });

  it('bisects a 15 MHz rung to the 5 MHz fine step: +5, then +10, then done', () => {
    expect(midpoint(45_000, 60_000, CORE_RESOLUTION_KHZ)).toBe(50_000);
    expect(midpoint(50_000, 60_000, CORE_RESOLUTION_KHZ)).toBe(55_000);
    expect(midpoint(55_000, 60_000, CORE_RESOLUTION_KHZ)).toBeNull();
    expect(midpoint(0, 15_000, MEM_RESOLUTION_KHZ)).toBe(5_000);
    expect(midpoint(5_000, 15_000, MEM_RESOLUTION_KHZ)).toBe(10_000);
    expect(midpoint(10_000, 15_000, MEM_RESOLUTION_KHZ)).toBeNull();
  });
});

describe("a rung is a minute (plan §16, user 2026-09-16: 'variable in the first 30 s with spikes every 2–4 s, and another 30 s full load')", () => {
  it('is 30 s variable then 30 s sustained, the same shape for both ladders; a scored run is two repeats', () => {
    expect(RUNG_SHAPE).toEqual([
      { pattern: 'variable', seconds: 30 },
      { pattern: 'sustained', seconds: 30 }
    ]);
    expect(RUNG_SHAPE.reduce((s, p) => s + p.seconds, 0)).toBe(60);
    expect(SCORED_REPEATS).toBe(2);
  });

  it('the time estimate before Start: about 16 minutes for a hunt (2 as found + 6 + 6 rungs + 2 official), one more with a vendor rung, the cap when bounded', () => {
    expect(estimateMinutes('hunt')).toBe(16);
    expect(estimateMinutes('hunt', null, true)).toBe(17);
    expect(estimateMinutes('core')).toBe(10);
    expect(estimateMinutes('memory', 3)).toBe(7);
    expect(estimateMinutes('hunt', 3, true)).toBe(11);
  });
});

describe('scores (plan §16, every rung is scored; mirrored from TuneScoring)', () => {
  it('a reference 5090 at reference clocks is 10,000: 5,000 compute at 2861 Gsteps/s (3502.40 at 2947 MHz on the dev box, scaled to 2407) + 5,000 bandwidth at 1437 GB/s (the stream copy at 28 Gbps)', () => {
    expect(REFERENCE_COMPUTE_GSPS).toBe(2861);
    expect(Math.round((3502.4 * 2407) / 2947)).toBe(2861);
    expect(REFERENCE_BANDWIDTH_GBS).toBe(1437);
    expect(score(2861, 1437)).toEqual({ points: REFERENCE_POINTS, computePoints: 5000, bandwidthPoints: 5000, throughputGsps: 2861, bandwidthGBs: 1437 });
  });

  it("the dev box lands where it lands: stock 3502.40 Gsteps/s + 1413 GB/s (run 5623b090e68d) ≈ 11,040; the user's +319 / +4072 tune ≈ 11,700", () => {
    expect(computePoints(3502.4)).toBe(6121);
    expect(bandwidthPoints(1413)).toBe(4916);
    expect(score(3502.4, 1413)!.points).toBe(11_037);
    const tuned = score((3502.4 * 3225) / 2947, 1438)!;
    expect(tuned.points).toBe(11_701);
    expect(signedPercent(percentOver(tuned.points, REFERENCE_POINTS))).toBe('+17.0 %');
    expect(signedPercent(percentOver(11_830, tuned.points))).toBe('+1.1 %');
    expect(signedPercent(percentOver(11_600, tuned.points))).toBe('-0.9 %');
  });

  it('a rung that failed before its sustained half has no score', () => {
    expect(score(null, 1413)).toBeNull();
    expect(score(3502.4, null)).toBeNull();
  });
});

describe("the vendor tune (plan §16, a P0 delta write replaces the vendor tool's offset; run 74c3442b1294)", () => {
  it("the one conversion: GPU Tweak's slider shows the effective rate, twice NVML: +4072 effective = +2036 NVML; an 'nvml' entry passes through", () => {
    expect(vendorMemoryNvml({ value: 4072, unit: 'effective' })).toBe(2036);
    expect(vendorMemoryNvml({ value: 2036, unit: 'nvml' })).toBe(2036);
    expect(vendorMemoryNvml({ value: 3672, unit: 'effective' })).toBe(1836);
    expect(14001 + vendorMemoryNvml({ value: 4072, unit: 'effective' })).toBe(16037);
    expect(vendorDeltas({ coreMhz: 319, memMhz: 4072 })).toEqual({ coreMhz: 319, memMhz: 2036 });
    expect(vendorSlider({ coreMhz: 45, memMhz: 60 })).toEqual({ coreMhz: 45, memMhz: 120 });
    expect(sliderTotal({ coreMhz: 319, memMhz: 4072 }, { coreMhz: 45, memMhz: 60 })).toEqual({ coreMhz: 364, memMhz: 4192 });
  });

  it('the settings become the start request in slider units; nothing set means no vendor value', () => {
    expect(vendorForStart({ vendorCoreOffsetMhz: 319, vendorMemoryOffset: { value: 4072, unit: 'effective' } })).toEqual({ coreMhz: 319, memMhz: 4072 });
    expect(vendorForStart({ vendorCoreOffsetMhz: null, vendorMemoryOffset: { value: 2036, unit: 'nvml' } })).toEqual({ coreMhz: 0, memMhz: 4072 });
    expect(vendorForStart({ vendorCoreOffsetMhz: 319, vendorMemoryOffset: null })).toEqual({ coreMhz: 319, memMhz: 0 });
    expect(vendorForStart({ vendorCoreOffsetMhz: null, vendorMemoryOffset: null })).toBeUndefined();
    expect(vendorForStart({ vendorCoreOffsetMhz: 0, vendorMemoryOffset: { value: 0, unit: 'effective' } })).toBeUndefined();
  });

  it('the cross-check: 16008 held on the 14001 ceiling is 2007 NVML, within 60 of +4072 ÷ 2 = 2036 (1.4 %, inside 3 %); a stale +3672 (1836) is not', () => {
    expect(vendorMatches(16008, 14001, 2036)).toBe(true);
    expect(vendorMatches(16008, 14001, 1836)).toBe(false);
    expect(vendorMatches(14001, 14001, 0)).toBe(true);
    expect(Math.abs(16008 - 14001 - 2036)).toBeLessThanOrEqual(60);
    expect(Math.abs(2007 - 2036) / 2036).toBeLessThan(0.03);
  });

  // The dev box: driver ceilings 3090 / 14001; GPU Tweak +319 / +4072 holds 3225 / 16008 sustained; stock holds 2985 / 14001 (top of the curve 3007).
  const tuned = { smMhz: 3225, memMhz: 16008 };
  const stock = { smMhz: 2985, memMhz: 14001 };
  const zero = { coreMhz: 0, memMhz: 0 };
  const gpuTweak = { coreMhz: 319, memMhz: 4072 };

  it('a stock card with nothing entered hunts from its own P0 deltas', () => {
    expect(planVendor(stock, 3007, 3090, 14001, zero, null)).toEqual({ refusal: null, baseline: zero, vendor: null, vendorRung: false });
    expect(planVendor(stock, 3007, 3090, 14001, zero, zero)).toEqual({ refusal: null, baseline: zero, vendor: null, vendorRung: false });
  });

  it("the user's tune with nothing entered refuses before any write: 'your card holds a tune we cannot see'", () => {
    expect(planVendor(tuned, 3326, 3090, 14001, zero, null).refusal).toBe('foreign-tune');
    expect(isRefusal('foreign-tune')).toBe(true);
  });

  it("the user's tune with +319 / +4072 entered: the memory cross-check passes, the entered value is the baseline, written first as the vendor rung", () => {
    expect(planVendor(tuned, 3326, 3090, 14001, zero, gpuTweak)).toEqual({ refusal: null, baseline: { coreMhz: 319, memMhz: 2036 }, vendor: gpuTweak, vendorRung: true });
  });

  it('a stale +3672 against 16008 held refuses with the mismatch, nothing written', () => {
    expect(planVendor(tuned, 3326, 3090, 14001, zero, { coreMhz: 319, memMhz: 3672 }).refusal).toBe('vendor-mismatch');
    expect(isRefusal('vendor-mismatch')).toBe(true);
  });

  it("values entered while the card holds stock: 'the tune is not applied on the card', refused (the live-test stop condition)", () => {
    expect(planVendor(stock, 3007, 3090, 14001, zero, gpuTweak).refusal).toBe('vendor-mismatch');
    expect(planVendor(stock, 3007, 3090, 14001, zero, { coreMhz: 319, memMhz: 0 }).refusal).toBe('vendor-mismatch');
  });

  it('a foreign core with core +0 entered refuses: the first write would wipe it', () => {
    expect(planVendor(tuned, 3326, 3090, 14001, zero, { coreMhz: 0, memMhz: 4072 }).refusal).toBe('vendor-mismatch');
  });

  it('a core-only vendor tune whose top of the curve shows above the ceiling is the baseline on the core alone', () => {
    expect(planVendor({ smMhz: 3225, memMhz: 14001 }, 3326, 3090, 14001, zero, { coreMhz: 319, memMhz: 0 })).toEqual({ refusal: null, baseline: { coreMhz: 319, memMhz: 0 }, vendor: { coreMhz: 319, memMhz: 0 }, vendorRung: true });
  });

  it("after a hunt our own route holds the tune (P0 +319 / +2036 reads back): nothing is foreign, the driver's deltas are the baseline and the entered value stays for the export", () => {
    const ours = { coreMhz: 319, memMhz: 2036 };
    expect(foreignTune(16037, 14001, 2036)).toBe(false);
    expect(planVendor({ smMhz: 3225, memMhz: 16037 }, 3326, 3090, 14001, ours, gpuTweak)).toEqual({ refusal: null, baseline: ours, vendor: gpuTweak, vendorRung: false });
    expect(planVendor({ smMhz: 3225, memMhz: 16037 }, 3326, 3090, 14001, ours, null)).toEqual({ refusal: null, baseline: ours, vendor: null, vendorRung: false });
  });

  it('the vendor rung must reproduce the card as found: memory within 60, the SM peak within 120 (it wobbles at the cap)', () => {
    expect(vendorReproduced(tuned, { smMhz: 3210, memMhz: 16037 })).toBe(true);
    expect(vendorReproduced(tuned, { smMhz: 3225, memMhz: 15837 })).toBe(false);
    expect(vendorReproduced(tuned, { smMhz: 2947, memMhz: 16037 })).toBe(false);
  });

  it('the end-of-run truth: held clocks after the restore within 1 % of as found are the same; run 74c3442b1294 left 2947 / 14001 where 3225 / 16008 was found', () => {
    expect(holdsDiffer(tuned, { smMhz: 3210, memMhz: 16037 })).toBe(false);
    expect(holdsDiffer(tuned, { smMhz: 2947, memMhz: 14001 })).toBe(true);
    expect(holdsDiffer(tuned, { smMhz: 3225, memMhz: 15837 })).toBe(true);
  });
});

describe('the card as found: the foreign-tune guard, additivity, movement, the ceiling', () => {
  it("refuses before the first write when the card holds clocks above the driver's ceilings with no P0 offset of ours (the dev box under GPU Tweak +319 / +4072)", () => {
    expect(foreignTune(16008, 14001, 0)).toBe(true);
    expect(foreignTune(3225, 3090, 0)).toBe(true);
    expect(foreignTune(14001, 14001, 0)).toBe(false);
    expect(foreignTune(2947, 3090, 0)).toBe(false);
    expect(foreignTune(14101, 14001, 100)).toBe(false);
    expect(foreignTune(14117, 14001, 100)).toBe(true);
    expect(foreignTune(16008, null, 0)).toBe(false);
    expect(isRefusal('additivity')).toBe(true);
    expect(isRefusal('hash')).toBe(false);
    expect(isFailure('foreign-tune')).toBe(false);
  });

  it('the climb must lift the held clock by 0.6 x the offset written: one 15 MHz bin up passes, no change fails', () => {
    expect(additive(3022, 3007, 15)).toBe(true);
    expect(additive(3016, 3007, 15)).toBe(true);
    expect(additive(3015, 3007, 15)).toBe(false);
    expect(additive(3007, 3007, 15)).toBe(false);
    expect(additive(16023, 16008, 15)).toBe(true);
    expect(additive(16008, 16008, 15)).toBe(false);
    // Run 74c3442b1294: +15 landed at 14016, the stock 14001 plus our rung; the tune was replaced, not added to.
    expect(additive(14016, 16008, 15)).toBe(false);
  });

  it('a first core rung half a bin up is undecided and the second rung decides (runs 154463d9b2f1 and bb09b0a0455c: 3337 against 3330 / 3337)', () => {
    // bb09b0a0455c: as found 3330 at the top of the curve, +15 read 3337 (+7): not a refusal any more.
    expect(judgeAdditivity(3337, 3330, 15, 15)).toBe('undecided');
    expect(judgeAdditivity(3337, 3337, 15, 15)).toBe('undecided');
    // The +30 rung: added reads at least +22 (3352), not added at most +7.
    expect(judgeAdditivity(3352, 3330, 30, 15)).toBe('passed');
    expect(judgeAdditivity(3345, 3330, 30, 15)).toBe('failed');
    expect(judgeAdditivity(3337, 3330, 30, 15)).toBe('failed');
    // A clock that fell is decided at once: the write replaced the tune (run 74c3442b1294).
    expect(judgeAdditivity(14016, 16008, 15, 15)).toBe('failed');
    // Memory is deterministic: +15 shows at once.
    expect(judgeAdditivity(16052, 16037, 15, 15)).toBe('passed');
  });

  it("workflow 13 / 13c, the top of the clock table (plan §16): when the top of the curve cannot move, the sustained mean clock and the throughput decide against the as-found spread; tonight's numbers 3330 → 3337 → 3337 and 12,536 → 12,661 points", () => {
    // The floors: never under 5 MHz / 0.3 %, else the as-found repeats' own spread (three times, for the throughput).
    expect(meanClockNoiseMhz(null)).toBe(5);
    expect(meanClockNoiseMhz(12)).toBe(12);
    expect(throughputNoise(null)).toBeCloseTo(0.003);
    expect(throughputNoise(0.002)).toBeCloseTo(0.006);
    // Run 154463d9b2f1: the top read 3337 as found and 3337 at +15, the light-load check was declaring the offset dead,
    // but the sustained throughput rose from 3889 to 3927 Gsteps/s (+1.0 %; 12,536 → 12,661 points): the offset counts on the cap.
    expect(judgeAdditivity(3337, 3337, 15, 15)).toBe('undecided');
    expect(gainedOnCap(null, null, 5, 3927.12, 3889.04, throughputNoise(0.0004))).toBe(true);
    // The same rung with the throughput inside the noise and the mean clock flat: nothing gained.
    expect(gainedOnCap(3262, 3260, 5, 3890.0, 3889.04, throughputNoise(0.0004))).toBe(false);
    // The mean clock alone can show it: 3275 against 3260 sustained is a shifted curve at the same watts.
    expect(gainedOnCap(3275, 3260, 5, 3889.0, 3889.04, 0.003)).toBe(true);
    // A figure missing on either side cannot show a gain.
    expect(gainedOnCap(null, 3260, 5, null, 3889.04, 0.003)).toBe(false);
    // At +30 with the top still 3337 (the VF table's top) and nothing gained: the verdict is the top of the table, a converged result, not a refusal.
    expect(judgeAdditivity(3337, 3337, 30, 15)).toBe('failed');
    expect(isRefusal('top-of-table')).toBe(false);
    expect(converged('top-of-table')).toBe(true);
    expect(confidence(true, true, 0, false, true)).toBe('medium');
  });

  it("the user's cap (plan §16, 'never test above'): a rung whose predicted clock would pass it is not written; empty is no cap", () => {
    expect(capExceeded(3337, 15, 3300)).toBe(true);
    expect(capExceeded(3285, 15, 3300)).toBe(false);
    expect(capExceeded(3285, 30, 3300)).toBe(true);
    expect(capExceeded(3337, 15, null)).toBe(false);
    expect(capExceeded(16037, 15, 16050)).toBe(true);
    expect(capsForStart({ coreCapMhz: null, memCapMhz: null })).toBeUndefined();
    expect(capsForStart({ coreCapMhz: 3300, memCapMhz: null })).toEqual({ coreCapMhz: 3300, memCapMhz: undefined });
    expect(capsForStart({ coreCapMhz: 0, memCapMhz: 16100 })).toEqual({ coreCapMhz: undefined, memCapMhz: 16100 });
  });

  it("the core ladder's movement guard compares consecutive rungs once the top stops tracking the offset (the dev box: 3337 at +15, +30, +45, +60 is no tool), memory keeps the linear rule", () => {
    // The old linear rule fired at +60: expected 3382 against 3337 held, 45 off.
    expect(moved(3337, 3322, 60, 15)).toBe(true);
    // Against the rung below: 3337 after 3337 is nothing moving.
    expect(movedFromPrevious(3337, 3337, 3322, 60, 15)).toBe(false);
    expect(movedFromPrevious(3337, 3322, 3322, 30, 15)).toBe(false);
    // A tool re-applying its profile between two rungs: a drop or a jump of more than a rung plus a bin.
    expect(movedFromPrevious(3000, 3337, 3322, 45, 15)).toBe(true);
    expect(movedFromPrevious(3382, 3337, 3322, 45, 15)).toBe(true);
    // The first rung has no previous: the linear rule once.
    expect(movedFromPrevious(3337, null, 3322, 15, 15)).toBe(false);
    expect(movedFromPrevious(3400, null, 3322, 15, 15)).toBe(true);
  });

  it('a steady vendor tune is the baseline; only a held clock more than a rung plus a bin off the expected is a tool changing clocks', () => {
    expect(moved(3045, 3000, 45, 15)).toBe(false);
    expect(moved(3060, 3000, 45, 15)).toBe(false);
    expect(moved(3015, 3000, 45, 15)).toBe(false);
    expect(moved(3076, 3000, 45, 15)).toBe(true);
    expect(moved(3000, 3000, 45, 15)).toBe(true);
    expect(moved(16052, 15837, 15, 15)).toBe(true);
  });

  it('a fake sampler: a steady GPU Tweak tune climbs rung after rung; a fan-curve app re-applying its profile mid-run is caught on the first rung it moves', () => {
    const guard = (baselineHeld: number, rungs: readonly [offset: number, held: number][]) => rungs.find(([offset, held]) => moved(held, baselineHeld, offset, 15))?.[0] ?? null;
    expect(guard(3000, [[15, 3015], [30, 3030], [45, 3045], [60, 3075], [75, 3060]])).toBeNull();
    expect(guard(3000, [[15, 3015], [30, 3030], [45, 3076], [60, 3091]])).toBe(45);
    expect(guard(3000, [[15, 3015], [30, 2711]])).toBe(30);
    expect(guard(16008, [[15, 16023], [30, 16038], [45, 16053]])).toBeNull();
    expect(guard(15837, [[15, 15852], [30, 16067]])).toBe(30);
  });

  it('a top-of-curve clock within a bin of the driver ceiling ends the core ladder; no ceiling known never does', () => {
    expect(atCeiling(3075, 3090)).toBe(true);
    expect(atCeiling(3090, 3090)).toBe(true);
    expect(atCeiling(3060, 3090)).toBe(false);
    expect(atCeiling(3090, null)).toBe(false);
  });
});

describe('failure ladder verdicts', () => {
  const core: RungFacts = { ladder: 'core', thermalFraction: 0, throughput: 10, bestThroughput: 10, bandwidth: 1400, bestBandwidth: 1400, spread: 0, baselineSpread: null };
  const memory: RungFacts = { ladder: 'memory', thermalFraction: 0, throughput: null, bestThroughput: null, bandwidth: 1400, bestBandwidth: 1400, spread: 0.01, baselineSpread: 0.01 };

  it('reads the worker exit codes per half: 2 is stage 1, 10 is stage 3, 0 passes on to the judgement', () => {
    expect(patternVerdict(2, false)).toEqual({ verdict: 'unstable', stage: 1 });
    expect(patternVerdict(10, false)).toEqual({ verdict: 'device-lost', stage: 3 });
    expect(patternVerdict(0, false)).toEqual({ verdict: 'stable', stage: null });
    expect(judge(core)).toEqual({ verdict: 'stable', stage: null, stop: null });
  });

  it('a stale heartbeat is a TDR whatever the exit code says; exit 1 and 3 are not verdicts', () => {
    expect(patternVerdict(0, true)).toEqual({ verdict: 'device-lost', stage: 3 });
    expect(patternVerdict(1, false)).toBeNull();
    expect(patternVerdict(3, false)).toBeNull();
  });

  it('the power cap is the normal state: a core rung at 77 % SwPowerCap is judged on sustained throughput, never on the cap bit', () => {
    expect(THROTTLE_BITS & 0x4).toBe(0x4);
    expect(THERMAL_BITS & 0x4).toBe(0);
    expect(judge({ ...core, throughput: 10.05 })).toEqual({ verdict: 'stable', stage: null, stop: null });
    expect(judge({ ...core, throughput: 9.71 })).toEqual({ verdict: 'stable', stage: null, stop: null });
    expect(judge({ ...core, throughput: 9.69 })).toEqual({ verdict: 'unstable', stage: 2, stop: 'throughput' });
    expect(throughputFell(9.69, 10)).toBe(true);
    expect(throughputFell(9.7, null)).toBe(false);
  });

  it('a thermal-limit bit on more than 5 % of the sustained samples is the cooler: invalid, the ladder stops', () => {
    expect(judge({ ...core, thermalFraction: 0.06 })).toEqual({ verdict: 'invalid', stage: null, stop: 'thermal' });
    expect(judge({ ...core, thermalFraction: 0.05 })).toEqual({ verdict: 'stable', stage: null, stop: null });
    // One set of bits for the collector's ladder stop and the page's live pill: heat and the board's brake, never the power cap.
    expect(THERMAL_BITS).toBe(0x8 | 0x20 | 0x40 | 0x80);
    expect(THERMAL_BITS).toBe(THERMAL_OR_BRAKE);
  });

  it("memory: bandwidth must not fall under the best certified (3 %, or three times the as-found repeats' spread); the hash is the halves' business", () => {
    expect(regressed(1358, 1400)).toBe(false);
    expect(regressed(1357, 1400)).toBe(true);
    expect(regressed(1000, null)).toBe(false);
    expect(judge({ ...memory, bandwidth: 1357 })).toEqual({ verdict: 'unstable', stage: 2, stop: 'bandwidth' });
    expect(regressionFloor(0.09)).toBeCloseTo(0.27);
    expect(regressionFloor(0.005)).toBe(0.03);
    expect(judge({ ...memory, bandwidth: 1330, bestBandwidth: 1451, spread: 0.09, baselineSpread: 0.09 })).toEqual({ verdict: 'stable', stage: null, stop: null });
    expect(judge({ ...memory, spread: 0.11 })).toEqual({ verdict: 'invalid', stage: null, stop: 'inconsistent' });
    expect(judge({ ...core, bandwidth: 1000 })).toEqual({ verdict: 'stable', stage: null, stop: null });
  });

  it('a scored run is a mean of its repeats and a spread', () => {
    expect(median([1451, 1330, 1409])).toBe(1409);
    expect(spread([1413, 1420])).toBeCloseTo(7 / 1416.5);
    expect(spread([1415])).toBe(0);
  });

  it('stages: hash 1, throughput or bandwidth 2, driver reset 3; the other stops are not failures', () => {
    expect(stage('hash')).toBe(1);
    expect(stage('throughput')).toBe(2);
    expect(stage('bandwidth')).toBe(2);
    expect(stage('device-lost')).toBe(3);
    expect(stage('thermal')).toBeNull();
    expect(isFailure('additivity')).toBe(false);
    expect(converged('ceiling')).toBe(true);
    expect(converged('driver-max')).toBe(true);
    expect(converged('cap')).toBe(false);
    expect(converged('hash')).toBe(true);
  });

  it("the official run's failure steps the failing ladder down one fine step: bandwidth names the memory, throughput the core, a silent error or a reset both; never below the baseline", () => {
    expect(failingLadders('bandwidth')).toEqual(['memory']);
    expect(failingLadders('throughput')).toEqual(['core']);
    expect(failingLadders('hash')).toEqual(['memory', 'core']);
    expect(failingLadders('device-lost')).toEqual(['memory', 'core']);
    const pair = { coreKhz: 364_000, memKhz: 2_096_000 };
    const baseline = { coreKhz: 319_000, memKhz: 2_036_000 };
    expect(stepDown(pair, baseline, ['memory'])).toEqual({ coreKhz: 364_000, memKhz: 2_091_000 });
    expect(stepDown(pair, baseline, ['memory', 'core'])).toEqual({ coreKhz: 359_000, memKhz: 2_091_000 });
    expect(stepDown({ coreKhz: 319_000, memKhz: 2_041_000 }, baseline, ['memory', 'core'])).toEqual({ coreKhz: 319_000, memKhz: 2_036_000 });
  });
});

describe('confidence', () => {
  it('is high only for a clean converged result above the card as found', () => {
    expect(confidence(true, false, 0, false, true)).toBe('high');
    expect(confidence(true, false, 1, false, true)).toBe('medium');
    expect(confidence(true, false, 0, true, true)).toBe('medium');
    expect(confidence(true, true, 0, false, true)).toBe('medium');
    expect(confidence(false, false, 0, false, true)).toBe('low');
    expect(confidence(true, false, 0, false, false)).toBe('low');
  });
});

describe('revert at start (mirrored from TuneStateMachine.AtStart): IDLE → PENDING → IDLE, REVERTED only as attribution', () => {
  const c = { coreKhz: 15_000, memKhz: 0, coreMhz: 15, memMhz: 0 };

  it('reverts a PENDING rung at every start and calls it a hang unless the collector marked its exit path', () => {
    expect(atStart({ state: 'PENDING', candidate: c, orderlyStop: false })).toEqual({ action: 'revert', hang: true });
    expect(atStart({ state: 'PENDING', candidate: c, orderlyStop: true })).toEqual({ action: 'revert', hang: false });
  });

  it('does nothing at IDLE or REVERTED, or without a rung', () => {
    expect(atStart({ state: 'IDLE', candidate: null, orderlyStop: false })).toEqual({ action: 'none', hang: false });
    expect(atStart({ state: 'REVERTED', candidate: null, orderlyStop: false })).toEqual({ action: 'none', hang: false });
    expect(atStart({ state: 'PENDING', candidate: null, orderlyStop: false })).toEqual({ action: 'none', hang: false });
  });
});

describe('export text (mirrored from TuneSupervisor.ExportText, ScoreLine and HoldsNowLine)', () => {
  const d = (coreMhz: number, memMhz = 0) => ({ coreKhz: coreMhz * 1000, memKhz: memMhz * 1000, coreMhz, memMhz });
  const scored = (deltas: ReturnType<typeof d>, gsps: number, gbs: number, held: { smMhz: number; memMhz: number }, top: number): ScoredRun => ({
    deltas,
    repeats: 2,
    verdict: 'stable',
    score: score(gsps, gbs),
    held,
    topSmMhz: top,
    note: 'every pass matched',
    telemetry: null,
    steppedDown: false
  });
  const base: TuneResult = {
    kind: 'hunt',
    deltas: d(45, 60),
    baseline: d(0),
    baselineHeld: { smMhz: 3225, memMhz: 16008 },
    heldAtCertified: { smMhz: 3270, memMhz: 16068 },
    firstFailure: { ladder: 'core', reason: 'hash', offsetMhz: 60, stage: 1, note: '+60 MHz core: silent error' },
    stops: [
      { ladder: 'memory', reason: 'cap', offsetMhz: 60, stage: null, note: 'memory ladder stopped at the requested cap of 4 rungs' },
      { ladder: 'core', reason: 'hash', offsetMhz: 60, stage: 1, note: '+60 MHz core: silent error' }
    ],
    bandwidthGBs: 1451,
    referenceHash: 'bbcc4652a31654c5',
    confidence: 'high',
    foundAt: '2026-09-17T01:56:10Z',
    certified: { coreMhz: 45, memMhz: 60 },
    vendor: null,
    asFound: scored(d(0), 3832.8, 1438, { smMhz: 3225, memMhz: 16008 }, 3326),
    official: scored(d(45, 60), 3889.5, 1441.2, { smMhz: 3270, memMhz: 16068 }, 3371),
    holdsNow: { smMhz: 3225, memMhz: 16037 },
    rungs: []
  };

  it('reads the card as found, the certified values on top, the first failure, the score line, the vendor slider line and the end-of-run truth', () => {
    const text = exportText(base, '2026-09-16');
    expect(text).toContain('Strata Tune headroom, 2026-09-16 (high confidence');
    expect(text).toContain('the card as found holds 3225 / 16008; certified +45 core / +60 memory on top → 3270 / 16068; first silent error at +60 core (stage 1)');
    // 3889.5 Gsteps/s + 1441.2 GB/s = 6797 + 5015 = 11,812 against as found 6698 + 5003 = 11,701.
    expect(scoreLine(base)).toBe('11,812 points at +45 / +60: +0.9 % over your current tune (11,701), +18.1 % over an estimated reference 5090 (10,000)');
    expect(text).toContain('11,812 points at +45 / +60');
    expect(text).toContain('Type into GPU Tweak / Afterburner: core +45, memory +120');
    expect(text).toContain('Type these into your vendor tool; Strata Tune left the card as it found it.');
    expect(holdsNowLine(base)).toBe('The card holds 3225 / 16037 now; as found 3225 / 16008 (the same within 1 %).');
    expect(text).toContain('Nothing changed voltage, power limits or fans');
    // One line per ladder stop, so the file says why each ladder ended, not only when a stage failed.
    expect(text).toContain('memory ladder ended: memory ladder stopped at the requested cap of 4 rungs');
    expect(text).toContain('core ladder ended: +60 MHz core: silent error');
    const table = exportText({ ...base, deltas: d(0, 60), certified: { coreMhz: 0, memMhz: 60 }, firstFailure: null, stops: [base.stops[0], { ladder: 'core', reason: 'top-of-table', offsetMhz: 0, stage: null, note: 'the card already runs at the top of its clock table (3337 MHz as found); no core headroom above it through offsets, certified +0 core' }] }, '2026-09-17');
    expect(table).toContain('core ladder ended: the card already runs at the top of its clock table (3337 MHz as found); no core headroom above it through offsets, certified +0 core');
    expect(leftSentence(base)).toContain('the P0 offsets are back where they were');
    expect(leftSentence({ ...base, vendor: { coreMhz: 319, memMhz: 4072 }, baseline: d(319, 2036) })).toContain('press Apply in the vendor tool once');
    expect(exportText({ ...base, baseline: d(100, 200) }, '2026-09-16')).toContain('your tune (P0 core +100 / memory +200) holds 3225 / 16008');
  });

  it("the user's GPU Tweak tune reproduced through our route: the slider line is the whole tune to set, and the tune was put back, never 0", () => {
    const onTop = exportText({ ...base, baseline: d(319, 2036), vendor: { coreMhz: 319, memMhz: 4072 } }, '2026-09-16');
    expect(onTop).toContain('your tune (core +319 / memory +4072 on the slider) holds 3225 / 16008; certified +45 core / +60 memory on top → 3270 / 16068');
    expect(onTop).toContain('Type into GPU Tweak / Afterburner: core +364, memory +4192 (your +319 / +4072 plus core +45, memory +120 on top in slider units');
    expect(onTop).toContain("your tune was put back through the driver's P0 offsets (core +319 / memory +2036 NVML MHz)");
  });

  it("the end-of-run truth: 'the card holds X / Y now; as found X0 / Y0', and 're-apply in your vendor tool' when they differ by more than 1 % (run 74c3442b1294 left 2947 / 14001)", () => {
    expect(holdsNowLine({ ...base, holdsNow: { smMhz: 2947, memMhz: 14001 } })).toBe('The card holds 2947 / 14001 now; as found 3225 / 16008: re-apply in your vendor tool.');
    expect(exportText({ ...base, holdsNow: { smMhz: 2947, memMhz: 14001 } }, '2026-09-16')).toContain('re-apply in your vendor tool');
    expect(holdsNowLine({ ...base, holdsNow: null })).toBe('The card was not measured after the restore (the run was stopped or ended early); as found it held 3225 / 16008: check the vendor tool shows your tune.');
    expect(holdsNowLine({ ...base, holdsNow: null, baselineHeld: null })).toBe('The card was not measured after the restore; check the vendor tool shows your tune.');
  });

  it('the score line without an official run is the as-found score alone, and names a failed official run; a stepped-down official run says so', () => {
    expect(scoreLine({ ...base, official: null })).toBe('11,701 points as found: +17.0 % over an estimated reference 5090 (10,000)');
    expect(scoreLine({ ...base, official: { ...base.official!, verdict: 'unstable', score: null, note: 'silent error' } })).toBe('11,701 points as found: +17.0 % over an estimated reference 5090 (10,000); the official run of the certified pair failed (silent error)');
    expect(scoreLine({ ...base, official: { ...base.official!, steppedDown: true } })).toContain("; the official run passed one fine step below the ladders' rungs");
    expect(scoreLine({ ...base, asFound: null })).toBeNull();
    expect(exportText({ ...base, asFound: null, official: null }, '2026-09-16')).not.toContain('points');
  });

  it('a driver reset and a regression are named as such; nothing certified is not a value set', () => {
    expect(exportText({ ...base, firstFailure: { ladder: 'memory', reason: 'device-lost', offsetMhz: 75, stage: 3, note: '' } }, '2026-09-16')).toContain('first driver reset at +75 memory (stage 3)');
    expect(exportText({ ...base, firstFailure: { ladder: 'memory', reason: 'bandwidth', offsetMhz: 75, stage: 2, note: '' } }, '2026-09-16')).toContain('first regression at +75 memory (stage 2)');
    const none = exportText({ ...base, deltas: d(0), certified: { coreMhz: 0, memMhz: 0 }, heldAtCertified: { smMhz: 3225, memMhz: 16008 }, official: null }, '2026-09-16');
    expect(none).toContain('certified +0 core / +0 memory on top → 3225 / 16008');
    expect(none).toContain('these are not values to type anywhere');
    expect(exportText({ ...base, baselineHeld: null, firstFailure: null }, '2026-09-16')).toContain('certified +45 core / +60 memory on top of the card as found\n');
  });
});

describe('device classes (plan §17d): every score names its class, and every class reads right with nothing empty', () => {
  const dir = join(__dirname, 'fixtures', 'classes');
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith('.tune.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { class: DeviceClass; snapshot: Parameters<typeof deviceClass>[0]; tune: { status: TuneStatus; export: TuneExport | null } });

  it('has one fixture per class', () => {
    expect(fixtures.map((f) => f.class).sort()).toEqual(['ai-laptop-or-pc', 'gaming-laptop', 'high-end-pc', 'laptop-no-dgpu', 'mid-range-pc']);
    expect(Object.keys(DEVICE_CLASS_LABEL).sort()).toEqual(fixtures.map((f) => f.class).sort());
  });

  it.each(fixtures.map((f) => [f.class, f] as const))('%s: the snapshot classifies as itself', (cls, f) => {
    expect(deviceClass(f.snapshot)).toBe(cls);
    expect(DEVICE_CLASS_LABEL[cls]).toMatch(/\S/);
  });

  it.each(fixtures.map((f) => [f.class, f] as const))('%s: Headroom is either a scored result with nothing empty or one sentence saying why it is unavailable', (_cls, f) => {
    const { status, export: exp } = f.tune;
    expect(status.estimateMinutes).toBe(16);
    if (!status.nvapi.available) {
      // The absence is explained: no supported GPU, NVIDIA only, ARM64.
      expect(status.nvapi.reason).toMatch(/no supported GPU|NVIDIA cards only/);
      expect(status.result).toBeNull();
      expect(exp).toBeNull();
      return;
    }
    const r = status.result!;
    expect(exp).not.toBeNull();
    expect(r.asFound?.score?.points).toBeGreaterThan(0);
    expect(r.official?.score?.points).toBeGreaterThan(r.asFound!.score!.points);
    expect(r.rungs.length).toBeGreaterThan(0);
    for (const rung of r.rungs) {
      if (rung.verdict === 'stable') expect(rung.score?.points).toBeGreaterThan(0);
      else expect(rung.score).toBeNull();
    }
    const text = exportText(r, '2026-09-17');
    expect(text).not.toMatch(/undefined|NaN|null/);
    expect(text).toMatch(/points at \+\d+ \/ \+\d+: [+-]\d+\.\d % over your current tune/);
    expect(text).toMatch(/The card holds \d+ \/ \d+ now; as found \d+ \/ \d+/);
    // The telemetry rows the sheet tabulates: a sensor the card lacks is null, never a zero or a dash.
    const t = r.official!.telemetry!;
    expect(t.gpu!.coreMhz.max).toBeGreaterThanOrEqual(t.gpu!.coreMhz.avg);
    expect(t.gpu!.boardW.max).toBeLessThanOrEqual(t.gpu!.powerCapW);
    expect(Object.values(t.gpu!.limitShare).every((s) => s >= 0 && s <= 1)).toBe(true);
    if (f.class === 'gaming-laptop') {
      expect(t.gpu!.memoryJunctionC).toBeNull();
      expect(t.gpu!.fanPercent).toBeNull();
    } else {
      expect(t.gpu!.memoryJunctionC!.max).toBeGreaterThan(0);
      expect(t.gpu!.fanPercent!.max).toBeGreaterThan(0);
    }
  });

  it("the high-end fixture is this box on top of its GPU Tweak tune: the export speaks in the slider's units and the card holds the tune after the run", () => {
    const high = fixtures.find((f) => f.class === 'high-end-pc')!;
    const r = high.tune.status.result!;
    expect(r.vendor).toEqual({ coreMhz: 319, memMhz: 4072 });
    expect(r.baseline.memMhz).toBe(2036);
    const text = exportText(r, '2026-09-17');
    expect(text).toContain('Type into GPU Tweak / Afterburner: core +364, memory +4192 (your +319 / +4072 plus core +45, memory +120 on top in slider units');
    expect(text).toContain('The card holds 3225 / 16037 now; as found 3225 / 16008 (the same within 1 %).');
    expect(holdsDiffer(r.baselineHeld!, r.holdsNow!)).toBe(false);
    expect(high.tune.export!.referencePoints).toBe(REFERENCE_POINTS);
  });
});
