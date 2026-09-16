/**
 * Stutter detection and the nine-case classifier (master plan §11), pure functions
 * over a CaptureSession. Detection is per frame against a rolling median; the
 * classifier takes the first matching case in plan order, with the signals it needs
 * read off the sensor window and the GPU timeline at the frame's QPC stamp.
 *
 * "Concurrent" is the plan's ±100 ms, widened to a stream's own cadence when it
 * samples slower than that: GPU facts arrive at 2 Hz and PDH disk queues at 1 Hz, and
 * the nearest reading on either side is the best the timeline has for them. A GPU
 * reading further than 100 ms from the frame is said so in the evidence.
 */
import type { HogsResult, SensorMeta, SensorWindow } from '../collector-types';
import { judgeBound } from './bound';
import { frameTimeMs, WARMUP_FRAMES } from './frames';
import { hasAny, hasBit, SW_POWER_CAP, THERMAL_OR_BRAKE } from './nvmlBits';
import type {
  BoundVerdict, CaptureSession, CauseId, ClassifiedCause, Detection, FrameRow, GpuSample, ReportCause,
  StutterEvent, StutterReport
} from './session-types';

const MEDIAN_WINDOW = 120;
const SPIKE_RATIO = 2.0;
const ABSOLUTE_MS = 50;

/** A busy or wait column "spikes" when it doubles its baseline and explains half the lost time. */
const SIGNAL_RATIO = 2.0;
const NORMAL_RATIO = 1.5;
const EXPLAINS_SHARE = 0.5;
const CONCURRENT_S = 0.1;
/** Where NVIDIA's slowdown target sits on every generation since Pascal; the driver never reports it. */
const THERMAL_TARGET_C = 83;
const CLOCK_DROP = 0.05;
const AT_POWER_LIMIT = 0.95;
const VRAM_FULL = 0.95;
/** New assets arriving raise VRAM by hundreds of MiB between two readings; a few MiB of jitter is not a load. */
const VRAM_RISE = 0.005;
const DISK_QUEUE_SPIKE = 2;
const DISK_QUEUE_DEEP = 4;
/** One full core of the machine, in percent × logical CPUs, before a process counts as a hog. */
const HOG_CORE_PERCENT = 100;
const HOG_LOUD_PERCENT = 25;
const DECAY_MIN = 0.5;
const DECAY_ESTABLISHED = 6;
const PERIODIC_MIN_EVENTS = 5;
const PERIODIC_ESTABLISHED = 8;
const PERIODIC_MAX_CV = 0.15;
/** A tick, not frame-to-frame alternation: anything faster than this is pacing (case 9). */
const PERIODIC_MIN_INTERVAL_S = 0.25;
const ALTERNATING_MIN_FRAMES = 6;
const ALTERNATING_ESTABLISHED = 10;
const ALTERNATING_RATIO = 1.5;
const FINE_MAX_PERCENT_LOST = 0.5;
const FINE_MAX_PER_MINUTE = 2;
/** The rate is judged only past the first minute: one hitch in a 17 s capture is not "3.5 a minute". */
const FINE_RATE_FROM_MINUTES = 1;

// ---------------------------------------------------------------------------
// Detection

/** Sorted window of the last `size` values; O(size) per push is nothing at 120. */
class RollingMedian {
  private readonly order: number[] = [];
  private readonly sorted: number[] = [];
  constructor(private readonly size: number) {}

  push(v: number): void {
    this.order.push(v);
    this.sorted.splice(lowerBound(this.sorted, v), 0, v);
    if (this.order.length > this.size) {
      const old = this.order.shift()!;
      this.sorted.splice(lowerBound(this.sorted, old), 1);
    }
  }

  median(): number | null {
    return this.sorted.length ? medianOfSorted(this.sorted) : null;
  }
}

