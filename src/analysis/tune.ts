/**
 * The pure half of the collector's tune supervisor (plan section 16), mirrored from
 * collector/StrataTune.Collector/TuneLadder.cs, TuneState.cs, StrataTune.Shared/Tune.cs
 * (VendorUnits, TuneScoring, TuneTiming) and TuneSupervisor.ExportText so the ladder maths,
 * the vendor-tune decision, the scoring, the revert-at-start rule, the unit conversion and
 * the export text are tested here without a GPU. The collector is the one that runs them; a
 * change to a constant or a rule lands in both files together. Offsets are in NVAPI's kHz,
 * clocks in NVML's MHz.
 */
import type { HeldClocks, PstateDeltas, ScoredRun, TuneCandidate, TuneConfidence, TuneDeltas, TuneLadderKind, TunePattern, TuneResult, TuneRollback, TuneRunKind, TuneScore, TuneStopReason, TuneVerdict } from '../collector-types';
import type { Settings } from '../settings';

/** The user's rule (2026-09-16): steps of 5–15 MHz on top of whatever the card holds. */
export const CORE_STEP_KHZ = 15_000;
export const CORE_RESOLUTION_KHZ = 5_000;
export const MEM_STEP_KHZ = 15_000;
export const MEM_RESOLUTION_KHZ = 5_000;
/**
 * The climb must lift the held clock by this share of the offset written, or the driver is not
 * adding our offset on top of the card's tune. The top of the curve moves in half bins between
 * minutes (3322 / 3330 / 3337 on the dev box), so one +15 rung can read +7 either way: 0.6 x 15 = 9
 * is undecided there and the +30 rung decides (added reads at least +22, not added at most +7).
 */
export const ADDITIVITY_SHARE = 0.6;
/** NVML reports the SM clock on 15 MHz boost bins, so a held clock is compared with a tolerance of one rung plus one bin. */
export const CLOCK_BIN_MHZ = 15;
/** A core rung under a power cap is judged by work: heavy throughput may not fall more than this under the best certified rung. */
export const THROUGHPUT_REGRESSION = 0.03;
/** Stage 2 for memory: bandwidth this far under the best seen at a lower rung is the memory failing, not noise. */
export const BANDWIDTH_REGRESSION = 0.03;
/** The measured floor: this many times the spread of the baseline rung's own passes, when that is larger. */
export const NOISE_FLOOR_MULTIPLE = 3;
/** A thermal-limit bit on more than this share of the heavy samples ends the ladder: the cooler, not the clock, is the limit. */
export const THERMAL_FRACTION_LIMIT = 0.05;
/** The cooler's or the board's limit, the one set the ladder ends on and the live pill names (nvmlBits THERMAL_OR_BRAKE): HwSlowdown, SwThermalSlowdown, HwThermalSlowdown, HwPowerBrakeSlowdown (dependencies.md). */
export const THERMAL_BITS = 0x8 | 0x20 | 0x40 | 0x80;
/** Every limit bit, for the reported share only: SwPowerCap, HwSlowdown, SwThermalSlowdown, HwThermalSlowdown, HwPowerBrakeSlowdown. */
export const THROTTLE_BITS = 0x4 | 0x8 | 0x20 | 0x40 | 0x80;
/** A scored run whose repeats' bandwidths disagree by more than this proves nothing. */
export const SWEEP_SPREAD_LIMIT = 0.1;
/** GPU Tweak III and Afterburner show the memory slider as the effective rate, twice NVML's memory clock. */
export const VENDOR_MEMORY_FACTOR = 2;

/**
 * A rung is a minute (plan section 16, 'a rung is a minute of realistic load'): 30 s variable
 * (heavy bursts 2–4 s apart with light or idle gaps, hash-checked on every burst, the top of
 * the curve measured), then 30 s sustained (hash-checked on every dispatch; its throughput,
 * held clocks and closing stream pass score the rung). Both ladders run the same shape.
 */
export const RUNG_SHAPE: readonly { pattern: TunePattern; seconds: number }[] = [
  { pattern: 'variable', seconds: 30 },
  { pattern: 'sustained', seconds: 30 }
];
/** The as-found card and the certified pair are scored over two repeats of the shape: two minutes. */
export const SCORED_REPEATS = 2;
/** After the restore the card's held clocks are read under this much sustained load, the same load the as-found figure came from. */
export const HOLDS_NOW_SECONDS = 10;
/** Held clocks after the restore more than this far from the card as found mean "re-apply in your vendor tool" (plan section 16, rule 4). */
export const HOLDS_NOW_TOLERANCE = 0.01;

export function holdsDiffer(asFound: HeldClocks, now: HeldClocks): boolean {
  return Math.abs(now.smMhz - asFound.smMhz) > HOLDS_NOW_TOLERANCE * asFound.smMhz || Math.abs(now.memMhz - asFound.memMhz) > HOLDS_NOW_TOLERANCE * asFound.memMhz;
}

