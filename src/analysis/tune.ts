/**
 * The pure half of the collector's tune supervisor (plan section 16), mirrored from
 * collector/StrataTune.Collector/TuneLadder.cs, TuneState.cs and TuneSupervisor.Export so
 * the ladder maths, the rollback transitions and the export text are tested here without a
 * GPU. The collector is the one that runs them; a change to a constant or a rule lands in
 * both files together. Every clock value is in NVAPI's kHz.
 */
import type { TuneConfidence, TuneResult, TuneRollback, TuneVerdict } from '../collector-types';

export const CORE_STEP_KHZ = 30_000;
export const CORE_RESOLUTION_KHZ = 15_000;
export const MEM_STEP_KHZ = 100_000;
export const MEM_RESOLUTION_KHZ = 25_000;
/** Stage 2: bandwidth this far under the best seen at a lower step is the memory failing, not noise. */
export const BANDWIDTH_REGRESSION = 0.03;
/** The measured floor: this many times the spread of the baseline step's own passes, when that is larger. */
export const NOISE_FLOOR_MULTIPLE = 3;
/** A throttle bit on more than this share of the heavy pattern's samples makes the candidate invalid. */
export const THROTTLED_FRACTION_LIMIT = 0.05;
/** SwPowerCap, HwSlowdown, SwThermalSlowdown, HwThermalSlowdown, HwPowerBrakeSlowdown (dependencies.md). */
export const THROTTLE_BITS = 0x4 | 0x8 | 0x20 | 0x40 | 0x80;
/** The memory sweep stops climbing after this many steps in a row fail to raise the bandwidth. */
export const SWEEP_FLAT_STEPS = 2;

export const HUNT_PATTERNS: readonly { pattern: 'heavy' | 'light' | 'transient'; seconds: number }[] = [
  { pattern: 'heavy', seconds: 20 },
  { pattern: 'light', seconds: 10 },
  { pattern: 'transient', seconds: 10 }
];
export const SWEEP_PATTERNS: readonly { pattern: 'heavy'; seconds: number }[] = [
  { pattern: 'heavy', seconds: 5 },
  { pattern: 'heavy', seconds: 5 },
  { pattern: 'heavy', seconds: 5 }
];
export const VALIDATE_PATTERNS: readonly { pattern: 'heavy' | 'transient'; seconds: number }[] = [
  { pattern: 'heavy', seconds: 300 },
  { pattern: 'transient', seconds: 120 }
];

/** The next coarse rung above the current one, or null at the driver's ceiling. */
export function nextCoarse(currentKhz: number, stepKhz: number, maxKhz: number): number | null {
  return currentKhz + stepKhz <= maxKhz ? currentKhz + stepKhz : null;
}

/** The rung between the last stable and the first failing value, on a whole MHz, or null once the gap is at the resolution. */
export function midpoint(stableKhz: number, failingKhz: number, resolutionKhz: number): number | null {
  const gap = failingKhz - stableKhz;
  return gap > resolutionKhz ? stableKhz + Math.trunc(gap / 2 / 1000) * 1000 : null;
}

/** The share of the best a step may fall below before it is a regression: the fixed 3 %, or three times the baseline's spread, whichever is more. */
export function regressionFloor(baselineSpread: number | null): number {
  return Math.max(BANDWIDTH_REGRESSION, NOISE_FLOOR_MULTIPLE * (baselineSpread ?? 0));
}

export function regressed(bandwidthGBs: number, bestGBs: number | null, baselineSpread: number | null = null): boolean {
  return bestGBs !== null && bestGBs > 0 && bandwidthGBs < bestGBs * (1 - regressionFloor(baselineSpread));
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** (max - min) / median: the relative spread of a step's passes. */
export function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return m > 0 ? (Math.max(...values) - Math.min(...values)) / m : 0;
}

/**
 * One pattern's verdict from the worker's exit code and the heartbeat: a device loss (stage 3),
 * a hash mismatch (stage 1), or a pass the candidate's judgement takes further. Null for an
 * exit that is not a verdict at all (bad arguments, no hardware GPU): the run fails rather
 * than counting a broken worker as an unstable card.
 */
export function patternVerdict(exitCode: number, heartbeatStale: boolean): { verdict: TuneVerdict; stage: number | null } | null {
  if (heartbeatStale || exitCode === 10) return { verdict: 'device-lost', stage: 3 };
  if (exitCode === 2) return { verdict: 'unstable', stage: 1 };
  return exitCode === 0 ? { verdict: 'stable', stage: null } : null;
}

/**
 * The candidate's verdict once every pattern passed: a throttled heavy pattern is invalid
 * before anything else is asked of it (a power-capped step is slower, and that is the cap,
 * not the memory failing); then the bandwidth against the best is stage 2; then stable.
 * The gate is off for the memory sweep and the validate run.
 */
