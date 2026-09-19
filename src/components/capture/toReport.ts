/**
 * The Capture page runs the analysis (src/analysis) and hands the report renderer
 * (src/report) its own shapes: the per-second timeline, the stutter marks and the
 * cause shares with counts. Everything here is derived from the session and the
 * classifier's output; nothing is measured twice.
 */
import { WARMUP_FRAMES } from '../../analysis/frames';
import { analyseSession } from '../../analysis/stutter';
import { headline } from '../../report/causes';
import type { CaptureSession, CauseId, StutterEvent, StutterReport as AnalysisReport } from '../../analysis/session-types';
import type { SensorMeta } from '../../collector-types';
import type { CauseShare, Report, SessionSummary, StutterCase, StutterMark, TimelinePoint, StutterReport } from '../../report/report-types';
import benchmarks from '../../data/benchmarks.json';

const CASE_OF: Record<CauseId, StutterCase> = {
  'shader-compile': 1, thermal: 2, 'power-limit': 3, vram: 4, storage: 5, background: 6, periodic: 7, engine: 8, pacing: 9
};

/** Frames the analysis judged: everything after the level-load skip, so a short capture has none. */
const analysed = (s: CaptureSession) => s.frames.slice(WARMUP_FRAMES);

/** Seconds since the first analysed frame, on the frames' own clock. */
const seconds = (qpc: number, origin: number, hz: number) => (qpc - origin) / hz;

function timeline(s: CaptureSession, origin: number): TimelinePoint[] {
  const points: TimelinePoint[] = [];
  let bucket = -1;
  let sum = 0;
  let n = 0;
  let max = 0;
  const flush = () => {
    if (n > 0) points.push({ t: bucket, ms: sum / n, maxMs: max });
  };
  for (const f of analysed(s)) {
    const t = Math.floor(seconds(f.timeInQpc, origin, s.qpcFrequency));
    if (t !== bucket) {
      flush();
      bucket = t;
      sum = 0;
      n = 0;
      max = 0;
    }
    sum += f.msBetweenPresents;
    n++;
    if (f.msBetweenPresents > max) max = f.msBetweenPresents;
  }
  flush();
  return points;
}

/** Counts and time lost per cause; the detail is every evidence line of the first event the rule claimed, the signals the pill counts. */
function causes(a: AnalysisReport): CauseShare[] {
  const byId = new Map<string, { count: number; lostMs: number; detail?: string }>();
  for (const e of a.events) {
    const id = e.cause?.id ?? 'unclassified';
    const entry = byId.get(id) ?? { count: 0, lostMs: 0 };
    entry.count++;
    entry.lostMs += e.frameMs - e.medianMs;
    entry.detail ??= e.cause?.evidence.join(' · ');
    byId.set(id, entry);
  }
  return a.causes.map((c) => {
    const entry = byId.get(c.id) ?? { count: 0, lostMs: 0 };
    return { case: c.id === 'unclassified' ? 0 : CASE_OF[c.id], count: entry.count, share: c.share, lostMs: entry.lostMs, confidence: c.confidence, ...(entry.detail ? { detail: entry.detail } : {}) };
  });
}

const mark = (e: StutterEvent, origin: number, hz: number): StutterMark => ({ t: seconds(e.qpc, origin, hz), ms: e.frameMs, case: e.cause ? CASE_OF[e.cause.id] : 0 });

/** The value that appears most often, for the present mode line in the header. */
function dominant(values: string[]): string | undefined {
  const tally = new Map<string, number>();
  for (const v of values) if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
  return [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((x, y) => x + y, 0) / values.length : 0;
}

export function toReport(s: CaptureSession, a: AnalysisReport, appVersion: string): Report {
  const frames = analysed(s);
  const origin = frames[0]?.timeInQpc ?? 0;
  const last = frames[frames.length - 1]?.timeInQpc ?? origin;
  const durationS = seconds(last, origin, s.qpcFrequency);
  const util = s.gpuTimeline.filter((g) => g.qpc >= origin && g.qpc <= last).map((g) => g.facts.utilisation.gpu);
  const has = (id: CauseId) => a.causes.some((c) => c.id === id);
  const report: StutterReport = {
    verdict: a.verdict,
    measurements: {
      stutters: a.stutterCount,
      lostPct: a.percentTimeLost,
      typicalMs: a.typicalFrameMs,
      worst1PctMs: a.worst1PctMs,
      pacingStdevMs: a.pacingStdevMs,
      shaderWarmup: has('shader-compile'),
      thermalThrottling: has('thermal'),
      pacingIssue: has('pacing')
    },
    causes: causes(a),
    bound: {
      side: a.bound.limiter,
      gpuUtilPct: util.length ? mean(util) : null,
      meanCpuBusyMs: mean(frames.map((f) => f.msCpuBusy).filter((v): v is number => v !== null)),
      meanGpuBusyMs: mean(frames.map((f) => f.msGpuBusy).filter((v): v is number => v !== null)),
      sentence: a.bound.text
    },
    timeline: timeline(s, origin),
    stutters: a.events.map((e) => mark(e, origin, s.qpcFrequency)),
    // The classifier's own account of a bench run (plan section 11a) travels untouched: it keeps the analysis' case ids.
    ...(a.benchCheck ? { benchCheck: a.benchCheck } : {})
  };
  const session: SessionSummary = {
    game: s.game.exe,
    startedAt: s.startedAt,
    durationS,
    frames: frames.length,
    framesCaptured: s.frames.length,
    cpu: s.snapshot?.cpu.name ?? 'CPU not recorded',
    gpu: s.snapshot?.gpus[0]?.name ?? s.gpuTimeline[0]?.facts.name ?? 'GPU not recorded',
    presentMode: dominant(frames.map((f) => f.presentMode)),
    // The built-in bench is known by its exe: the report header says "Bench report" (plan section 11a).
    ...(s.game.exe.toLowerCase() === benchmarks.builtIn.exe ? { bench: true } : {}),
    appVersion
  };
  return { report, session };
}

/** Analyse → the renderer's shapes, in one call; the verdict line for the session list is the report's own headline, so both say the same. */
export function analyse(s: CaptureSession, appVersion: string, sensorMeta?: SensorMeta[]): { report: Report; verdict: string } {
  const report = toReport(s, analyseSession(s, sensorMeta ? { sensorMeta } : {}), appVersion);
  const h = headline(report.report);
  return { report, verdict: `${h.title} · ${h.summary}` };
}