/**
 * Plan section 16, 'every rung is scored' (TuneScoring in StrataTune.Shared/Tune.cs): one fixed
 * scale on which a reference RTX 5090 at its reference clocks (2407 MHz boost, 28 Gbps memory)
 * scores 10,000, half compute and half bandwidth. The compute reference is the worker's own
 * hash kernel at 2407 MHz: measured on the dev box's 5090 at 3502.40 Gsteps/s with the SM
 * clock held at 2947 MHz (sustained load at the 600 W cap), one step costs 21760 lanes × 2947
 * MHz ÷ 3502.40 G = 18.3 lane-clocks, so at 2407 MHz the reference does 3502.40 × 2407 ÷ 2947
 * = 2861 Gsteps/s (the Blackwell whitepaper's 104.8 FP32 TFLOPS is the same 21760 lanes × 2
 * FLOP × 2407 MHz; the kernel is integer work, so its own measured cost is the honest scale).
 * The bandwidth reference is the worker's 1 GiB stream copy at 28 Gbps: about 80 % of the
 * 1792 GB/s bus, 1437 GB/s measured on the dev box at the 14001 MHz memory clock.
 */
export const REFERENCE_POINTS = 10_000;
export const COMPUTE_SHARE = 5_000;
export const BANDWIDTH_SHARE = 5_000;
export const REFERENCE_COMPUTE_GSPS = 2861;
export const REFERENCE_BANDWIDTH_GBS = 1437;

export const computePoints = (throughputGsps: number) => Math.round((COMPUTE_SHARE * throughputGsps) / REFERENCE_COMPUTE_GSPS);
export const bandwidthPoints = (bandwidthGBs: number) => Math.round((BANDWIDTH_SHARE * bandwidthGBs) / REFERENCE_BANDWIDTH_GBS);

/** Null without both figures: a rung that failed before its sustained half has no score. */
export function score(throughputGsps: number | null, bandwidthGBs: number | null): TuneScore | null {
  if (throughputGsps === null || bandwidthGBs === null) return null;
  const c = computePoints(throughputGsps);
  const b = bandwidthPoints(bandwidthGBs);
  return { points: c + b, computePoints: c, bandwidthPoints: b, throughputGsps, bandwidthGBs };
}

/** "+1.1 % over your current tune": the relative change of one score against another, in percent. */
export const percentOver = (points: number, over: number) => (over > 0 ? ((points - over) * 100) / over : 0);

/** "+1.1 %" / "−0.4 %", the way the export prints a percentage. */
export const signedPercent = (pct: number) => `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)} %`;

/**
 * The time estimate shown before Start (TuneTiming in StrataTune.Shared/Tune.cs): a rung is a
 * minute, the as-found and official scored runs two minutes each, a typical ladder six rungs
 * (the climb to its first failure and the bisect) or the request's cap, and the vendor rung
 * one more minute when a vendor tune is entered: 2 + 6 + 6 + 2 = about 16 minutes for a hunt.
 */
export const RUNG_MINUTES = 1;
export const SCORED_RUN_MINUTES = 2;
export const TYPICAL_RUNGS = 6;

export function estimateMinutes(kind: TuneRunKind, maxCandidates: number | null = null, vendor = false): number {
  const ladders = kind === 'hunt' ? 2 : 1;
  const rungs = maxCandidates !== null && maxCandidates > 0 ? maxCandidates : TYPICAL_RUNGS;
  return SCORED_RUN_MINUTES + ladders * rungs * RUNG_MINUTES + SCORED_RUN_MINUTES + (vendor ? RUNG_MINUTES : 0);
}

/**
 * The ladders an official run's failure steps down one fine step (plan section 16: 'a failure
 * in the 2-minute run steps the failing ladder down one fine step and re-runs it once'): a
 * bandwidth regression names the memory, a throughput fall the core; a silent error or a
 * driver reset names neither, so both come down.
 */
export function failingLadders(reason: TuneStopReason): TuneLadderKind[] {
  if (reason === 'bandwidth') return ['memory'];
  if (reason === 'throughput') return ['core'];
  return ['memory', 'core'];
}

/** One fine step down on the given ladders, never below the baseline (kHz in, kHz out). */
export function stepDown(deltas: Pick<TuneDeltas, 'coreKhz' | 'memKhz'>, baseline: Pick<TuneDeltas, 'coreKhz' | 'memKhz'>, ladders: readonly TuneLadderKind[]): Pick<TuneDeltas, 'coreKhz' | 'memKhz'> {
  return {
    coreKhz: ladders.includes('core') ? Math.max(baseline.coreKhz, deltas.coreKhz - CORE_RESOLUTION_KHZ) : deltas.coreKhz,
    memKhz: ladders.includes('memory') ? Math.max(baseline.memKhz, deltas.memKhz - MEM_RESOLUTION_KHZ) : deltas.memKhz
  };
}

