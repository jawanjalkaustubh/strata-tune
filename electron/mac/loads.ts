/**
 * POST /load on macOS: the Swift worker's kernels (heavy/light matmul and spin, the all-core
 * FMA loop, the fill-rate render) with the GPU or CPU sampled from the sensor stream, one sample
 * per macmon row (2 Hz: the run holds a sensor lease for its length), so
 * src/components/audit/run.ts sees the same LoadRun it gets from the Windows collector.
 * Cancel kills the worker and keeps the samples (plan section 17c).
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import type { LoadKind, LoadRun, LoadRunRequest } from '../../src/collector-types';
import { IDS, qpcNow, type MacSensors, type SensorLease } from './sensors';

const KINDS: LoadKind[] = ['light', 'heavy', 'cpu', 'fillrate'];
const MAX_SECONDS = 600;

export interface StartRefusal {
  status: 400 | 409 | 500;
  error: string;
}

interface Live {
  run: LoadRun;
  child: ChildProcess | null;
  lease: SensorLease | null;
  /** Unsubscribes the run from the sensor ticks. */
  off: (() => void) | null;
  stdout: string;
  stderr: string;
}

export class LoadRunner {
  private readonly runs = new Map<string, Live>();
  private active: Live | null = null;
  private next = 1;

  constructor(private readonly worker: string, private readonly sensors: MacSensors) {}

  /**
   * Answers at once with the running run, so the client has its id (and a Stop reaches it) while
   * the sensors come up to rate; the idle reference and the worker follow in launch().
   */
  start(req: Partial<LoadRunRequest>): LoadRun | StartRefusal {
    const kind = req.kind as LoadKind;
    const seconds = Number(req.seconds);
    if (!KINDS.includes(kind)) return { status: 400, error: `unknown load kind ${String(req.kind)}` };
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) return { status: 400, error: `seconds must be 1-${MAX_SECONDS}` };
    if (this.active && this.active.run.state === 'running') return { status: 409, error: `load run ${this.active.run.id} is still running` };
    if (!fs.existsSync(this.worker)) return { status: 500, error: `Worker not built: ${this.worker}. Run scripts/mac/build-collector.sh.` };

    const id = `mac-${Date.now().toString(36)}-${this.next++}`;
    // qpcStart is set again when the worker starts: the steady window (t >= 3 s) counts from the spawn, not from the wait.
    const run: LoadRun = { id, kind, seconds, state: 'running', exitCode: null, qpcStart: qpcNow(), qpcEnd: null, gpuSamples: [], cpuSamples: [], fillRate: null, error: null };
    const live: Live = { run, child: null, lease: null, off: null, stdout: '', stderr: '' };
    this.runs.set(id, live);
    this.active = live;
    // The sensors run at 5 s with no reader: the lease brings them to 2 Hz, and the idle reference
    // waits for a sample taken at that rate rather than one up to 5 s old.
    live.lease = this.sensors.acquire(`load ${kind}`);
    void this.sensors
      .whenFresh()
      .then(() => this.launch(live))
      .catch((e: Error) => this.finish(live, -1, e.message));
    return run;
  }

  /** After the wait: nothing when a Stop came meanwhile (the run is already cancelled and its lease gone). */
  private launch(live: Live) {
    if (live.run.state !== 'running') return;
    const { kind, seconds } = live.run;
    live.run.qpcStart = qpcNow();
    // The first CPU sample is the idle reference, taken before the worker starts (collector-types.ts LoadRun.cpuSamples).
    this.sample(live);

    const child = spawn(this.worker, ['--load', kind, '--seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
    live.child = child;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => (live.stdout += d));
    child.stderr.on('data', (d: string) => (live.stderr = (live.stderr + d).slice(-2000)));
    const onTick = () => this.sample(live);
    this.sensors.on('tick', onTick);
    live.off = () => this.sensors.off('tick', onTick);
    child.on('error', (e) => this.finish(live, -1, e.message));
    child.on('exit', (code) => this.finish(live, code));
  }

  private finish(live: Live, code: number | null, failure?: string) {
    if (live.run.state !== 'running') return;
    this.end(live);
    live.run.exitCode = code;
    if (failure || code !== 0) {
      live.run.state = 'failed';
      live.run.error = failure ?? (live.stderr.trim().split('\n')[0] || `the worker exited with code ${code}`);
    } else {
      live.run.state = 'done';
      if (live.run.kind === 'fillrate') live.run.fillRate = parseFillRate(live.stdout);
    }
  }

  get(id: string): LoadRun | undefined {
    return this.runs.get(id)?.run;
  }

  /** null: no such run; false: it had already ended (409); the run otherwise. */
  cancel(id: string): LoadRun | null | false {
    const live = this.runs.get(id);
    if (!live) return null;
    if (live.run.state !== 'running') return false;
    this.end(live);
    live.run.state = 'cancelled';
    live.run.exitCode = -1;
    // No child yet when the Stop lands during the wait for a fresh sample: launch() then starts nothing.
    live.child?.kill();
    return live.run;
  }

  stopAll() {
    for (const live of this.runs.values()) if (live.run.state === 'running') this.cancel(live.run.id);
  }

  private end(live: Live) {
    live.off?.();
    live.off = null;
    live.lease?.release();
    live.lease = null;
    live.run.qpcEnd = qpcNow();
    if (this.active === live) this.active = null;
  }

  private sample(live: Live) {
    const v = (id: string) => this.sensors.value(id);
    const qpc = qpcNow();
    if (live.run.kind === 'cpu') {
      live.run.cpuSamples.push({ qpc, packageW: v(IDS.cpuPackageW), tctlC: v(IDS.cpuTempC), avgEffectiveMhz: v(IDS.cpuAvgEffectiveMhz), maxCoreMhz: v(IDS.cpuMaxCoreMhz) });
      return;
    }
    // No PCIe link and no NVML limit bits on an Apple GPU: those fields read as "unknown" (0) and the audit's rules treat them so.
    live.run.gpuSamples.push({ qpc, smMhz: v(IDS.gpuClockMhz) ?? 0, memMhz: 0, powerMw: (v(IDS.gpuPowerW) ?? 0) * 1000, temperatureC: v(IDS.gpuTempC) ?? 0, clocksEventReasons: 0, pcieGen: 0, pcieWidth: 0 });
  }
}

export function parseFillRate(stdout: string): LoadRun['fillRate'] {
  for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).reverse()) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const n = (k: string) => (typeof j[k] === 'number' ? (j[k] as number) : NaN);
      const r = { pixelsPerSecond: n('pixelsPerSecond'), seconds: n('seconds'), frames: n('frames'), width: n('width'), height: n('height') };
      if (Object.values(r).every(Number.isFinite)) return r;
    } catch {
      /* not the result line */
    }
  }
  return null;
}
