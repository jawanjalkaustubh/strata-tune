import type { LoadRun } from '../collector-types';
import type { AuditFinding } from './audit';
import { hasAny, THERMAL_OR_BRAKE } from './nvmlBits';

/**
 * The system score (master plan §14): four subscores 0–100, a weighted total,
 * a stability cap and a validity gate. Every number here is explainable from
 * its inputs; nothing is tuned to flatter a machine. A subscore whose input
 * has not been measured is null and drops out of the mean, and the result says
 * so, because a silently bad score is worse than none.
 */
export type Subscore = 'configuration' | 'thermals' | 'smoothness' | 'efficiency';

export const WEIGHTS: Record<Subscore, number> = { configuration: 0.3, thermals: 0.2, smoothness: 0.3, efficiency: 0.2 };

/** What the Smoothness rule needs from a stutter report; src/report/report-types.ts's StutterReport satisfies it. */
export interface SmoothnessInput {
  measurements: { lostPct: number; typicalMs: number; pacingStdevMs: number };
  causes: { case: number; lostMs: number }[];
  /** Playtime the lostPct is a fraction of, so the engine's share can be taken out of it. */
  durationS: number;
}

/** Spec-sheet expectation for the Efficiency rule (gpus.json: rated boost, TDP). */
export interface EfficiencySpec {
  boostMhz: number;
  tdpW: number;
}

export interface ScoreInputs {
  findings: AuditFinding[] | null;
  /** The fixed 60 s heavy run (plan §14 validity): Thermals and Efficiency both read it. */
  run: LoadRun | null;
  spec: EfficiencySpec | null;
  smoothness: SmoothnessInput | null;
  /** Any TDR or worker compute error during validation caps the total at 60. */
  stability: { tdr: boolean; computeError: boolean };
  /**
   * What tripped during the fixed workload, judged by the caller: another process
   * busy, the CPU held back by heat or a power plan, the card still warming when
   * the run started. The GPU's own throttle bits are the Thermals measurement,
   * not a validity fault.
   */
  validity: { backgroundLoad: boolean; throttled: boolean; thermalDrift: boolean };
}

export interface Subscores {
  configuration: number | null;
  thermals: number | null;
  smoothness: number | null;
  efficiency: number | null;
}