/** The next rung above the current one, or null at the driver's ceiling. */
export function nextRung(currentKhz: number, stepKhz: number, maxKhz: number): number | null {
  return currentKhz + stepKhz <= maxKhz ? currentKhz + stepKhz : null;
}

/** The rung between the last certified and the first failing value, halfway down to the resolution's grid, or null once the gap is at the resolution. */
export function midpoint(stableKhz: number, failingKhz: number, resolutionKhz: number): number | null {
  const gap = failingKhz - stableKhz;
  return gap > resolutionKhz ? stableKhz + Math.max(resolutionKhz, Math.trunc(gap / 2 / resolutionKhz) * resolutionKhz) : null;
}

/**
 * A vendor tool's tune on the card: a held clock above the driver's clock ceiling plus our
 * own P0 offset plus a bin is an offset applied by a route ours does not read. Measured on
 * the dev box, the route does not add to it either: the first NvAPI_GPU_SetPstates20 write,
 * even 0 / 0, took GPU Tweak's +319 / +4072 off the card (memory 16008 → 14001 within the
 * rung), so a foreign tune is refused before anything is written. Unknown ceilings cannot tell.
 */
export function foreignTune(heldMhz: number, ceilingMhz: number | null, ourOffsetMhz: number): boolean {
  return ceilingMhz !== null && heldMhz > ceilingMhz + ourOffsetMhz + CLOCK_BIN_MHZ;
}

/** The additivity check: the held clock must have risen by about the offset written so far. */
export function additive(heldMhz: number, baselineHeldMhz: number, offsetMhz: number): boolean {
  return heldMhz >= baselineHeldMhz + ADDITIVITY_SHARE * offsetMhz;
}

export type Additivity = 'passed' | 'undecided' | 'failed';

/**
 * What the climb knows after a rung at `offsetMhz` above the baseline (the collector's
 * TuneLadder.JudgeAdditivity): passed once the held clock is up by the share of the whole
 * offset; failed when it fell (the write replaced the tune) or when two rungs are on and it
 * still has not shown; undecided in between, so a first rung half a bin up waits for the second.
 */
export function judgeAdditivity(heldMhz: number, baselineHeldMhz: number, offsetMhz: number, rungMhz: number): Additivity {
  if (additive(heldMhz, baselineHeldMhz, offsetMhz)) return 'passed';
  if (heldMhz < baselineHeldMhz || offsetMhz >= 2 * rungMhz) return 'failed';
  return 'undecided';
}

/**
 * A rung that is one of the scored runs (the as-found card or the official pair): the
 * collector built before 2026-09-17 listed them among `rungs` as well as under `asFound` /
 * `official`, and a result it wrote is still on disk (run 154463d9b2f1), so the score climb
 * and the sheet's rung table drop them by identity (the same offsets, verdict and note)
 * rather than drawing the as-found card a second time as "−2036".
 */
export function isScoredRun(c: Pick<TuneCandidate, 'deltas' | 'verdict' | 'note'>, s: ScoredRun | null): boolean {
  return !!s && c.deltas.coreKhz === s.deltas.coreKhz && c.deltas.memKhz === s.deltas.memKhz && c.verdict === s.verdict && c.note === s.note;
}

/**
 * The vendor-tool guard, narrowed to the card as found: a tune that is applied and steady is
 * the baseline; a tool re-applying a profile mid-run moves the held clock while our offset
 * is constant. Moved is a held clock more than a rung plus a bin away from where the
 * baseline plus our offset puts it. The memory clock holds the ceiling plus the offset
 * exactly, so this linear rule is the memory ladder's.
 */
export function moved(heldMhz: number, baselineHeldMhz: number, offsetMhz: number, rungMhz: number): boolean {
  return Math.abs(heldMhz - (baselineHeldMhz + offsetMhz)) > rungMhz + CLOCK_BIN_MHZ;
}

/**
 * The core ladder's movement guard (TuneLadder.MovedFromPrevious): the top of the curve stops
 * tracking the offset where the VF table ends (3337 MHz on the dev box whatever the offset), so
 * the core is judged against the previous certified rung's own top: a drop or a jump of more
 * than a rung plus a bin between consecutive rungs is another tool moving the clock. With no
 * previous rung the linear rule applies once.
 */
export function movedFromPrevious(topMhz: number, previousTopMhz: number | null, baselineTopMhz: number, offsetMhz: number, rungMhz: number): boolean {
  return previousTopMhz !== null ? Math.abs(topMhz - previousTopMhz) > rungMhz + CLOCK_BIN_MHZ : moved(topMhz, baselineTopMhz, offsetMhz, rungMhz);
}

