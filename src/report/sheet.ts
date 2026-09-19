/**
 * Builds the comparison sheet (plan §16 'Save as .html') from what the app holds: a hunt's
 * TuneExport with its result, or a bench session's own GPU timeline. Every string goes
 * through the §17 redaction (src/components/about/systemReport.ts) before it leaves, so a
 * serial, a hostname or a user name never reaches the file, and the tests grep for them.
 */
import type { GpuFacts, StaticSnapshot, TelemetrySummary, TuneExport, TuneResult } from '../collector-types';
import type { CaptureSession } from '../analysis/session-types';
import { DEVICE_CLASS_LABEL, exportText, isScoredRun, REFERENCE_POINTS, THERMAL_BITS, THERMAL_FRACTION_LIMIT, type DeviceClass } from '../analysis/tune';
import { hasAny } from '../analysis/nvmlBits';
import { decodeReasons } from '../components/monitor/reasons';
import { gpuTitle } from '../components/monitor/vendors';
import { confidenceWhy } from '../components/tune/wire';
import { EXPORT_FOOTER, redact } from '../components/about/systemReport';
import { PSU_RATINGS, type PsuRating } from '../analysis/psu';
import type { ScoreSheet, SheetGpu, SheetRung, SheetStat, SheetValidity } from './score-types';
import type { Report } from './report-types';

export interface SheetContext {
  snapshot: StaticSnapshot | null;
  gpu: GpuFacts | undefined;
  version: string;
  deviceClass: DeviceClass | null;
  psu: { watts: number | null; rating: PsuRating | null };
  /** "Windows 11 Home 25H2 build 26200.1234" from About when read; the snapshot's caption and build otherwise. */
  windows?: string | null;
  /** The DIMM rail from the live sensors when the board reads one. */
  dimmVoltage?: number | null;
}

const gib = (mib: number) => Math.round(mib / 1024);

/** The PSU as the user set it, its badge in the 80 PLUS programme's own words. */
const psuOf = (c: SheetContext): ScoreSheet['psu'] => ({ watts: c.psu.watts, rating: c.psu.rating ? (PSU_RATINGS.find((r) => r.id === c.psu.rating)?.label ?? c.psu.rating) : null });

function hardwareOf(c: SheetContext): ScoreSheet['hardware'] {
  const s = c.snapshot;
  const gpu = c.gpu ?? s?.gpus[0];
  // A trimmed session snapshot (the bench fixture) may lack the board line: nothing is guessed.
  const board = s?.motherboard;
  return {
    cpu: s?.cpu?.name.trim() || 'unknown CPU',
    gpu: gpu ? gpuTitle(gpu) : 'no GPU reported',
    board: board ? `${board.manufacturer} ${board.product}`.trim() : 'unknown board',
    bios: board?.biosVersion || 'unknown',
    driver: gpu?.driver ?? s?.gpuDriver?.version ?? 'unknown',
    windows: c.windows ?? (s?.os ? `${s.os.caption} build ${s.os.build}` : 'unknown')
  };
}

function ramOf(c: SheetContext): ScoreSheet['ram'] {
  const s = c.snapshot;
  if (!s?.ram) return null;
  const populated = s.ram.modules.filter((m) => m.capacityMiB > 0);
  return {
    configuredMts: populated.find((m) => m.configuredMts > 0)?.configuredMts ?? null,
    dimmVoltage: c.dimmVoltage ?? null,
    modules: populated.length,
    totalGiB: gib(s.ram.totalMiB)
  };
}

/** The thermal-limit share of a telemetry summary: any decoded thermal reason's share of samples. */
function thermalShare(t: TelemetrySummary | null): number {
  if (!t?.gpu) return 0;
  return Object.entries(t.gpu.limitShare)
    .filter(([label]) => /thermal/i.test(label))
    .reduce((sum, [, share]) => sum + share, 0);
}

function validityOf(exp: TuneExport, run: 'headroom' | 'as-found'): SheetValidity[] {
  const scored = run === 'headroom' ? exp.score : exp.asFound;
  const thermal = thermalShare(scored?.telemetry ?? null);
  return [
    { label: 'Fixed workload', ok: true, text: `the worker's 60 s shape (30 s variable, 30 s sustained) repeated ${scored?.repeats ?? 2} times, the same on every card` },
    { label: 'Hash checks', ok: scored ? scored.verdict === 'stable' : null, text: scored ? (scored.verdict === 'stable' ? 'every pass matched the stock reference' : `${scored.verdict}: ${scored.note}`) : 'the run did not score' },
    { label: 'No thermal limit', ok: scored?.telemetry ? thermal <= THERMAL_FRACTION_LIMIT : null, text: scored?.telemetry ? `thermal-limit reasons on ${Math.round(thermal * 100)} % of samples (a power cap is the normal state and does not count)` : 'no telemetry for the run' },
    { label: 'Background load', ok: null, text: 'not measured during the run; the hunt refuses to start while the bench, a worker, a capture or a resident Ollama model has the GPU' }
  ];
}

