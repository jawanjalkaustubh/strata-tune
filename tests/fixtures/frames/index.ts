/**
 * Synthetic capture sessions on the dev box's 10 MHz QPC clock. A frame's internals
 * follow PresentMon v2 arithmetic (CPUBusy + CPUWait = frame, GPUBusy + GPUWait = frame)
 * with the busy side fixed and the waits absorbing the rest, so a long frame only shows a
 * busy spike when the test asks for one ('gpu' or 'cpu').
 */
import type { GpuFacts, SensorRow, SensorWindow } from '../../../src/collector-types';
import type { CaptureSession, FrameRow, GpuSample } from '../../../src/analysis/session-types';

export const HZ = 10_000_000;
export const QPC0 = 7_000_000_000_000;
export const GAME_PID = 4242;

export type Kind = 'wait' | 'gpu' | 'cpu';
export interface FrameSpec {
  ms: number;
  kind?: Kind;
  /** Override the busy split outright, for the bound tests. */
  gpuBusy?: number;
  cpuBusy?: number;
}

const GPU_WORK = 4.4;
const CPU_WORK = 4.0;

export function frame(qpc: number, spec: FrameSpec): FrameRow {
  const { ms, kind = 'wait' } = spec;
  const gpuBusy = spec.gpuBusy ?? (kind === 'gpu' ? ms - 1 : Math.min(GPU_WORK, ms));
  const cpuBusy = spec.cpuBusy ?? (kind === 'cpu' ? ms - 1 : Math.min(CPU_WORK, ms));
  return {
    application: 'game.exe', processId: GAME_PID, swapChainAddress: '0x1', presentRuntime: 'DXGI', syncInterval: 0,
    presentFlags: 0, allowsTearing: 1, presentMode: 'Hardware: Independent Flip', timeInQpc: qpc,
    msBetweenSimulationStart: null, msBetweenPresents: ms, msBetweenDisplayChange: ms, msInPresentApi: 0.05,
    msRenderPresentLatency: 8, msUntilDisplayed: 12, cpuStartQpc: qpc - Math.round((cpuBusy * HZ) / 1000),
    msBetweenAppStart: ms, msCpuBusy: cpuBusy, msCpuWait: ms - cpuBusy, msGpuLatency: 8, msGpuTime: gpuBusy + 0.2,
    msGpuBusy: gpuBusy, msGpuWait: ms - gpuBusy, msAnimationError: 0, animationTime: 0, msFlipDelay: null,
    msAllInputToPhotonLatency: null, msClickToPhotonLatency: null
  };
}

/** Frames until `seconds` of capture; `spikeAt(t)` may replace the steady frame at that second. */
export function steady(seconds: number, baseMs: number, spikeAt: (t: number, i: number) => FrameSpec | null = () => null): FrameRow[] {
  const out: FrameRow[] = [];
  let qpc = QPC0;
  while ((qpc - QPC0) / HZ < seconds) {
    const spec = spikeAt((qpc - QPC0) / HZ, out.length) ?? { ms: baseMs };
    qpc += Math.round((spec.ms * HZ) / 1000);
    out.push(frame(qpc, spec));
  }
  return out;
}

/** One spike frame at each second mark, in order. */
export function spikesAt(marks: number[], ms: number, kind: Kind = 'wait'): (t: number) => FrameSpec | null {
  let next = 0;
  return (t) => {
    if (next < marks.length && t >= marks[next]) {
      next++;
      return { ms, kind };
    }
    return null;
  };
}

export function marks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(Number(t.toFixed(3)));
  return out;
}

export interface GpuShape {
  smMhz: number;
  temperatureC: number;
  reasons: number;
  usedMiB: number;
  powerMw: number;
  utilisation: number;
}

/** A 5090 holding 2800 MHz at 65 °C with 12 GB in use, the family's dev box under a game. */
export const GPU_STEADY: GpuShape = { smMhz: 2800, temperatureC: 65, reasons: 0, usedMiB: 12_000, powerMw: 450_000, utilisation: 90 };
export const VRAM_TOTAL_MIB = 32_607;

export function gpuFacts(shape: Partial<GpuShape> = {}): GpuFacts {
  const s = { ...GPU_STEADY, ...shape };
  return {
    index: 0, name: 'NVIDIA GeForce RTX 5090', driver: '616.92',
    pcie: { currentGen: 5, currentWidth: 16, maxGen: 5, maxWidth: 16, gpuMaxGen: 5 },
    bar1TotalMiB: 32_768, vram: { totalMiB: VRAM_TOTAL_MIB, usedMiB: s.usedMiB },
    powerMw: s.powerMw, powerLimitMw: 600_000, powerMaxLimitMw: 600_000,
    clocks: { smMhz: s.smMhz, memMhz: 14_000 }, temperatureC: s.temperatureC,
    utilisation: { gpu: s.utilisation, memory: 40 }, clocksEventReasons: { raw: s.reasons, names: [] },
    pciSubsystem: null, clockOffsets: null
  };
}

/** GPU facts at 2 Hz for `seconds`; `shape(t)` bends any field at that second. */
export function gpuTimeline(seconds: number, shape: (t: number) => Partial<GpuShape> = () => ({}), hz = 2): GpuSample[] {
  const out: GpuSample[] = [];
  for (let i = 0; i < seconds * hz; i++) {
    const t = i / hz;
    out.push({ qpc: QPC0 + Math.round(t * HZ), facts: gpuFacts(shape(t)) });
  }
  return out;
}

/** Full-rate sensor rows for `seconds`; each sensor id maps to its value at second t. */
export function sensorWindow(seconds: number, sensors: Record<string, (t: number) => number>, hz = 1): SensorWindow {
  const rows: SensorRow[] = [];
  for (let i = 0; i < seconds * hz; i++) {
    const t = i / hz;
    const values: Record<string, number> = {};
    for (const [id, at] of Object.entries(sensors)) values[id] = at(t);
    rows.push({ qpc: QPC0 + Math.round(t * HZ), values });
  }
  return { seconds, qpcNow: QPC0 + Math.round(seconds * HZ), rows, summaries: [] };
}

/** Marks that fire when a value should hold: true within `holdS` after any mark. */
export function during(marksS: number[], holdS: number): (t: number) => boolean {
  return (t) => marksS.some((m) => t >= m && t < m + holdS);
}

export function session(frames: FrameRow[], parts: Partial<Pick<CaptureSession, 'gpuTimeline' | 'sensorWindow' | 'snapshot'>> = {}): CaptureSession {
  return {
    id: 'test', startedAt: '2026-09-16T10:00:00Z', game: { pid: GAME_PID, exe: 'game.exe', path: 'D:\\Games\\game.exe' },
    qpcFrequency: HZ, frames, sensorWindow: parts.sensorWindow ?? null, snapshot: parts.snapshot ?? null,
    gpuTimeline: parts.gpuTimeline ?? [], notes: []
  };
}