/**
 * The second and third additivity signals on a power-capped card (plan section 16, 'A core cap,
 * and the top of the clock table'; TuneLadder.GainedOnCap): a core offset that cannot lift the
 * top of the curve still shifts the V/F curve where the card runs, on the cap, as a higher
 * sustained mean clock at the same watts and more work per second. Both are judged against the
 * as-found run's own spread as the noise floor, never below these floors: the sustained mean
 * wanders a few MHz between minutes with nothing changed, and the throughput repeats to a few
 * tenths of a percent (3889.73 against 3888.35 Gsteps/s on the dev box, run 154463d9b2f1).
 */
export const MEAN_CLOCK_NOISE_FLOOR_MHZ = 5;
export const THROUGHPUT_NOISE_FLOOR = 0.003;

export const meanClockNoiseMhz = (baselineSpreadMhz: number | null) => Math.max(MEAN_CLOCK_NOISE_FLOOR_MHZ, baselineSpreadMhz ?? 0);
export const throughputNoise = (baselineSpread: number | null) => Math.max(THROUGHPUT_NOISE_FLOOR, NOISE_FLOOR_MULTIPLE * (baselineSpread ?? 0));

/** Whether a core rung gained anything where the card runs: the sustained mean clock or the throughput rose over the reference by more than its noise. A figure missing on either side cannot show a gain. */
export function gainedOnCap(meanSmMhz: number | null, referenceMeanSmMhz: number | null, clockNoiseMhz: number, throughputGsps: number | null, referenceThroughputGsps: number | null, workNoise: number): boolean {
  const clockRose = meanSmMhz !== null && referenceMeanSmMhz !== null && meanSmMhz > referenceMeanSmMhz + clockNoiseMhz;
  const workRose = throughputGsps !== null && referenceThroughputGsps !== null && referenceThroughputGsps > 0 && throughputGsps > referenceThroughputGsps * (1 + workNoise);
  return clockRose || workRose;
}

/** The user's cap (TuneLadder.CapExceeded): a rung whose predicted clock, the reference plus the offset it would write, would pass "never test above" is not written. */
export function capExceeded(referenceMhz: number, offsetMhz: number, capMhz: number | null): boolean {
  return capMhz !== null && referenceMhz + offsetMhz > capMhz;
}

/** The settings' caps as the start request carries them (undefined fields are no cap), beside vendorForStart. */
export function capsForStart(s: Pick<Settings, 'coreCapMhz' | 'memCapMhz'>): { coreCapMhz?: number; memCapMhz?: number } | undefined {
  const coreCapMhz = s.coreCapMhz !== null && s.coreCapMhz > 0 ? s.coreCapMhz : undefined;
  const memCapMhz = s.memCapMhz !== null && s.memCapMhz > 0 ? s.memCapMhz : undefined;
  return coreCapMhz === undefined && memCapMhz === undefined ? undefined : { coreCapMhz, memCapMhz };
}

/** The held clock is within a bin of the driver's clock ceiling: no rung above can show. */
export function atCeiling(heldMhz: number, ceilingMhz: number | null): boolean {
  return ceilingMhz !== null && heldMhz + CLOCK_BIN_MHZ >= ceilingMhz;
}

/** The share of the best a rung may fall below before it is a regression: the fixed 3 %, or three times the baseline's spread, whichever is more. */
export function regressionFloor(baselineSpread: number | null): number {
  return Math.max(BANDWIDTH_REGRESSION, NOISE_FLOOR_MULTIPLE * (baselineSpread ?? 0));
}

export function regressed(bandwidthGBs: number, bestGBs: number | null, baselineSpread: number | null = null): boolean {
  return bestGBs !== null && bestGBs > 0 && bandwidthGBs < bestGBs * (1 - regressionFloor(baselineSpread));
}

export function throughputFell(throughput: number, best: number | null): boolean {
  return best !== null && best > 0 && throughput < best * (1 - THROUGHPUT_REGRESSION);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** (max - min) / median: the relative spread of a rung's passes. */
export function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return m > 0 ? (Math.max(...values) - Math.min(...values)) / m : 0;
}

/**
 * One pattern's verdict from the worker's exit code and the heartbeat: a device loss (stage 3),
 * a hash mismatch (stage 1), or a pass the rung's judgement takes further. Null for an exit
 * that is not a verdict at all (bad arguments, no hardware GPU): the run fails rather than
 * counting a broken worker as an unstable card.
 */
export function patternVerdict(exitCode: number, heartbeatStale: boolean): { verdict: TuneVerdict; stage: number | null } | null {
  if (heartbeatStale || exitCode === 10) return { verdict: 'device-lost', stage: 3 };
  if (exitCode === 2) return { verdict: 'unstable', stage: 1 };
  return exitCode === 0 ? { verdict: 'stable', stage: null } : null;
}