export interface Score {
  subscores: Subscores;
  /** Null when the run is invalid: nothing to compare against anything. */
  total: number | null;
  /** True when every subscore was measured; a partial total says so in the UI. */
  complete: boolean;
  capped: boolean;
  valid: boolean;
  /** Why the run is invalid, in the user's words; empty when valid. */
  invalidReasons: string[];
  /** The finding that cost the most Configuration points, for the share card's "top fix". */
  topFix: AuditFinding | null;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A finding at top severity that costs 20 % of performance removes 60 points; info and unknown states cost nothing. */
const CONFIG_POINTS_PER_UNIT = 100;

export function configurationScore(findings: AuditFinding[]): number {
  const cost = findings.filter((f) => f.state === 'warn' || f.state === 'bad').reduce((sum, f) => sum + f.severity * f.costEstimate * CONFIG_POINTS_PER_UNIT, 0);
  return clamp(100 - cost);
}

export function topFix(findings: AuditFinding[]): AuditFinding | null {
  const costly = findings.filter((f) => f.state === 'warn' || f.state === 'bad');
  return costly.sort((a, b) => b.severity * b.costEstimate - a.severity * a.costEstimate)[0] ?? null;
}

const STEADY_FROM_S = 3;
/** Every 1 % the sustained clock sits under the run's peak costs 4 points: a 15 % sag is 60 points. */
const SAG_POINTS_PER_PCT = 4;
/** A throttle bit on every sample costs 60 points on its own. */
const THROTTLE_SHARE_POINTS = 60;

function steady(run: LoadRun): LoadRun['gpuSamples'] {
  if (run.qpcEnd === null || run.qpcEnd <= run.qpcStart) return [];
  const span = run.qpcEnd - run.qpcStart;
  return run.gpuSamples.filter((s) => ((s.qpc - run.qpcStart) / span) * run.seconds >= STEADY_FROM_S);
}

/** Sustained clock against the run's own peak, and the share of samples with a thermal or brake bit set. */
export function thermalsScore(run: LoadRun): number | null {
  const samples = steady(run);
  if (run.state !== 'done' || samples.length === 0) return null;
  const peak = Math.max(...run.gpuSamples.map((s) => s.smMhz));
  if (peak <= 0) return null;
  const sagPct = Math.max(0, 1 - mean(samples.map((s) => s.smMhz)) / peak) * 100;
  const throttled = samples.filter((s) => hasAny(s.clocksEventReasons, THERMAL_OR_BRAKE)).length / samples.length;
  return clamp(100 - sagPct * SAG_POINTS_PER_PCT - throttled * THROTTLE_SHARE_POINTS);
}

/** Each 1 % of playtime lost to a fixable cause costs 10 points. */
const LOST_POINTS_PER_PCT = 10;
/** Pacing stdev over 10 % of the typical frame time costs 5 points per further 10 %, at most 20. */
const PACING_FREE_FRACTION = 0.1;
const PACING_POINTS_PER_TENTH = 5;
const PACING_MAX_POINTS = 20;
const ENGINE_CASES = new Set([7, 8]);

/** Playtime lost with cases 7 and 8 taken out (plan §14): the engine's stutters are not the machine's. */
export function smoothnessScore(s: SmoothnessInput): number | null {
  const m = s.measurements;
  if (!(s.durationS > 0) || !(m.typicalMs > 0)) return null;
  const engineMs = s.causes.filter((c) => ENGINE_CASES.has(c.case)).reduce((sum, c) => sum + c.lostMs, 0);
  const lostPct = Math.max(0, m.lostPct - (engineMs / (s.durationS * 1000)) * 100);
  const pacingExcess = Math.max(0, m.pacingStdevMs / m.typicalMs - PACING_FREE_FRACTION);
  const pacingPoints = Math.min(PACING_MAX_POINTS, (pacingExcess / 0.1) * PACING_POINTS_PER_TENTH);
  return clamp(100 - lostPct * LOST_POINTS_PER_PCT - pacingPoints);
}

/**
 * Performance per watt against the spec sheet. Placeholder for the day-one
 * expectation (plan §14): the card's rated boost over its TDP stands in for
 * "work per watt", and the measured steady clock over the measured board power is
 * compared to it. A card at its rated boost drawing its TDP scores 100; one
 * drawing TDP for 85 % of the clock scores 85; an undervolt scores over 100 and
 * is capped. Cohort medians replace the spec figure when they exist.
 */
export function efficiencyScore(run: LoadRun, spec: EfficiencySpec): number | null {
  const samples = steady(run);
  if (run.state !== 'done' || samples.length === 0 || !(spec.boostMhz > 0) || !(spec.tdpW > 0)) return null;
  const mhz = mean(samples.map((s) => s.smMhz));
  const watts = mean(samples.map((s) => s.powerMw)) / 1000;
  if (!(watts > 0)) return null;
  return clamp(((mhz / watts) / (spec.boostMhz / spec.tdpW)) * 100);
}

export const STABILITY_CAP = 60;

export function systemScore(i: ScoreInputs): Score {
  const subscores: Subscores = {
    configuration: i.findings ? configurationScore(i.findings) : null,
    thermals: i.run ? thermalsScore(i.run) : null,
    smoothness: i.smoothness ? smoothnessScore(i.smoothness) : null,
    efficiency: i.run && i.spec ? efficiencyScore(i.run, i.spec) : null
  };
  const present = (Object.keys(WEIGHTS) as Subscore[]).filter((k) => subscores[k] !== null);
  const invalidReasons: string[] = [];
  if (i.validity.backgroundLoad) invalidReasons.push('another program was busy during the run');
  if (i.validity.throttled) invalidReasons.push('the CPU was held back during the run');
  if (i.validity.thermalDrift) invalidReasons.push('the card was still warming up when the run started');
  const valid = invalidReasons.length === 0;
  const capped = i.stability.tdr || i.stability.computeError;
  let total: number | null = null;
  if (valid && present.length > 0) {
    const weight = present.reduce((sum, k) => sum + WEIGHTS[k], 0);
    const weighted = present.reduce((sum, k) => sum + WEIGHTS[k] * (subscores[k] as number), 0) / weight;
    total = Math.min(clamp(weighted), capped ? STABILITY_CAP : 100);
  }
  return { subscores, total, complete: present.length === 4, capped, valid, invalidReasons, topFix: i.findings ? topFix(i.findings) : null };
}