function lowerBound(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function medianOfSorted(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function median(values: number[]): number | null {
  return values.length ? medianOfSorted([...values].sort((a, b) => a - b)) : null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[pos];
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Plan §11 detection: the first 300 frames are the level load and are skipped; a frame
 * is a stutter when it is over twice the median of the 120 frames before it, or over
 * 50 ms outright. The level load feeds nothing, not even the median, so a hitch right
 * after it is judged against play and not against loading; the first analysed frame
 * seeds the window and is counted but not judged.
 */
export function detectStutters(frames: FrameRow[]): Detection {
  const rolling = new RollingMedian(MEDIAN_WINDOW);
  const events: StutterEvent[] = [];
  const analysed: number[] = [];
  const smooth: number[] = [];
  let totalMs = 0;
  let lostMs = 0;
  for (let i = WARMUP_FRAMES; i < frames.length; i++) {
    const ms = frameTimeMs(frames[i]);
    const med = rolling.median();
    analysed.push(ms);
    totalMs += ms;
    const spike = med !== null && ms > SPIKE_RATIO * med;
    if (med !== null && (spike || ms > ABSOLUTE_MS)) {
      lostMs += ms - med;
      events.push({ index: i, qpc: frames[i].timeInQpc, frameMs: ms, medianMs: med, kind: spike ? 'spike' : 'absolute', cause: null });
    } else {
      smooth.push(ms);
    }
    rolling.push(ms);
  }
  const sorted = [...analysed].sort((a, b) => a - b);
  return {
    events,
    stutterCount: events.length,
    percentTimeLost: totalMs > 0 ? (100 * lostMs) / totalMs : 0,
    pacingStdevMs: stdev(smooth),
    typicalFrameMs: sorted.length ? medianOfSorted(sorted) : 0,
    worst1PctMs: percentile(sorted, 0.99),
    analysedFrames: analysed.length,
    totalMs
  };
}

// ---------------------------------------------------------------------------
// Timeline lookups

/** Samples of one stream around a QPC stamp: ±100 ms, or ± the stream's own interval when it is slower. */
class Timeline<T> {
  private readonly qpcs: number[];
  private readonly windowTicks: number;

  constructor(private readonly samples: T[], qpcOf: (s: T) => number, qpcFrequency: number) {
    this.qpcs = samples.map(qpcOf);
    const gaps: number[] = [];
    for (let i = 1; i < this.qpcs.length; i++) gaps.push(this.qpcs[i] - this.qpcs[i - 1]);
    const cadence = median(gaps) ?? 0;
    this.windowTicks = Math.max(CONCURRENT_S * qpcFrequency, cadence);
  }

  at(qpc: number): T[] {
    const from = lowerBound(this.qpcs, qpc - this.windowTicks);
    const out: T[] = [];
    for (let i = from; i < this.qpcs.length && this.qpcs[i] <= qpc + this.windowTicks; i++) out.push(this.samples[i]);
    return out;
  }

  /** The last sample strictly before the concurrent window around `qpc`. */
  before(qpc: number): T | null {
    const i = lowerBound(this.qpcs, qpc - this.windowTicks) - 1;
    return i >= 0 ? this.samples[i] : null;
  }

  /** Ticks from `qpc` to the nearest sample, or null with no samples. */
  distance(qpc: number): number | null {
    const i = lowerBound(this.qpcs, qpc);
    const after = i < this.qpcs.length ? this.qpcs[i] - qpc : null;
    const before = i > 0 ? qpc - this.qpcs[i - 1] : null;
    if (after === null) return before;
    if (before === null) return after;
    return Math.min(after, before);
  }
}

const DISK_QUEUE_ID = /^\/pdh\/physicaldisk\/\d+\/queue$/;

/** Sensor ids that are a disk queue depth: by meta name when the caller has it, else by the collector's id shape. */
function diskQueueIds(window: SensorWindow, meta: SensorMeta[] | undefined): string[] {
  if (meta) return meta.filter((m) => /disk queue length/i.test(m.name)).map((m) => m.id);
  const ids = new Set<string>();
  for (const row of window.rows) for (const id of Object.keys(row.values)) if (DISK_QUEUE_ID.test(id)) ids.add(id);
  for (const s of window.summaries) for (const id of Object.keys(s.max)) if (DISK_QUEUE_ID.test(id)) ids.add(id);
  return [...ids];
}

interface DiskPeak {
  id: string;
  value: number;
  base: number;
}

/**
 * The disk queue sensors: full-rate rows around a stamp when the window has them, else
 * the 1 Hz fold's max. A queue "spikes" at 2 outstanding requests or three times its
 * usual depth, whichever is more.
 */
class DiskQueues {
  private readonly rows: Timeline<SensorWindow['rows'][number]>;
  private readonly base = new Map<string, number>();

  constructor(private readonly window: SensorWindow, qpcFrequency: number, meta: SensorMeta[] | undefined) {
    this.rows = new Timeline(window.rows, (r) => r.qpc, qpcFrequency);
    for (const id of diskQueueIds(window, meta)) this.base.set(id, median(this.all(id)) ?? 0);
  }

  peakAt(qpc: number): DiskPeak | null {
    let peak: DiskPeak | null = null;
    for (const [id, base] of this.base) {
      const values = this.at(id, qpc);
      if (!values.length) continue;
      const value = Math.max(...values);
      if (!peak || value > peak.value) peak = { id, value, base };
    }
    return peak;
  }

  spikeAt(qpc: number): DiskPeak | null {
    const peak = this.peakAt(qpc);
    return peak && peak.value >= Math.max(DISK_QUEUE_SPIKE, 3 * peak.base) ? peak : null;
  }

  private at(id: string, qpc: number): number[] {
    const values = this.rows.at(qpc).map((r) => r.values[id]).filter((v): v is number => v !== undefined);
    if (values.length) return values;
    return this.window.summaries.filter((s) => s.qpcStart <= qpc && qpc <= s.qpcEnd && s.max[id] !== undefined).map((s) => s.max[id]);
  }

  private all(id: string): number[] {
    const out: number[] = [];
    for (const r of this.window.rows) if (r.values[id] !== undefined) out.push(r.values[id]);
    for (const s of this.window.summaries) if (s.max[id] !== undefined) out.push(s.max[id]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Per-event signals

interface FrameSignals {
  frameMs: number;
  gpuBusySpike: boolean;
  gpuBusyNormal: boolean;
  cpuBusySpike: boolean;
  cpuBusyNormal: boolean;
  cpuSideElevated: boolean;
  gpuWaitHigh: boolean;
  gpuBusy: number | null;
  cpuBusy: number | null;
}

function baseline(frames: FrameRow[], index: number, pick: (f: FrameRow) => number | null): number | null {
  const values: number[] = [];
  for (let i = Math.max(0, index - MEDIAN_WINDOW); i < index; i++) {
    const v = pick(frames[i]);
    if (v !== null) values.push(v);
  }
  return median(values);
}

function spikes(value: number | null, base: number | null, excessMs: number): boolean {
  if (value === null || base === null) return false;
  return value > SIGNAL_RATIO * base && value - base >= EXPLAINS_SHARE * excessMs;
}

function normal(value: number | null, base: number | null): boolean {
  return value === null || base === null || value <= NORMAL_RATIO * base;
}

function frameSignals(frames: FrameRow[], event: StutterEvent): FrameSignals {
  const f = frames[event.index];
  const excessMs = event.frameMs - event.medianMs;
  const gpuBusyBase = baseline(frames, event.index, (r) => r.msGpuBusy);
  const cpuBusyBase = baseline(frames, event.index, (r) => r.msCpuBusy);
  const cpuWaitBase = baseline(frames, event.index, (r) => r.msCpuWait);
  const gpuWaitBase = baseline(frames, event.index, (r) => r.msGpuWait);
  const cpuBusySpike = spikes(f.msCpuBusy, cpuBusyBase, excessMs);
  return {
    frameMs: event.frameMs,
    gpuBusySpike: spikes(f.msGpuBusy, gpuBusyBase, excessMs),
    gpuBusyNormal: normal(f.msGpuBusy, gpuBusyBase),
    cpuBusySpike,
    cpuBusyNormal: normal(f.msCpuBusy, cpuBusyBase),
    cpuSideElevated: cpuBusySpike || spikes(f.msCpuWait, cpuWaitBase, excessMs),
    gpuWaitHigh: spikes(f.msGpuWait, gpuWaitBase, excessMs),
    gpuBusy: f.msGpuBusy,
    cpuBusy: f.msCpuBusy
  };
}

interface GpuSignals {
  thermalBit: boolean;
  powerBit: boolean;
  clockDrop: boolean;
  minSmMhz: number | null;
  maxTempC: number | null;
  hot: boolean;
  atPowerLimit: boolean;
  vramShare: number | null;
  vramGrew: boolean;
  /** Seconds from the frame to the nearest reading when that is beyond the plan's ±100 ms; null when within it. */
  farS: number | null;
}

function gpuSignals(samples: GpuSample[], previous: GpuSample | null, referenceSmMhz: number | null, farS: number | null): GpuSignals {
  const facts = samples.map((s) => s.facts);
  const minSm = facts.length ? Math.min(...facts.map((f) => f.clocks.smMhz)) : null;
  const maxTemp = facts.length ? Math.max(...facts.map((f) => f.temperatureC)) : null;
  const vram = facts.length ? Math.max(...facts.map((f) => (f.vram.totalMiB > 0 ? f.vram.usedMiB / f.vram.totalMiB : 0))) : null;
  const usedNow = facts.length ? Math.max(...facts.map((f) => f.vram.usedMiB)) : null;
  const totalMiB = facts.length ? Math.max(...facts.map((f) => f.vram.totalMiB)) : 0;
  return {
    thermalBit: facts.some((f) => hasAny(f.clocksEventReasons.raw, THERMAL_OR_BRAKE)),
    powerBit: facts.some((f) => hasBit(f.clocksEventReasons.raw, SW_POWER_CAP)),
    clockDrop: minSm !== null && referenceSmMhz !== null && minSm < (1 - CLOCK_DROP) * referenceSmMhz,
    minSmMhz: minSm,
    maxTempC: maxTemp,
    hot: maxTemp !== null && maxTemp >= THERMAL_TARGET_C,
    atPowerLimit: facts.some((f) => f.powerLimitMw > 0 && f.powerMw >= AT_POWER_LIMIT * f.powerLimitMw),
    vramShare: vram,
    vramGrew: usedNow !== null && previous !== null && totalMiB > 0 && usedNow - previous.facts.vram.usedMiB >= VRAM_RISE * totalMiB,
    farS
  };
}

/** The GPU rules' evidence closes with how far the reading sat from the frame when that was beyond ±100 ms. */
function withDistance(evidence: string[], g: GpuSignals): string[] {
  return g.farS === null ? evidence : [...evidence, `nearest GPU reading ${g.farS.toFixed(1)} s from the frame`];
}

/** Models Ollama held resident when the capture started, for the VRAM evidence: the game did not fill the card alone. */
function residentModels(session: CaptureSession): string | null {
  const models = (session.snapshot?.ollama ?? []).filter((m) => m.sizeVramBytes > 0);
  if (!models.length) return null;
  const gib = models.reduce((a, m) => a + m.sizeVramBytes, 0) / 2 ** 30;
  return `Ollama held ${gib.toFixed(1)} GB of it (${models.map((m) => m.name).join(', ')})`;
}

// ---------------------------------------------------------------------------
// Session-level facts

/** The clock the card holds when nothing slows it: the 90th percentile of the timeline. */
function referenceClock(timeline: GpuSample[]): number | null {
  const sorted = timeline.map((s) => s.facts.clocks.smMhz).filter((v) => v > 0).sort((a, b) => a - b);
  return sorted.length ? percentile(sorted, 0.9) : null;
}

/** Case 1's decay test: candidate events in the second half of the capture against the first. */
function decayOf(events: StutterEvent[], candidates: Set<number>, frames: FrameRow[]): { decay: number; count: number } {
  const first = frames[Math.min(WARMUP_FRAMES, frames.length - 1)]?.timeInQpc ?? 0;
  const last = frames[frames.length - 1]?.timeInQpc ?? 0;
  const mid = (first + last) / 2;
  let early = 0;
  let late = 0;
  for (const e of events) {
    if (!candidates.has(e.index)) continue;
    if (e.qpc < mid) early++;
    else late++;
  }
  return { decay: early > 0 ? 1 - late / early : 0, count: early + late };
}

/** Case 7's regularity: coefficient of variation of the gaps between consecutive stutters. */
function periodicity(events: StutterEvent[], qpcFrequency: number): { cv: number; periodS: number; count: number } {
  const gaps: number[] = [];
  for (let i = 1; i < events.length; i++) gaps.push((events[i].qpc - events[i - 1].qpc) / qpcFrequency);
  if (gaps.length < 2) return { cv: Number.POSITIVE_INFINITY, periodS: 0, count: events.length };
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return { cv: mean > 0 ? stdev(gaps) / mean : Number.POSITIVE_INFINITY, periodS: mean, count: events.length };
}

/** Case 9's pattern: the longest run of frames through `index` that alternate long/short by ≥ 1.5×. */
function alternatingRun(frames: FrameRow[], index: number): number {
  const from = Math.max(0, index - ALTERNATING_ESTABLISHED);
  const to = Math.min(frames.length - 1, index + ALTERNATING_ESTABLISHED);
  let best = 0;
  let run = 1;
  let runStart = from;
  let lastDir = 0;
  for (let i = from + 1; i <= to; i++) {
    const a = frameTimeMs(frames[i - 1]);
    const b = frameTimeMs(frames[i]);
    const swing = Math.max(a, b) / Math.max(Math.min(a, b), 1e-6) >= ALTERNATING_RATIO;
    const dir = b > a ? 1 : -1;
    if (swing && dir !== lastDir) {
      run++;
    } else {
      run = swing ? 2 : 1;
      runStart = swing ? i - 1 : i;
    }
    lastDir = swing ? dir : 0;
    if (runStart <= index && i >= index) best = Math.max(best, run);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Classifier

export interface ClassifyExtras {
  /** The idle process sample; Phase 1 records no per-process stream, so case 6 runs on this or not at all. */
  hogs?: HogsResult | null;
  /** Sensor names, so the disk queue ids are found by name rather than by id shape. */
  sensorMeta?: SensorMeta[];
}

const FIXABLE: Record<CauseId, boolean> = {
  'shader-compile': true, thermal: true, 'power-limit': true, vram: true, storage: true,
  background: true, periodic: false, engine: false, pacing: true
};

const CASE_OF: Record<CauseId, ClassifiedCause['case']> = {
  'shader-compile': 1, thermal: 2, 'power-limit': 3, vram: 4, storage: 5, background: 6, periodic: 7, engine: 8, pacing: 9
};

function cause(id: CauseId, confidence: 'high' | 'low', evidence: string[], process?: string): ClassifiedCause {
  const c: ClassifiedCause = { case: CASE_OF[id], id, fixable: FIXABLE[id], confidence, evidence };
  if (process) c.process = process;
  return c;
}

const ms = (v: number) => `${v.toFixed(1)} ms`;

/**
 * Plan §11: first match wins in case order. Returns new events with `cause` filled;
 * an event no case claims keeps null.
 */
export function classify(events: StutterEvent[], session: CaptureSession, extras: ClassifyExtras = {}): StutterEvent[] {
  const { frames, qpcFrequency } = session;
  const gpu = new Timeline(session.gpuTimeline, (s) => s.qpc, qpcFrequency);
  const disks = session.sensorWindow ? new DiskQueues(session.sensorWindow, qpcFrequency, extras.sensorMeta) : null;
  const refClock = referenceClock(session.gpuTimeline);
  const signals = events.map((e) => frameSignals(frames, e));

  const shaderCandidates = new Set<number>();
  events.forEach((e, i) => { if (signals[i].gpuBusySpike && signals[i].cpuBusyNormal) shaderCandidates.add(e.index); });
  const decay = decayOf(events, shaderCandidates, frames);
  const period = periodicity(events, qpcFrequency);
  const periodic = period.count >= PERIODIC_MIN_EVENTS && period.cv < PERIODIC_MAX_CV && period.periodS >= PERIODIC_MIN_INTERVAL_S;

  const hogs = extras.hogs ?? null;
  const hog = hogs?.processes.find((p) => p.pid !== session.game.pid && p.cpuPercent * hogs.logicalCpus >= HOG_CORE_PERCENT) ?? null;
  const resident = residentModels(session);
  const concurrentTicks = CONCURRENT_S * qpcFrequency;

  return events.map((event, i) => {
    const s = signals[i];
    const distance = gpu.distance(event.qpc);
    const farS = distance !== null && distance > concurrentTicks ? distance / qpcFrequency : null;
    const g = gpuSignals(gpu.at(event.qpc), gpu.before(event.qpc), refClock, farS);
    const disk = disks?.spikeAt(event.qpc) ?? null;
    const vramFull = g.vramShare !== null && g.vramShare >= VRAM_FULL;
    // Plan §11 case 4 is "≥ 95 % + spike on new assets": a card that merely sits full (a resident model, a big texture pool) is not the cause.
    const vramPaging = vramFull && (g.vramGrew || s.gpuBusySpike);
    const resourceQuiet = !g.thermalBit && !g.powerBit && !g.clockDrop && !vramFull && !disk;

    // A GPU spike the driver explains with a slowdown bit is throttling, not compilation.
    let cause: ClassifiedCause | null = null;
    if (s.gpuBusySpike && s.cpuBusyNormal && !g.thermalBit && !g.powerBit && decay.decay >= DECAY_MIN) {
      cause = cause1(s, decay);
    } else if (g.clockDrop && (g.thermalBit || g.hot)) {
      cause = cause2(g);
    } else if (g.clockDrop && g.powerBit && !g.hot) {
      cause = cause3(g);
    } else if (vramPaging) {
      cause = cause4(g, s, resident);
    } else if (disk) {
      cause = cause5(disk, s);
    } else if (hog && s.cpuSideElevated) {
      cause = cause6(hog.name, hog.cpuPercent, s);
    } else if (periodic) {
      cause = cause7(period);
    } else if (s.cpuBusySpike && (s.gpuWaitHigh || s.gpuBusyNormal)) {
      cause = cause8(s);
    } else if (resourceQuiet && !s.gpuBusySpike && !s.cpuBusySpike) {
      const run = alternatingRun(frames, event.index);
      if (run >= ALTERNATING_MIN_FRAMES) cause = cause9(run);
    }
    return { ...event, cause };
  });
}

function cause1(s: FrameSignals, decay: { decay: number; count: number }): ClassifiedCause {
  return cause('shader-compile', decay.count >= DECAY_ESTABLISHED ? 'high' : 'low', [
    `GPU busy ${ms(s.gpuBusy ?? 0)} on a ${ms(s.frameMs)} frame while the CPU side stayed normal`,
    `${Math.round(decay.decay * 100)} % fewer of these in the second half of the capture (${decay.count} in all)`
  ]);
}

function cause2(g: GpuSignals): ClassifiedCause {
  const evidence = [`SM clock fell to ${g.minSmMhz} MHz`];
  if (g.thermalBit) evidence.push('the driver flagged a thermal slowdown');
  if (g.hot) evidence.push(`GPU at ${g.maxTempC} °C, on its ${THERMAL_TARGET_C} °C target`);
  return cause('thermal', g.thermalBit ? 'high' : 'low', withDistance(evidence, g));
}

function cause3(g: GpuSignals): ClassifiedCause {
  const evidence = [`SM clock fell to ${g.minSmMhz} MHz`, 'the driver flagged the power cap', `GPU at ${g.maxTempC} °C, under its target`];
  if (g.atPowerLimit) evidence.push('board power was at its limit');
  return cause('power-limit', g.atPowerLimit ? 'high' : 'low', withDistance(evidence, g));
}

/** The level is one signal; growth and a GPU-busy spike are the other, and both together make it sure. */
function cause4(g: GpuSignals, s: FrameSignals, resident: string | null): ClassifiedCause {
  const evidence = [`video memory ${Math.round((g.vramShare ?? 0) * 100)} % full`];
  if (resident) evidence.push(resident);
  if (g.vramGrew) evidence.push('and still growing, so new assets were being loaded');
  if (s.gpuBusySpike) evidence.push(`GPU busy ${ms(s.gpuBusy ?? 0)} on this frame`);
  return cause('vram', g.vramGrew && s.gpuBusySpike ? 'high' : 'low', withDistance(evidence, g));
}

function cause5(disk: DiskPeak, s: FrameSignals): ClassifiedCause {
  const evidence = [`disk queue at ${disk.value.toFixed(1)} against a usual ${disk.base.toFixed(1)}`];
  if (s.cpuSideElevated) evidence.push('the CPU side of the frame was waiting');
  return cause('storage', disk.value >= DISK_QUEUE_DEEP && s.cpuSideElevated ? 'high' : 'low', evidence);
}

function cause6(name: string, cpuPercent: number, s: FrameSignals): ClassifiedCause {
  const evidence = [`${name} was using ${Math.round(cpuPercent)} % of the machine`, `the CPU side of a ${ms(s.frameMs)} frame stretched`];
  return cause('background', cpuPercent >= HOG_LOUD_PERCENT ? 'high' : 'low', evidence, name);
}

function cause7(period: { cv: number; periodS: number; count: number }): ClassifiedCause {
  return cause('periodic', period.count >= PERIODIC_ESTABLISHED ? 'high' : 'low', [
    `${period.count} stutters every ${period.periodS.toFixed(2)} s, varying by only ${Math.round(period.cv * 100)} %`
  ]);
}

function cause8(s: FrameSignals): ClassifiedCause {
  const evidence = [`CPU busy ${ms(s.cpuBusy ?? 0)} on a ${ms(s.frameMs)} frame`];
  evidence.push(s.gpuWaitHigh ? 'the GPU sat waiting for it' : 'GPU work stayed normal');
  evidence.push('no sensor moved');
  return cause('engine', s.gpuWaitHigh ? 'high' : 'low', evidence);
}

function cause9(run: number): ClassifiedCause {
  return cause('pacing', run >= ALTERNATING_ESTABLISHED ? 'high' : 'low', [
    `${run} frames in a row alternated long and short`, 'no sensor moved and neither CPU nor GPU work spiked'
  ]);
}

// ---------------------------------------------------------------------------
// Report

const HEADLINE: Record<StutterReport['verdict'], string> = {
  short: 'Not enough frames to judge — the first 300 are treated as the level load',
  fine: 'No stutter worth fixing',
  fixable: 'Stuttering found — and you can do something about it',
  engine: 'Stuttering found — nothing on your end changes this',
  mixed: 'Stuttering found — some of it you can fix, the rest is the game',
  unclear: 'Stuttering found — this capture does not show a clear cause'
};

type Wording = (n: { count: number; process: string; periodS: string }) => { text: string; action: string };

const WORDING: Record<ReportCause['id'], Wording> = {
  'shader-compile': () => ({
    text: 'The GPU spent extra time on frames while the game built shaders for things it had not drawn yet. The stutters thinned out as the session went on, which is the tell.',
    action: 'Let it play out: it settles once the game has drawn everything once. If the game offers a shader pre-compile step in its settings, run it; a driver update resets the shader cache, so expect one more pass after that.'
  }),
  thermal: () => ({
    text: 'The GPU got hot enough to slow its own clock, and the frames it slowed on were the stutters.',
    action: 'Give the card cooler air: raise its fan curve, clean the dust filters, add case airflow, or lower its power limit a little so it runs cooler at nearly the same speed.'
  }),
  'power-limit': () => ({
    text: 'The GPU hit its power limit and dropped its clock to stay under it. Temperatures were fine.',
    action: "Raise the power limit in your card's tuning tool if it allows, or undervolt so the card does the same work with less power."
  }),
  vram: () => ({
    text: 'Video memory was almost full, so the game had to swap textures in and out over the PCIe bus during those frames.',
    action: 'Lower the texture quality one step or turn off the highest texture pack, so everything fits in video memory.'
  }),
  storage: () => ({
    text: 'The drive had a queue of requests waiting at the moment of each stutter; the game was waiting on disk.',
    action: 'Keep the game on an NVMe SSD with at least 15 % free, and check nothing else (backups, indexing, downloads) is hammering the drive while you play.'
  }),
  background: ({ process }) => ({
    text: `Another program, ${process}, was using the CPU while the game needed it.`,
    action: `Close ${process} before playing, or set it to low priority in Task Manager.`
  }),
  periodic: ({ periodS }) => ({
    text: `The stutters arrived on a fixed beat, every ${periodS} s: the game's own garbage collector or streaming tick.`,
    action: "No setting on your end changes this. It is in the game's engine; a patch from the developer is the only fix."
  }),
  engine: () => ({
    text: 'The CPU side of the game stalled while the GPU sat waiting, with nothing on your PC under strain.',
    action: "No setting on your end changes this. It is the game's own code; lowering graphics settings will not help."
  }),
  pacing: () => ({
    text: 'Frames alternated between long and short with nothing under strain: the game and the display were fighting over timing.',
    action: "Cap the frame rate a few frames under your monitor's refresh rate, and check vsync and frame generation: turn one of them off."
  }),
  unclassified: ({ count }) => ({
    text: `${count} stutter${count === 1 ? '' : 's'} matched none of the known signatures.`,
    action: 'Capture a longer session with the collector running, so the next report has sensors to go on.'
  })
};

interface CauseTally {
  ms: number;
  count: number;
  high: number;
  process?: string;
}

/**
 * Plan §11 report: headline verdict, causes by share of time lost with a plain paragraph
 * and an action each, the bound verdict, and the raw numbers. `detection.events` should
 * be the classified events (see analyseSession); unclassified ones get their own row.
 */
export function buildReport(session: CaptureSession, detection: Detection, bound: BoundVerdict): StutterReport {
  const tally = new Map<ReportCause['id'], CauseTally>();
  for (const e of detection.events) {
    const id = e.cause?.id ?? 'unclassified';
    const entry = tally.get(id) ?? { ms: 0, count: 0, high: 0 };
    entry.ms += e.frameMs - e.medianMs;
    entry.count++;
    if (e.cause?.confidence === 'high') entry.high++;
    if (e.cause?.process) entry.process = e.cause.process;
    tally.set(id, entry);
  }
  const periodS = periodicity(detection.events.filter((e) => e.cause?.id === 'periodic'), session.qpcFrequency).periodS.toFixed(2);
  const totalLost = [...tally.values()].reduce((a, b) => a + b.ms, 0);
  const causes: ReportCause[] = [...tally.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([id, entry]) => {
      const wording = WORDING[id]({ count: entry.count, process: entry.process ?? 'another program', periodS });
      return {
        id,
        share: totalLost > 0 ? entry.ms / totalLost : 0,
        fixable: id === 'unclassified' ? false : FIXABLE[id],
        confidence: entry.high * 2 >= entry.count ? 'high' : 'low',
        text: wording.text,
        action: wording.action
      };
    });

  const minutes = detection.totalMs / 60_000;
  const perMinute = minutes > 0 ? detection.stutterCount / minutes : 0;
  const fixableShare = causes.filter((c) => c.id !== 'unclassified' && c.fixable).reduce((a, c) => a + c.share, 0);
  const engineShare = causes.filter((c) => c.id !== 'unclassified' && !c.fixable).reduce((a, c) => a + c.share, 0);

  let verdict: StutterReport['verdict'];
  if (detection.analysedFrames === 0) verdict = 'short';
  else if (detection.percentTimeLost < FINE_MAX_PERCENT_LOST && (minutes < FINE_RATE_FROM_MINUTES || perMinute <= FINE_MAX_PER_MINUTE)) verdict = 'fine';
  else if (fixableShare > 0 && engineShare === 0) verdict = 'fixable';
  else if (engineShare > 0 && fixableShare === 0) verdict = 'engine';
  else if (fixableShare > 0 && engineShare > 0) verdict = 'mixed';
  else verdict = 'unclear';

  const gpuTemps = session.gpuTimeline.map((g) => g.facts.temperatureC);
  const vram = session.gpuTimeline.map((g) => (g.facts.vram.totalMiB > 0 ? g.facts.vram.usedMiB / g.facts.vram.totalMiB : 0));
  const measurements: Record<string, number | string> = {
    'Game': session.game.exe,
    'Frames captured': session.frames.length,
    'Frames analysed': detection.analysedFrames,
    'Duration (s)': round(detection.totalMs / 1000, 1),
    'Average FPS': detection.totalMs > 0 ? round((1000 * detection.analysedFrames) / detection.totalMs, 1) : 0,
    'Typical frame (ms)': round(detection.typicalFrameMs, 2),
    'Worst 1 % frame (ms)': round(detection.worst1PctMs, 2),
    'Pacing stdev (ms)': round(detection.pacingStdevMs, 2),
    'Stutters': detection.stutterCount,
    'Stutters per minute': round(perMinute, 2),
    'Time lost (%)': round(detection.percentTimeLost, 2),
    'GPU busy share': round(bound.gpuBusyShare, 2),
    'CPU busy share': round(bound.cpuBusyShare, 2)
  };
  if (gpuTemps.length) {
    measurements['GPU max temperature (°C)'] = Math.max(...gpuTemps);
    measurements['VRAM peak (%)'] = Math.round(Math.max(...vram) * 100);
    measurements['GPU samples'] = session.gpuTimeline.length;
  }

  return {
    headline: HEADLINE[verdict],
    verdict,
    stutterCount: detection.stutterCount,
    percentTimeLost: detection.percentTimeLost,
    pacingStdevMs: detection.pacingStdevMs,
    typicalFrameMs: detection.typicalFrameMs,
    worst1PctMs: detection.worst1PctMs,
    causes,
    bound,
    events: detection.events,
    measurements
  };
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** Detect, classify, judge the limiter and write the report in one call; the session's own hogs sample feeds case 6 unless the caller brings one. */
export function analyseSession(session: CaptureSession, extras: ClassifyExtras = {}): StutterReport {
  const detection = detectStutters(session.frames);
  const events = classify(detection.events, session, { hogs: session.hogs ?? null, ...extras });
  return buildReport(session, { ...detection, events }, judgeBound(session));
}