export interface RungFacts {
  ladder: TuneLadderKind;
  /** Share of the heavy samples with a thermal-limit bit. */
  thermalFraction: number;
  throughput: number | null;
  bestThroughput: number | null;
  bandwidth: number | null;
  bestBandwidth: number | null;
  /** The relative spread of this rung's passes (memory). */
  spread: number;
  baselineSpread: number | null;
}

/**
 * The rung's verdict once every pattern's hash matched: the cooler's limit first (invalid,
 * the ladder ends), then a memory rung whose passes disagree (invalid), then stage 2: a
 * core rung's heavy throughput under the best certified, or a memory rung's bandwidth
 * under the best; else stable. A power cap is not asked about (plan section 16).
 */
export function judge(f: RungFacts): { verdict: TuneVerdict; stage: number | null; stop: TuneStopReason | null } {
  if (f.thermalFraction > THERMAL_FRACTION_LIMIT) return { verdict: 'invalid', stage: null, stop: 'thermal' };
  if (f.ladder === 'memory' && f.spread > SWEEP_SPREAD_LIMIT) return { verdict: 'invalid', stage: null, stop: 'inconsistent' };
  if (f.ladder === 'core' && f.throughput !== null && throughputFell(f.throughput, f.bestThroughput)) return { verdict: 'unstable', stage: 2, stop: 'throughput' };
  if (f.ladder === 'memory' && f.bandwidth !== null && regressed(f.bandwidth, f.bestBandwidth, f.baselineSpread)) return { verdict: 'unstable', stage: 2, stop: 'bandwidth' };
  return { verdict: 'stable', stage: null, stop: null };
}

/** The failure-ladder stage of a stop reason: 1 silent error, 2 throughput or bandwidth, 3 a driver reset; null for the stops that are not failures. */
export function stage(reason: TuneStopReason): number | null {
  if (reason === 'hash') return 1;
  if (reason === 'throughput' || reason === 'bandwidth') return 2;
  if (reason === 'device-lost') return 3;
  return null;
}

export const isFailure = (reason: TuneStopReason): boolean => stage(reason) !== null;

/** The card was left untouched by the ladder: a refusal before, or at, the first write. */
export const isRefusal = (reason: TuneStopReason): boolean => reason === 'foreign-tune' || reason === 'vendor-mismatch' || reason === 'additivity';

/** A ladder converged when it ended on a failure of the silicon or on the card's own limit: the driver's range or clock ceiling, or the top of the clock table. */
export const converged = (reason: TuneStopReason): boolean => isFailure(reason) || reason === 'driver-max' || reason === 'ceiling' || reason === 'top-of-table';

/**
 * High: every ladder found its failure and bisected it with nothing in the way. Medium:
 * found, but a device loss or an invalid rung sits in the record, or a ladder hit the
 * driver's range or clock ceiling. Low: a ladder did not get there (the cap, the cooler, a
 * driver that does not add), or nothing above the card as found held.
 */
export function confidence(converged: boolean, atDriverMax: boolean, deviceLostCount: number, anyInvalid: boolean, aboveBaseline: boolean): TuneConfidence {
  if (!converged || !aboveBaseline) return 'low';
  return deviceLostCount > 0 || anyInvalid || atDriverMax ? 'medium' : 'high';
}

export type StartAction = 'none' | 'revert';

/**
 * What a start does with the state file it finds (TuneStateMachine.AtStart): PENDING with a
 * rung → revert (a rung that reached a start was never certified), called a hard hang
 * (stage 4, the flight file kept) unless the collector marked its exit path on the way out;
 * anything else → nothing.
 */
export function atStart(file: { state: TuneRollback; candidate: unknown | null; orderlyStop: boolean }): { action: StartAction; hang: boolean } {
  if (file.state !== 'PENDING' || file.candidate === null) return { action: 'none', hang: false };
  return { action: 'revert', hang: !file.orderlyStop };
}

/**
 * Our units to the vendor sliders' (StrataTune.Shared VendorUnits.Slider): the core in MHz
 * as we have it, the memory as the effective rate, twice NVML's clock. Verified on the dev
 * box twice: GPU Tweak's +4072 on the 14001 MHz ceiling is +2036 NVML → 16037 (NVML read
 * 16032), and its dropped-apply case, +3672 on the slider, is +1836 NVML → 15837, the
 * clock the card held.
 */
export function vendorSlider(ours: PstateDeltas): PstateDeltas {
  return { coreMhz: ours.coreMhz, memMhz: ours.memMhz * VENDOR_MEMORY_FACTOR };
}

/** What the vendor tool shows, as the P0 deltas (MHz) that reproduce it through our route (VendorUnits.Deltas): the slider's memory rate halved. */
export function vendorDeltas(slider: PstateDeltas): PstateDeltas {
  return { coreMhz: slider.coreMhz, memMhz: Math.trunc(slider.memMhz / VENDOR_MEMORY_FACTOR) };
}

