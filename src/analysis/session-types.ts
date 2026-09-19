/**
 * The capture session (master plan §6, §11, §12): one PresentMon frame stream, the
 * sensor window and the GPU facts on the same QPC clock, and the analysis built over
 * them. The capture host (electron/presentmon.ts), the classifier, the bound verdict,
 * the report renderer and the .stsession writer all code against these shapes.
 *
 * QPC ticks are plain numbers: at 10 MHz a double holds them exactly for 2^53 ticks,
 * about 28 years of uptime, so no BigInt anywhere on the timeline.
 */
import type { GpuFacts, HogsResult, SensorWindow, StaticSnapshot } from '../collector-types';

/**
 * One PresentMon 2.5.1 CSV row, every column of the 28-column header by name
 * (docs/dependencies.md). Columns that print `NA` parse to null; a column missing
 * from the header is null too. `timeInQpc` and `msBetweenPresents` are the two the
 * timeline cannot do without, so a row lacking either is not a FrameRow.
 */
export interface FrameRow {
  application: string;
  processId: number;
  swapChainAddress: string;
  presentRuntime: string;
  syncInterval: number;
  presentFlags: number;
  allowsTearing: number;
  presentMode: string;
  /** Raw QPC ticks of the present, same clock as the sensor rows. */
  timeInQpc: number;
  msBetweenSimulationStart: number | null;
  /** The classic frame time. */
  msBetweenPresents: number;
  msBetweenDisplayChange: number | null;
  msInPresentApi: number | null;
  msRenderPresentLatency: number | null;
  msUntilDisplayed: number | null;
  cpuStartQpc: number | null;
  /** The v2 frame time: msCpuBusy + msCpuWait. */
  msBetweenAppStart: number | null;
  msCpuBusy: number | null;
  msCpuWait: number | null;
  msGpuLatency: number | null;
  msGpuTime: number | null;
  msGpuBusy: number | null;
  msGpuWait: number | null;
  msAnimationError: number | null;
  animationTime: number | null;
  msFlipDelay: number | null;
  msAllInputToPhotonLatency: number | null;
  msClickToPhotonLatency: number | null;
}

/** One GET /gpu reading during the capture, stamped when it was taken. */
export interface GpuSample {
  qpc: number;
  facts: GpuFacts;
}

export interface CaptureSession {
  id: string;
  /** Wall clock, display only; everything else is QPC. */
  startedAt: string;
  game: { pid: number; exe: string; path: string | null };
  qpcFrequency: number;
  frames: FrameRow[];
  sensorWindow: SensorWindow | null;
  snapshot: StaticSnapshot | null;
  gpuTimeline: GpuSample[];
  /** The collector's per-process sample taken as the capture started: case 6's only input until a per-process stream exists. */
  hogs?: HogsResult | null;
  /** Host remarks and user marks, in order: PresentMon exit code, game exit, "boss fight here". */
  notes: string[];
  /** A bench run's script (plan §11a), for the report's bench check; absent on a game capture. */
  benchSummary?: BenchSummary | null;
}

/** Plan §11 case numbers and their ids, in first-match order. */
export type CauseId =
  | 'shader-compile' | 'thermal' | 'power-limit' | 'vram' | 'storage'
  | 'background' | 'periodic' | 'engine' | 'pacing';

export interface ClassifiedCause {
  case: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  id: CauseId;
  fixable: boolean;
  /** 'high' when two signals agree, 'low' on one correlation. */
  confidence: 'high' | 'low';
  /** One line per signal, in the words the report shows under "why". */
  evidence: string[];
  /** Case 6 only: the process that was using the CPU. */
  process?: string;
}

export interface StutterEvent {
  /** Index into CaptureSession.frames. */
  index: number;
  qpc: number;
  frameMs: number;
  /** Rolling median of the 120 frames before this one. */
  medianMs: number;
  /** 'spike' tripped the 2× median rule, 'absolute' only the 50 ms floor. */
  kind: 'spike' | 'absolute';
  cause: ClassifiedCause | null;
}

