import type { CollectorApi } from '../../api';
import { api, ipcErrorMessage } from '../../api';
import { needsFillRateCrossCheck, runAudit, type AuditFinding } from '../../analysis/audit';
import type { LoadKind, LoadRun } from '../../collector-types';
import { loadSettings } from '../../settings';
import { gpuTitle } from '../monitor/vendors';
import { panelName } from '../monitor/Panel';
import { gpuKey } from '../monitor/GpuPanel';
import { BOARD_KEY, boardName } from '../monitor/BoardPanel';

/** One audit result, as the page shows and stores it. */
export interface AuditResult {
  at: string;
  machine: string;
  findings: AuditFinding[];
  /** Sampled steps that failed, with the reason; their checks read "unknown". */
  skipped: string[];
  /** Stop pressed (plan section 17c): the step it landed on, one-based, and the steps after it never ran. Shown for the session, never saved over a complete run. */
  interrupted?: { step: number; of: number; label: string } | null;
}

export interface Step {
  label: string;
  seconds: number;
}

/** Expected seconds per step drive the progress line; the whole run is about 50 s. */
export const STEPS: Step[] = [
  { label: 'Reading the system snapshot', seconds: 2 },
  { label: 'Sampling idle background load', seconds: 5 },
  { label: 'PCIe link under a light load', seconds: 3 },
  { label: 'Thermal headroom under a heavy load', seconds: 20 },
  { label: 'CPU under an all-core load', seconds: 20 }
];
/**
 * Appended only when the driver gave no direct ROP count (audit rule gpu-units): 6 s of
 * measured fill after the bench's start-up and 1 s warm-up.
 */
export const FILL_RATE_STEP: Step = { label: 'Fill-rate cross-check (the driver gave no ROP count)', seconds: 8 };
const FILL_RATE_SECONDS = 6;
/** The timer probe's trace (audit rule timer-resolution): instant unless a process holds the timer raised, then powercfg names it in about this many seconds plus its analysis. */
const TIMER_TRACE_SECONDS = 5;

export const totalSeconds = (steps: Step[]) => steps.reduce((a, s) => a + s.seconds, 0);

export interface AuditRun {
  /** The result once every step has run or Stop cut the run short; rejects only when the snapshot itself failed. */
  done: Promise<AuditResult>;
  /** Stop (plan section 17c): cancels a load run on the collector, abandons a sample in flight and skips the steps after it; the checks that have their inputs are still judged. Idempotent. */
  stop: () => void;
}

/**
 * The audit's steps in order, reporting each as it starts. The snapshot is the audit; the
 * sampled steps are optional inputs (AuditInputs takes null), so one failed worker run
 * costs its checks, not the whole result.
 */
export function auditRun(c: CollectorApi, onStep: (steps: Step[], step: number) => void): AuditRun {
  let steps = STEPS;
  let current = 0;
  const step = (i: number) => {
    current = i;
    onStep(steps, i);
  };
  let stoppedAt: number | null = null;
  let stop: () => void = () => {};
  const stopSignal = new Promise<null>((resolve) => {
    stop = () => {
      if (stoppedAt !== null) return;
      stoppedAt = current;
      resolve(null);
      c.cancelLoad().catch(() => undefined);
    };
  });
  const skipped: string[] = [];
  // Raced against Stop: a stopped read settles on its own and is discarded, never thrown.
  const settled = <T,>(read: Promise<T>) => read.then((v) => ({ v }), (e: unknown) => ({ e }));
  const optional = async <T,>(i: number, read: () => Promise<T>): Promise<T | null> => {
    if (stoppedAt !== null) return null;
    step(i);
    const r = await Promise.race([settled(read()), stopSignal]);
    if (r === null) return null;
    if ('e' in r) {
      skipped.push(`${steps[i].label}: ${ipcErrorMessage(r.e)}`);
      return null;
    }
    return r.v;
  };
  // A worker that exits non-zero resolves as a failed run; its reason belongs in the Skipped box, not in silence.
  const load = async (i: number, kind: LoadKind, seconds: number): Promise<LoadRun | null> => {
    const r = await optional(i, () => c.load(kind, seconds));
    if (r && r.state === 'cancelled') return null;
    if (r && r.state !== 'done') {
      skipped.push(`${steps[i].label}: ${r.error ?? `the worker exited ${r.exitCode ?? 'without a code'}`}`);
      return null;
    }
    return r;
  };
  const interruption = (): AuditResult['interrupted'] => (stoppedAt === null ? null : { step: stoppedAt + 1, of: steps.length, label: steps[stoppedAt].label });

  const done = (async (): Promise<AuditResult> => {
    step(0);
    const first = await Promise.race([settled(c.snapshot()), stopSignal]);
    const nowIso = new Date().toISOString();
    if (first === null) return { at: nowIso, machine: '', findings: [], skipped: [], interrupted: interruption() };
    if ('e' in first) throw first.e;
    const snapshot = first.v;
    // The snapshot decides whether the fill-rate step is worth its seconds, so the list is per run.
    if (needsFillRateCrossCheck(snapshot)) steps = [...STEPS, FILL_RATE_STEP];
    // The timer probe runs beside the idle sample (both are the machine at rest); a failed read is 'unknown', never a skipped step.
    const timersRead = api ? api.about.timers(TIMER_TRACE_SECONDS).catch(() => null) : Promise.resolve(null);
    const hogs = await optional(1, () => c.hogs(5));
    const timers = stoppedAt === null ? await Promise.race([timersRead, stopSignal]) : null;
    const pcieUnderLoad = await load(2, 'light', 3);
    const thermalRamp = await load(3, 'heavy', 20);
    const cpuLoad = await load(4, 'cpu', 20);
    const fillRate = steps.length > STEPS.length ? await load(STEPS.length, 'fillrate', FILL_RATE_SECONDS) : null;
    const settings = loadSettings();
    const findings = runAudit({ snapshot, hogs, pcieUnderLoad, thermalRamp, cpuLoad, cpuPptW: settings.cpuPptW, curveOptimizer: settings, fillRate, nowIso, timers });
    // The names the Monitor shows (the user's own where set); " / " because a GPU title carries " · " of its own.
    const gpu = snapshot.gpus[0];
    return {
      at: nowIso,
      machine: [snapshot.cpu.name, gpu ? panelName(settings.panelNames, gpuKey(gpu), gpuTitle(gpu)) : 'no NVML GPU', panelName(settings.panelNames, BOARD_KEY, boardName(snapshot))].join(' / '),
      findings,
      skipped,
      interrupted: interruption()
    };
  })();
  return { done, stop: () => stop() };
}