/** The whole tune in the slider's units once the hunt is done: the tool's own values plus what was certified on top (VendorUnits.Total). */
export function sliderTotal(vendor: PstateDeltas, certified: PstateDeltas): PstateDeltas {
  return { coreMhz: vendor.coreMhz + certified.coreMhz, memMhz: vendor.memMhz + certified.memMhz * VENDOR_MEMORY_FACTOR };
}

/** The memory clock holds the ceiling plus the offset exactly, so the vendor value entered is checked against the card as found within this (NVML MHz). */
export const VENDOR_MATCH_MHZ = 60;

/** GPU Tweak's +4072 (2036 NVML) against 16008 - 14001 = 2007 held is 29 off and passes; a stale +3672 (1836) is 171 off and does not. */
export function vendorMatches(heldMhz: number, ceilingMhz: number, vendorNvmlMhz: number): boolean {
  return Math.abs(heldMhz - ceilingMhz - vendorNvmlMhz) <= VENDOR_MATCH_MHZ;
}

/** The tune written through our route must hold what the card as found held: memory within the match, the SM peak within twice it (it wobbles a bin or two at a power cap). */
export function vendorReproduced(asFound: HeldClocks, written: HeldClocks): boolean {
  return Math.abs(asFound.smMhz - written.smMhz) <= 2 * VENDOR_MATCH_MHZ && Math.abs(asFound.memMhz - written.memMhz) <= VENDOR_MATCH_MHZ;
}

/**
 * The one conversion from the settings' vendor memory offset to NVML MHz (Settings.vendorMemoryOffset):
 * GPU Tweak III and Afterburner show the effective data rate, twice NVML's memory clock, so
 * +4072 effective is +2036 NVML (the dev box: 14001 + 2036 = 16037, NVML read 16032); a tool
 * that shows the NVML clock is entered as 'nvml' and passes through.
 */
export function vendorMemoryNvml(offset: { value: number; unit: 'effective' | 'nvml' }): number {
  return offset.unit === 'effective' ? Math.trunc(offset.value / VENDOR_MEMORY_FACTOR) : Math.trunc(offset.value);
}

/**
 * The settings' vendor values as the start request's `vendor` (slider units: core MHz, memory
 * as the effective rate, which VendorUnits.Deltas halves on the collector); undefined when
 * neither is set, so a stock card is hunted from its own P0 deltas.
 */
export function vendorForStart(s: Pick<Settings, 'vendorCoreOffsetMhz' | 'vendorMemoryOffset'>): PstateDeltas | undefined {
  const coreMhz = s.vendorCoreOffsetMhz ?? 0;
  const memMhz = s.vendorMemoryOffset ? vendorMemoryNvml(s.vendorMemoryOffset) * VENDOR_MEMORY_FACTOR : 0;
  return coreMhz === 0 && memMhz === 0 ? undefined : { coreMhz, memMhz };
}

export interface VendorPlan {
  refusal: TuneStopReason | null;
  /** The baseline (MHz) the rungs sit on and every restore puts back. */
  baseline: PstateDeltas;
  /** The vendor values (slider units) the export speaks in, null from stock. */
  vendor: PstateDeltas | null;
  /** The baseline must first be written and measured as the vendor rung. */
  vendorRung: boolean;
}

/**
 * What the as-found measurement decides before the first write (TuneLadder.PlanVendor; plan
 * section 16 rules 1–3). `topSmMhz` is the highest SM clock seen as found, `found` the P0
 * deltas the driver reports as ours (MHz), `vendor` what the user entered (null or 0 / 0 is
 * nothing). A clock above the driver's ceiling plus our own offset plus a bin is a tune by a
 * route ours replaces (foreign): foreign with nothing entered refuses ('foreign-tune'); the
 * memory value entered is checked against held − ceiling within 60 NVML MHz (16008 − 14001 =
 * 2007 against +4072 ÷ 2 = 2036 passes; a stale +3672 fails; a card at stock against any
 * value fails: 'vendor-mismatch', the tune is not on the card); a foreign core with core +0
 * entered refuses; with nothing foreign the driver's deltas are the baseline (a value they
 * already reproduce is kept for the export, one they do not is refused); with a foreign tune
 * the entered value becomes the baseline and is written first as the vendor rung.
 */