/** The hunt's official run (or the card as found when nothing was certified) as the sheet. */
export function headroomSheet(exp: TuneExport, result: TuneResult, c: SheetContext): ScoreSheet {
  const official = exp.score?.score ? exp.score : null;
  const run: ScoreSheet['run'] = official ? 'headroom' : 'as-found';
  const scored = official ?? exp.asFound;
  const certified = exp.certified.coreMhz === 0 && exp.certified.memMhz === 0 ? null : exp.certified;
  // The ladder's own rungs: a result the collector wrote before 2026-09-17 lists the scored runs here too.
  const rungs: SheetRung[] = exp.rungs.filter((r) => !isScoredRun(r, exp.asFound) && !isScoredRun(r, exp.score)).map((r) => ({
    ladder: r.ladder,
    offsetMhz: r.ladder === 'memory' ? r.deltas.memMhz - result.baseline.memMhz : r.deltas.coreMhz - result.baseline.coreMhz,
    verdict: r.verdict,
    stage: r.stage,
    points: r.score?.points ?? null,
    held: r.held,
    note: r.note
  }));
  const sheet: ScoreSheet = {
    run,
    title: official ? 'Headroom — the official run of the certified pair' : 'Headroom — the card as found',
    measuredAt: exp.measuredAt,
    appVersion: c.version,
    deviceClass: c.deviceClass ? DEVICE_CLASS_LABEL[c.deviceClass] : null,
    score: scored?.score ?? null,
    referencePoints: exp.referencePoints || REFERENCE_POINTS,
    asFoundPoints: exp.asFound?.score?.points ?? null,
    certified,
    vendorSlider: certified ? exp.vendorSlider : null,
    sliderTotal: certified ? exp.sliderTotal : null,
    vendor: exp.vendor,
    held: { asFound: exp.baselineHeld, certified: exp.heldAtCertified, now: exp.holdsNow },
    rungs,
    telemetry: scored?.telemetry ?? null,
    ram: ramOf(c),
    hardware: hardwareOf(c),
    psu: psuOf(c),
    validity: validityOf(exp, run),
    confidence: exp.confidence,
    confidenceWhy: confidenceWhy(result),
    stops: result.stops.map((s) => ({ ladder: s.ladder, text: s.note })),
    lines: (exp.text || exportText(result, exp.measuredAt.slice(0, 10))).split('\n'),
    footer: EXPORT_FOOTER
  };
  return redact(sheet);
}

const stat = (values: number[]): SheetStat | null => (values.length ? { avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : null);

/**
 * The built-in bench (plan §11a) as a sheet: no points (it measures frame pacing, not
 * throughput, and says so), the GPU tables from the session's own 2 Hz GPU timeline, the
 * limit-reason shares decoded the way the Monitor shows them.
 */
export function benchSheet(session: CaptureSession, report: Report, c: SheetContext): ScoreSheet {
  const facts = session.gpuTimeline.map((s) => s.facts);
  const seconds = session.qpcFrequency > 0 && session.gpuTimeline.length > 1 ? (session.gpuTimeline[session.gpuTimeline.length - 1].qpc - session.gpuTimeline[0].qpc) / session.qpcFrequency : 0;
  const limitShare: Record<string, number> = {};
  for (const f of facts) for (const r of decodeReasons(f.clocksEventReasons.raw)) if (r.label !== 'none') limitShare[r.label] = (limitShare[r.label] ?? 0) + 1 / facts.length;
  const gpu: SheetGpu | null = facts.length
    ? {
        coreMhz: stat(facts.map((f) => f.clocks.smMhz))!,
        memMhz: stat(facts.map((f) => f.clocks.memMhz))!,
        coreC: stat(facts.map((f) => f.temperatureC))!,
        hotspotC: null,
        memoryJunctionC: null,
        boardW: stat(facts.map((f) => f.powerMw / 1000))!,
        powerCapW: Math.max(...facts.map((f) => f.powerLimitMw / 1000)),
        limitShare,
        fanPercent: null
      }
    : null;
  const thermal = facts.length ? facts.filter((f) => hasAny(f.clocksEventReasons.raw, THERMAL_BITS)).length / facts.length : 0;
  const m = report.report.measurements;
  const sheet: ScoreSheet = {
    run: 'bench',
    title: 'Built-in bench',
    measuredAt: session.startedAt,
    appVersion: c.version,
    deviceClass: c.deviceClass ? DEVICE_CLASS_LABEL[c.deviceClass] : null,
    score: null,
    referencePoints: REFERENCE_POINTS,
    asFoundPoints: null,
    certified: null,
    vendorSlider: null,
    sliderTotal: null,
    vendor: null,
    held: { asFound: gpu ? { smMhz: gpu.coreMhz.max, memMhz: gpu.memMhz.max } : null, certified: null, now: null },
    rungs: [],
    telemetry: gpu ? { samples: facts.length, seconds, gpu, cpu: null } : null,
    ram: ramOf({ ...c, snapshot: session.snapshot ?? c.snapshot }),
    hardware: hardwareOf({ ...c, snapshot: session.snapshot ?? c.snapshot, gpu: c.gpu ?? session.snapshot?.gpus[0] }),
    psu: psuOf(c),
    validity: [
      { label: 'Fixed workload', ok: true, text: "the bench's scripted segments, the same on every card" },
      { label: 'Frames', ok: true, text: `${report.session.frames.toLocaleString()} frames analysed over ${Math.round(report.session.durationS)} s; ${m.stutters} stutters, ${m.lostPct.toFixed(1)} % of playtime lost` },
      { label: 'No thermal limit', ok: facts.length ? thermal <= THERMAL_FRACTION_LIMIT : null, text: facts.length ? `thermal-limit reasons on ${Math.round(thermal * 100)} % of samples` : 'no GPU samples in the session' },
      { label: 'Window in front', ok: report.session.presentMode ? !report.session.presentMode.startsWith('Composed') : null, text: report.session.presentMode ?? 'present mode not recorded' }
    ],
    confidence: null,
    lines: [`Bench verdict: ${report.report.verdict ?? 'unknown'}; typical frame ${m.typicalMs.toFixed(1)} ms, worst 1 % ${m.worst1PctMs.toFixed(1)} ms.`, 'The bench has no points: it measures frame pacing, not throughput. Compare its clocks, temperatures and power with a headroom sheet from the same card.'],
    footer: EXPORT_FOOTER
  };
  return redact(sheet);
}