/** What detectStutters measures; `events` carry causes once classify has run. */
export interface Detection {
  events: StutterEvent[];
  stutterCount: number;
  /** Σ(stutter frame − median) over Σ frame time, as a percentage 0..100. */
  percentTimeLost: number;
  /** Frame-time standard deviation over the non-stutter frames. */
  pacingStdevMs: number;
  typicalFrameMs: number;
  /** 99th-percentile frame time: where the worst 1 % of frames begins. */
  worst1PctMs: number;
  /** Frames after the level-load skip; 0 means the capture was too short to judge. */
  analysedFrames: number;
  totalMs: number;
}

export interface BoundVerdict {
  limiter: 'cpu' | 'gpu' | 'balanced' | 'unknown';
  /** Σ MsGPUBusy / Σ frame time, 0..1. */
  gpuBusyShare: number;
  /** Σ MsCPUBusy / Σ frame time, 0..1. */
  cpuBusyShare: number;
  text: string;
}

export interface ReportCause {
  id: CauseId | 'unclassified';
  /** This cause's part of the time lost, 0..1. */
  share: number;
  fixable: boolean;
  confidence: 'high' | 'low';
  text: string;
  action: string;
}

/**
 * 'short' is a capture that never left the level load; 'fine' is under the worth-fixing
 * line; 'unclear' found stutters that matched no signature.
 */
export type Verdict = 'short' | 'fine' | 'fixable' | 'engine' | 'mixed' | 'unclear';

export interface StutterReport {
  headline: string;
  verdict: Verdict;
  stutterCount: number;
  percentTimeLost: number;
  pacingStdevMs: number;
  typicalFrameMs: number;
  worst1PctMs: number;
  causes: ReportCause[];
  bound: BoundVerdict;
  events: StutterEvent[];
  /** The raw numbers for the table at the bottom of the report. */
  measurements: Record<string, number | string>;
  /** Bench sessions only: the classifier against the script (plan §11a). */
  benchCheck?: BenchCheck;
}

/**
 * One segment of the bench script (plan §11a, collector/StrataTune.Bench/README.md) on
 * the bench's own clock, which starts at its first present, and the case the script
 * writes it to trip. The report's bench check holds the classifier to this.
 */
export interface BenchSegment {
  name: string;
  startS: number;
  endS: number;
  /** The §11 case the segment is written to trip; null for one that should run clean on a healthy machine. */
  designedCause: CauseId | null;
  /** What a weak machine rightly shows instead of clean: VRAM or storage under texture-stream, thermal or the power limit under gpu-load. */
  weakCauses?: CauseId[];
  /** Cases the check takes for the designed one because they carry its verdict: cpu-stall's spins are case 7 on the full script's beat and case 8 on the short script's three, both the engine's. */
  sameVerdict?: CauseId[];
}

/** The bench's own account of its run, reduced to what the check needs; electron/bench-run.ts holds the full --json line. */
export interface BenchSummary {
  script: string;
  segments: BenchSegment[];
}

/** One bench segment against what the classifier made of the stutters inside it. */
export interface BenchCheckRow {
  segment: string;
  startS: number;
  endS: number;
  designed: ClassifiedCause['case'] | null;
  weak: ClassifiedCause['case'][];
  /** Cases taken for `designed` because they carry the same verdict (the engine's 7 and 8 under cpu-stall); absent in reports written before it. */
  sameVerdict?: ClassifiedCause['case'][];
  /** The case most of the segment's stutters were given; 0 when most matched no rule, null with no stutters. */
  found: ClassifiedCause['case'] | 0 | null;
  stutters: number;
  /** Time lost inside the segment as a percentage of the segment, 0..100. */
  lostPct: number;
  /** False when the capture ended before the segment began (a run stopped early). */
  reached: boolean;
  /** False for a segment the script designs nothing for (the warm-up) or one the run never reached: shown, not scored. */
  scored: boolean;
  match: boolean;
}

/** Plan §11a: the bench exists to trip known cases, and this is the classifier's own honesty check against it. */
export interface BenchCheck {
  script: string;
  /** True when the session carried no bench summary and the segments are the full script's fixed timings. */
  assumedTimings: boolean;
  rows: BenchCheckRow[];
  matched: number;
  scored: number;
  /** "3 of 4 designed segments classified as designed". */
  score: string;
}