export function planVendor(held: HeldClocks, topSmMhz: number | null, ceilingSmMhz: number | null, ceilingMemMhz: number | null, found: PstateDeltas, vendor: PstateDeltas | null): VendorPlan {
  const top = Math.max(held.smMhz, topSmMhz ?? 0);
  const foreignCore = foreignTune(top, ceilingSmMhz, found.coreMhz);
  const foreignMem = foreignTune(held.memMhz, ceilingMemMhz, found.memMhz);
  const entered = vendor && (vendor.coreMhz !== 0 || vendor.memMhz !== 0) ? vendor : null;
  if (!entered) return { refusal: foreignCore || foreignMem ? 'foreign-tune' : null, baseline: found, vendor: null, vendorRung: false };
  const deltas = vendorDeltas(entered);
  if (ceilingMemMhz !== null && (entered.memMhz !== 0 || foreignMem) && Math.abs(held.memMhz - ceilingMemMhz - deltas.memMhz) > VENDOR_MATCH_MHZ) {
    return { refusal: 'vendor-mismatch', baseline: found, vendor: null, vendorRung: false };
  }
  if (foreignCore && entered.coreMhz === 0) return { refusal: 'vendor-mismatch', baseline: found, vendor: null, vendorRung: false };
  if (!foreignCore && !foreignMem) {
    const held_ = Math.abs(found.coreMhz - deltas.coreMhz) <= CLOCK_BIN_MHZ && Math.abs(found.memMhz - deltas.memMhz) <= CLOCK_BIN_MHZ;
    return held_ ? { refusal: null, baseline: found, vendor: entered, vendorRung: false } : { refusal: 'vendor-mismatch', baseline: found, vendor: null, vendorRung: false };
  }
  return { refusal: null, baseline: deltas, vendor: entered, vendorRung: true };
}

/**
 * Plan section 17d, rule 3: every score names its device class, so a laptop iGPU's 600 against a
 * reference 5090's 10,000 is read as the truth about a laptop, never as a broken desktop. From the
 * snapshot's chassis, the GPUs NVML lists (a discrete NVIDIA card) and the CPU name (an NPU part).
 */
export type DeviceClass = 'laptop-no-dgpu' | 'gaming-laptop' | 'ai-laptop-or-pc' | 'mid-range-pc' | 'high-end-pc';

export const DEVICE_CLASS_LABEL: Record<DeviceClass, string> = {
  'laptop-no-dgpu': 'laptop, no discrete GPU',
  'gaming-laptop': 'gaming laptop',
  'ai-laptop-or-pc': 'AI laptop or PC',
  'mid-range-pc': 'mid-range PC',
  'high-end-pc': 'high-end PC'
};

/** Ryzen AI, Core Ultra and Snapdragon X parts carry an NPU. */
const NPU_CPU = /Ryzen\s*AI|Core\s*Ultra|Snapdragon(\(R\)|\s)*X/i;
/** The top tier: a 90-class or a 4080/5080-class desktop card, or 24 GB and more of VRAM. */
const HIGH_END_GPU = /RTX\s*(30|40|50)(80|90)|RX\s*7900|RX\s*9070\s*XT/i;

export function deviceClass(s: { chassis: { isLaptop: boolean }; cpu: { name: string }; gpus: { name: string; vram: { totalMiB: number } }[] }): DeviceClass {
  const gpu = s.gpus[0];
  if (s.chassis.isLaptop) {
    if (!gpu) return NPU_CPU.test(s.cpu.name) ? 'ai-laptop-or-pc' : 'laptop-no-dgpu';
    return 'gaming-laptop';
  }
  if (!gpu) return NPU_CPU.test(s.cpu.name) ? 'ai-laptop-or-pc' : 'mid-range-pc';
  return HIGH_END_GPU.test(gpu.name) || gpu.vram.totalMiB >= 24 * 1024 ? 'high-end-pc' : 'mid-range-pc';
}