export function judge(throttledFraction: number, throttleGate: boolean, bandwidthGBs: number | null, bestGBs: number | null, baselineSpread: number | null): { verdict: TuneVerdict; stage: number | null } {
  if (throttleGate && throttledFraction > THROTTLED_FRACTION_LIMIT) return { verdict: 'invalid', stage: null };
  if (bandwidthGBs !== null && regressed(bandwidthGBs, bestGBs, baselineSpread)) return { verdict: 'unstable', stage: 2 };
  return { verdict: 'stable', stage: null };
}

/**
 * High: the ceiling was found and bisected with nothing in the way. Medium: found, but a
 * device loss or a throttled rung sits in the record, or the ladder hit the driver's limit.
 * Low: the run did not get there, or found nothing above the baseline.
 */
export function confidence(converged: boolean, atDriverMax: boolean, deviceLostCount: number, anyInvalid: boolean, aboveBaseline: boolean): TuneConfidence {
  if (!converged || !aboveBaseline) return 'low';
  return deviceLostCount > 0 || anyInvalid || atDriverMax ? 'medium' : 'high';
}

export type StartAction = 'none' | 'revert' | 'promote' | 'forget';

/** What a start knows beyond the file (TuneState.cs StartFacts); null means it could not be found out. */
export interface StartFacts {
  sameBoot: boolean;
  unexpectedShutdown: boolean | null;
  onCard: boolean | null;
}

/**
 * What a start (the collector's, or the logon task's) does with the state file it finds:
 * PENDING → revert (a candidate that reached a start was never certified, clean shutdown or
 * not); VALIDATING without a clean shutdown → revert; VALIDATING in the same boot → nothing,
 * or forget when the driver no longer holds it; VALIDATING from a later boot → promote only
 * with a clean shutdown and no dirty shutdown in the System log, revert when the log shows
 * one, forget when the log could not be asked; anything else → nothing.
 */
export function atStart(file: { state: TuneRollback; candidate: unknown | null; cleanShutdown: boolean }, facts: StartFacts): StartAction {
  if (file.candidate === null) return 'none';
  if (file.state === 'PENDING') return 'revert';
  if (file.state !== 'VALIDATING') return 'none';
  if (!file.cleanShutdown) return 'revert';
  if (facts.sameBoot) return facts.onCard === false ? 'forget' : 'none';
  if (facts.unexpectedShutdown === true) return 'revert';
  if (facts.unexpectedShutdown === false) return 'promote';
  return 'forget';
}

/** The copy-pasteable value set, as TuneSupervisor.Export writes it (the date is the local day of `foundAt`). */
export function exportText(r: TuneResult, date: string): string {
  const signed = (x: number) => (x >= 0 ? `+${x}` : `${x}`);
  const core = Math.trunc(r.deltas.coreKhz / 1000);
  const mem = Math.trunc(r.deltas.memKhz / 1000);
  const same = r.deltas.coreKhz === r.baseline.coreKhz && r.deltas.memKhz === r.baseline.memKhz;
  const limited = r.throttledFraction !== null && r.throttledFraction > THROTTLED_FRACTION_LIMIT ? ` (power- or thermal-limited ${Math.round(r.throttledFraction * 100)} % of the time at your fan curve)` : '';
  const certified = r.promoted
    ? ', validated 5 min heavy + 2 min transient, and kept through a clean shutdown and a clean boot'
    : r.validated
      ? `, validated 5 min heavy + 2 min transient${limited}`
      : ', not yet validated';
  const clocks =
    r.referenceSmMhz !== null && r.referenceMemMhz !== null
      ? `Measured with the card at core ${r.referenceSmMhz} / memory ${r.referenceMemMhz} MHz under load with nothing of Strata Tune's applied; an OC a vendor tool applies by another route (VF points) is inside those clocks, not in the baseline above.`
      : 'The clocks under load during the reference run were not recorded.';
  return [
    `Strata Tune ${r.kind} result, ${date} (${r.confidence} confidence${certified})`,
    `  GPU core clock offset:    ${signed(core)} MHz`,
    `  Memory clock offset:      ${signed(mem)} MHz`,
    same ? 'No rung above the baseline could be certified, so these are the baseline values, not a finding.' : 'These are absolute offsets to type into MSI Afterburner or ASUS GPU Tweak III.',
    `They were measured from a baseline of core ${signed(Math.trunc(r.baseline.coreKhz / 1000))} / memory ${signed(Math.trunc(r.baseline.memKhz / 1000))} MHz (the P0 offsets the driver reported when the hunt started); a different baseline or a driver update means a new hunt.`,
    clocks,
    "Fans were on your own curve throughout: Strata Tune does not control them. Offsets applied by Strata Tune do not survive a reboot; this text is what persists."
  ].join('\n');
}
