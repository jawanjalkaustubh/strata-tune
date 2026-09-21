/**
 * POST /load on macOS: the Swift worker's kernels (heavy/light matmul and spin, the all-core
 * FMA loop, the fill-rate render) with the GPU or CPU sampled at 2 Hz from the sensor stream,
 * so src/components/audit/run.ts sees the same LoadRun it gets from the Windows collector.
 * Cancel kills the worker and keeps the samples (plan section 17c).
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import type { LoadKind, LoadRun, LoadRunRequest } from '../../src/collector-types';
import { IDS, qpcNow, type MacSensors } from './sensors';

const KINDS: LoadKind[] = ['light', 'heavy', 'cpu', 'fillrate'];
const SAMPLE_MS = 500;
const MAX_SECONDS = 600;

export interface StartRefusal {
  status: 400 | 409 | 500;
  error: string;
}

interface Live {
  run: LoadRun;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  stdout: string;
  stderr: string;
}

export class LoadRunner {
  private readonly runs = new Map<string, Live>();
  private active: Live | null = null;
  private next = 1;

  constructor(private readonly worker: string, private readonly sensors: MacSensors) {}

  start(req: Partial<LoadRunRequest>): LoadRun | StartRefusal {
    const kind = req.kind as LoadKind;
    const seconds = Number(req.seconds);
    if (!KINDS.includes(kind)) return { status: 400, error: `unknown load kind ${String(req.kind)}` };
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) return { status: 400, error: `seconds must be 1-${MAX_SECONDS}` };
    if (this.active && this.active.run.state === 'running') return { status: 409, error: `load run ${this.active.run.id} is still running` };
    if (!fs.existsSync(this.worker)) return { status: 500, error: `Worker not built: ${this.worker}. Run scripts/mac/build-collector.sh.` };

    const id = `mac-${Date.now().toString(36)}-${this.next++}`;
    const run: LoadRun = { id, kind, seconds, state: 'running', exitCode: null, qpcStart: qpcNow(), qpcEnd: null, gpuSamples: [], cpuSamples: [], fillRate: null, error: null };
    const live: Live = { run, child: null, timer: null, stdout: '', stderr: '' };
    this.runs.set(id, live);
    this.active = live;
    // The first CPU sample is the idle reference, taken before the worker starts (collector-types.ts LoadRun.cpuSamples).
    this.sample(live);

    const child = spawn(this.worker, ['--load', kind, '--seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
    live.child = child;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => (live.stdout += d));
    child.stderr.on('data', (d: string) => (live.stderr = (live.stderr + d).slice(-2000)));
    live.timer = setInterval(() => this.sample(live), SAMPLE_MS);
    const finish = (code: number | null, failure?: string) => {
      if (live.run.state !== 'running') return;
      this.end(live);
      live.run.exitCode = code;
      if (failure || code !== 0) {
        live.run.state = 'failed';
        live.run.error = failure ?? (live.stderr.trim().split('\n')[0] || `the worker exited with code ${code}`);
      } else {
        live.run.state = 'done';
        if (kind === 'fillrate') live.run.fillRate = parseFillRate(live.stdout);
      }
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('exit', (code) => finish(code));
    return run;
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
    live.child?.kill();
    return live.run;
  }

  stopAll() {
    for (const live of this.runs.values()) if (live.run.state === 'running') this.cancel(live.run.id);
  }

  private end(live: Live) {
    if (live.timer) clearInterval(live.timer);
    live.timer = null;
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