/** The value set as TuneSupervisor.ExportText writes it (the date is the local day of `foundAt`). */
export function exportText(r: TuneResult, date: string): string {
  const c = r.certified;
  const v = vendorSlider(c);
  // A vendor tune was reproduced through our route and climbed from; a non-zero baseline without one is a tune applied by our own route.
  const found = r.vendor
    ? `your tune (core +${r.vendor.coreMhz} / memory +${r.vendor.memMhz} on the slider)`
    : r.baseline.coreMhz !== 0 || r.baseline.memMhz !== 0
      ? `your tune (P0 core +${r.baseline.coreMhz} / memory +${r.baseline.memMhz})`
      : 'the card as found';
  const held =
    r.baselineHeld && r.heldAtCertified
      ? `${found} holds ${r.baselineHeld.smMhz} / ${r.baselineHeld.memMhz}; certified +${c.coreMhz} core / +${c.memMhz} memory on top → ${r.heldAtCertified.smMhz} / ${r.heldAtCertified.memMhz}`
      : `certified +${c.coreMhz} core / +${c.memMhz} memory on top of ${found}`;
  const f = r.firstFailure;
  const failure = f ? `; first ${f.reason === 'hash' ? 'silent error' : f.reason === 'device-lost' ? 'driver reset' : 'regression'} at +${f.offsetMhz} ${f.ladder} (stage ${f.stage})` : '';
  const finding = c.coreMhz === 0 && c.memMhz === 0 ? 'Nothing above the card as found could be certified; these are not values to type anywhere.' : 'Type these into your vendor tool; Strata Tune left the card as it found it.';
  const total = r.vendor ? sliderTotal(r.vendor, c) : null;
  // Labelled by what the user does with each pair (the page's ValueSet uses the same words): the whole tune to type first, the slider-unit step on top of the user's own second.
  const slider = r.vendor && total
    ? `Type into GPU Tweak / Afterburner: core +${total.coreMhz}, memory +${total.memMhz} (your +${r.vendor.coreMhz} / +${r.vendor.memMhz} plus core +${v.coreMhz}, memory +${v.memMhz} on top in slider units; their memory slider counts the effective rate, twice ours)`
    : `Type into GPU Tweak / Afterburner: core +${v.coreMhz}, memory +${v.memMhz} (their memory slider counts the effective rate, twice ours)`;
  const left = leftSentence(r);
  const lines = [`Strata Tune headroom, ${date} (${r.confidence} confidence; core / memory clocks in NVML MHz under load)`, `${held}${failure}`];
  const points = scoreLine(r);
  if (points) lines.push(points);
  // One line per ladder stop, so a file that says "+0 core" also says why (the top of the clock table, a cap, a check that stopped the ladder), not only when a stage failed.
  for (const stop of r.stops) lines.push(`${stop.ladder} ladder ended: ${stop.note}`);
  lines.push(slider, finding, holdsNowLine(r), left);
  return lines.join('\n');
}

const thousands = (n: number) => n.toLocaleString('en-US');

/**
 * How the card was left (the export's closing line, also under the page's value set): on a
 * vendor tune the restore wrote the tune through the driver's P0 offsets, our route, so the
 * vendor tool's own route no longer holds it and one Apply there puts it back on its terms;
 * from stock or our own route the offsets are simply back where they were.
 */
export function leftSentence(r: Pick<TuneResult, 'vendor' | 'baseline'>): string {
  return r.vendor
    ? `Nothing changed voltage, power limits or fans; your tune was put back through the driver's P0 offsets (core +${r.baseline.coreMhz} / memory +${r.baseline.memMhz} NVML MHz), so press Apply in the vendor tool once if it shows something else now; a driver update or a different tune means a new hunt.`
    : 'Nothing changed voltage, power limits or fans, and the P0 offsets are back where they were; a driver update or a different tune means a new hunt.';
}

/**
 * "11,930 points at +45 / +60: +1.1 % over your current tune (11,800), +19.3 % over a reference
 * 5090 (10,000)" (TuneSupervisor.ScoreLine); the as-found score alone when nothing above it was
 * certified; null before the as-found run has scored.
 */
export function scoreLine(r: TuneResult): string | null {
  const found = r.asFound?.score;
  if (!found) return null;
  const c = r.certified;
  const official = r.official?.score;
  if (official) {
    const stepped = r.official?.steppedDown ? "; the official run passed one fine step below the ladders' rungs" : '';
    return `${thousands(official.points)} points at +${c.coreMhz} / +${c.memMhz}: ${signedPercent(percentOver(official.points, found.points))} over your current tune (${thousands(found.points)}), ${signedPercent(percentOver(official.points, REFERENCE_POINTS))} over an estimated reference 5090 (${thousands(REFERENCE_POINTS)})${stepped}`;
  }
  const failed = r.official ? `; the official run of the certified pair failed (${r.official.note})` : '';
  return `${thousands(found.points)} points as found: ${signedPercent(percentOver(found.points, REFERENCE_POINTS))} over an estimated reference 5090 (${thousands(REFERENCE_POINTS)})${failed}`;
}

/** Plan section 16, rule 4 (TuneSupervisor.HoldsNowLine): what the card holds now against as found, and "re-apply in your vendor tool" when they differ by more than 1 %. */
export function holdsNowLine(r: TuneResult): string {
  const now = r.holdsNow;
  const b = r.baselineHeld;
  if (!now) {
    return b
      ? `The card was not measured after the restore (the run was stopped or ended early); as found it held ${b.smMhz} / ${b.memMhz}: check the vendor tool shows your tune.`
      : 'The card was not measured after the restore; check the vendor tool shows your tune.';
  }
  if (!b) return `The card holds ${now.smMhz} / ${now.memMhz} now.`;
  return holdsDiffer(b, now)
    ? `The card holds ${now.smMhz} / ${now.memMhz} now; as found ${b.smMhz} / ${b.memMhz}: re-apply in your vendor tool.`
    : `The card holds ${now.smMhz} / ${now.memMhz} now; as found ${b.smMhz} / ${b.memMhz} (the same within 1 %).`;
}
