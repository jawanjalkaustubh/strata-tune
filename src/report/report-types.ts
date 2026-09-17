/**
 * What the report renderer needs (master plan §11, §12, §19): the analysis, the
 * per-second summary rows and the stutter marks, never the raw streams. Both the
 * in-app Capture view and the standalone HTML render exactly this, so an exported
 * file is the same JSON the app holds.
 *
 * `StutterReport` here is the report-side view of the classifier's output
 * (src/analysis/session-types.ts): src/components/capture/toReport.ts maps the
 * analysis into these shapes, so a field the classifier names differently never
 * reaches the renderer, and an exported file stays readable when the classifier changes.
 * The bench check is the one block carried as the classifier wrote it: it is the
 * classifier's own account of itself (plan §11a), and the file keeps its case numbers.
 */
import type { BenchCheck, BenchCheckRow } from '../analysis/session-types';
import type { ScoreSheet } from './score-types';

export type { BenchCheck, BenchCheckRow };

/** The nine §11 signatures, first match wins; 0 is a stutter no rule matched. */
export type StutterCase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type Confidence = 'high' | 'low';

export interface CauseShare {
  case: StutterCase;
  count: number;
  /** Share of all stutters, 0..1. */
  share: number;
  /** Playtime lost to this cause, ms. */
  lostMs: number;
  confidence: Confidence;
  /** The specific thing the rule saw: the background process's name, the VRAM figure. Shown after the paragraph. */
  detail?: string;
}

/** One stutter on the session timeline, for the chart's dots. */
export interface StutterMark {
  /** Seconds since the first counted frame. */
  t: number;
  ms: number;
  case: StutterCase;
}

/** One downsampled frame-time point; the per-second fold from the ring buffer (plan §6). */
export interface TimelinePoint {
  t: number;
  /** Mean frame time over the second. */
  ms: number;
  /** The worst frame in that second, so a spike survives the fold. */
  maxMs: number;
}

export type BoundSide = 'gpu' | 'cpu' | 'balanced' | 'unknown';

/** §12: which side limited the capture, with the numbers behind the sentence. */
export interface BoundVerdict {
  side: BoundSide;
  /** Mean GPU utilisation over the capture, %. */
  gpuUtilPct: number | null;
  meanCpuBusyMs: number;
  meanGpuBusyMs: number;
  sentence: string;
}

export interface Measurements {
  stutters: number;
  /** Playtime lost, %. */
  lostPct: number;
  /** Median frame time, ms. */
  typicalMs: number;
  /** 99th-percentile frame time, ms: where the worst 1 % of frames begins. */
  worst1PctMs: number;
  /** Frame-time stdev with stutters excluded: pacing. */
  pacingStdevMs: number;
  shaderWarmup: boolean;
  thermalThrottling: boolean;
  pacingIssue: boolean;
}

/**
 * The classifier's overall call (src/analysis/stutter.ts): 'short' never left the level
 * load, 'fine' is under the worth-fixing line even when stutters were found, 'unclear'
 * found stutters that matched no signature.
 */
export type Verdict = 'short' | 'fine' | 'fixable' | 'engine' | 'mixed' | 'unclear';

export interface StutterReport {
  /** Absent in reports written before the verdict travelled with them; the headline then judges by the causes alone. */
  verdict?: Verdict;
  measurements: Measurements;
  /** Sorted by share, descending. Empty when the session had no stutters. */
  causes: CauseShare[];
  bound: BoundVerdict;
  timeline: TimelinePoint[];
  /** Every stutter, or the worst N of a long session; t is on the timeline's axis. */
  stutters: StutterMark[];
  /** Bench sessions only: the classifier against the script's designed cases. */
  benchCheck?: BenchCheck;
}

export interface SessionSummary {
  /** Process or bench name as the user saw it. */
  game: string;
  startedAt: string;
  durationS: number;
  /** Frames counted after the 300-frame level-load skip. */
  frames: number;
  /** Every frame PresentMon delivered, the level load included; absent in reports written before it was recorded. */
  framesCaptured?: number;
  cpu: string;
  gpu: string;
  /** PresentMon's PresentMode for the dominant swap chain. */
  presentMode?: string;
  /** A bench run (§11a) says so, a game capture does not. */
  bench?: boolean;
  appVersion?: string;
}

/** A stutter or bench report (plan §11, §11a); a file written before 2026-09-16 has no `kind`. */
export interface Report {
  kind?: 'stutter';
  report: StutterReport;
  session: SessionSummary;
}

/** The comparison sheet of a scored run (plan §16 'Save as .html'): src/report/score-types.ts. */
export interface ScoreReportFile {
  kind: 'score';
  sheet: ScoreSheet;
}

/** What the one template renders: ReportFileView switches on `kind`. */
export type ReportFile = Report | ScoreReportFile;

export const isScoreReport = (r: ReportFile): r is ScoreReportFile => r.kind === 'score';
