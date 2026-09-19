import React, { useEffect, useRef, useState } from 'react';
import { Play, Save, Square } from 'lucide-react';
import { api, ipcErrorMessage } from '../../api';
import type { HogsResult, LoadRun, StaticSnapshot } from '../../collector-types';
import { systemScore, type Score, type SmoothnessInput } from '../../analysis/score';
import type { AuditFinding } from '../../analysis/audit';
import { lookupGpu } from '../../analysis/hardware-tables';
import { ShareCard, toPng } from '../../report/ShareCard';
import { analyse } from '../capture/toReport';
import { cachedSnapshot } from '../monitor/cache';
import { gpuTitle } from '../monitor/vendors';

interface Props {
  connected: boolean;
  version: string;
}

/** Plan section 14: the fixed workload is the worker's heavy pattern for 60 s. */
export const VALIDATION_SECONDS = 60;
/** The idle sample before the run: a process busier than this invalidates the score (another program was busy). */
const BACKGROUND_BUSY_PCT = 5;
const IDLE_SAMPLE_SECONDS = 3;
/** The card is "still warming" when its temperature over the last ten seconds is this much above the ten before: not at steady state. */
const DRIFT_C = 3;
const DRIFT_WINDOW_S = 10;
/** The Audit page's saved result (src/pages/Audit.tsx): its findings are the Configuration subscore. */
const AUDIT_KEY = 'strata-tune.audit';
const BENCH_EXE = /strata-tune-bench/i;

type Phase = 'idle' | 'checking' | 'running' | 'scoring';

interface Result {
  score: Score;
  hardware: string;
  date: string;
  notes: string[];
}

function savedFindings(): AuditFinding[] | null {
  try {
    const raw = localStorage.getItem(AUDIT_KEY);
    const s = raw ? (JSON.parse(raw) as { findings?: AuditFinding[] }) : null;
    return s?.findings?.length ? s.findings : null;
  } catch {
    return null;
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** True when the temperature was still climbing at the end of the run, so the steady window was not steady. */
export function thermalDrift(run: LoadRun): boolean {
  if (run.qpcEnd === null || run.qpcEnd <= run.qpcStart || run.gpuSamples.length < 4) return false;
  const span = run.qpcEnd - run.qpcStart;
  const t = (qpc: number) => ((qpc - run.qpcStart) / span) * run.seconds;
  const last = run.gpuSamples.filter((s) => t(s.qpc) >= run.seconds - DRIFT_WINDOW_S).map((s) => s.temperatureC);
  const before = run.gpuSamples.filter((s) => t(s.qpc) >= run.seconds - 2 * DRIFT_WINDOW_S && t(s.qpc) < run.seconds - DRIFT_WINDOW_S).map((s) => s.temperatureC);
  return last.length > 0 && before.length > 0 && mean(last) - mean(before) > DRIFT_C;
}

export const backgroundBusy = (hogs: HogsResult | null) => (hogs ? hogs.processes.filter((p) => p.cpuPercent > BACKGROUND_BUSY_PCT).map((p) => p.name) : []);

/**
 * About → Validation (plan 14): the fixed 60 s heavy load, the score from it plus the last
 * audit and the last game capture, and the share card as a PNG. Nothing here changes a
 * setting; a busy background process or a card still warming marks the run invalid rather
 * than scoring it, and any driver reset caps the total.
 */
export const ValidationTool: React.FC<Props> = ({ connected, version }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [now, setNow] = useState(0);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase !== 'running') return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [phase]);

  const run = async () => {
    if (!api || phase !== 'idle') return;
    const c = api.collector;
    setError('');
    setSaved('');
    setResult(null);
    const notes: string[] = [];
    try {
      setPhase('checking');
      const snapshot: StaticSnapshot = await cachedSnapshot();
      const hogs = await c.hogs(IDLE_SAMPLE_SECONDS).catch(() => null);
      const busy = backgroundBusy(hogs);
      setPhase('running');
      setStartedAt(Date.now());
      const load = await c.load('heavy', VALIDATION_SECONDS);
      if (load.state === 'cancelled') {
        setError('Validation stopped; nothing was scored.');
        return;
      }
      if (load.state !== 'done') notes.push(`The load run ${load.state}: ${load.error ?? `worker exit ${load.exitCode ?? '?'}`}.`);
      setPhase('scoring');
      const findings = savedFindings();
      if (!findings) notes.push('No audit result saved: Configuration is not measured. Run the audit first.');
      const gpu = snapshot.gpus[0];
      const spec = gpu ? lookupGpu(gpu.name, gpu.vram.totalMiB) : null;
      if (!spec) notes.push('No spec row for this GPU: Efficiency is not measured.');
      const smoothness = await latestSmoothness(version).catch(() => null);
      if (!smoothness) notes.push('No game capture saved: Smoothness is not measured (Capture a game, then validate again).');
      const score = systemScore({
        findings,
        run: load,
        spec: spec ? { boostMhz: spec.boostMhz, tdpW: spec.tdpW } : null,
        smoothness,
        stability: { tdr: load.exitCode === 10, computeError: load.state === 'failed' && load.exitCode !== 10 },
        // The CPU is not observed during a GPU run, so 'throttled' (the CPU held back) cannot trip here; the other two are measured.
        validity: { backgroundLoad: busy.length > 0, throttled: false, thermalDrift: thermalDrift(load) }
      });
      if (busy.length) notes.push(`Busy before the run: ${busy.join(', ')}.`);
      setResult({ score, hardware: `${snapshot.cpu.name.trim()} · ${gpu ? gpuTitle(gpu) : 'no NVML GPU'}`, date: new Date().toISOString().slice(0, 10), notes });
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setPhase('idle');
    }
  };

  const stop = () => api?.collector.cancelLoad?.().catch(() => undefined);

  const savePng = async () => {
    const svg = card.current?.querySelector('svg');
    if (!svg || !api) return;
    try {
      const blob = await toPng(svg);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      const path = await api.about.saveFile({ title: 'Save share card', defaultName: `strata-tune-score-${result?.date ?? 'card'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], base64 });
      if (path) setSaved(`Saved ${path}`);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  };

  if (!connected) return <p className="text-mini text-studio-muted">Validation runs the collector's heavy load; it is not connected.</p>;

  return (
    <div className="space-y-3">
      <p className="text-mini text-studio-muted leading-relaxed">
        A fixed {VALIDATION_SECONDS} s heavy GPU load, scored against the spec sheet: Thermals from the sustained clock and throttle bits, Efficiency from clock per watt,
        Configuration from the last audit, Smoothness from the last game capture. A busy background program or a card still warming marks the run invalid instead of
        scoring it; a driver reset caps the total at 60. Close games and renders first.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'idle' ? (
          <button className="btn btn-accent" onClick={run}>
            <Play size={13} /> {result ? 'Run again' : `Run validation (${VALIDATION_SECONDS} s)`}
          </button>
        ) : (
          <>
            <span className="text-mini text-studio-text">
              {phase === 'checking' ? 'Sampling the idle machine…' : phase === 'running' ? `Heavy load: ${Math.min(VALIDATION_SECONDS, Math.max(0, Math.round((now - startedAt) / 1000)))} / ${VALIDATION_SECONDS} s` : 'Scoring…'}
            </span>
            {phase === 'running' && (
              <button className="btn" onClick={stop}>
                <Square size={12} /> Stop
              </button>
            )}
          </>
        )}
        {result && (
          <button className="btn" onClick={savePng}>
            <Save size={13} /> Save PNG
          </button>
        )}
        {saved && <span className="text-micro text-studio-subtle break-all">{saved}</span>}
      </div>
      {error && <p className="text-micro text-rose-300">{error}</p>}
      {result && (
        <>
          <div ref={card} className="rounded-md overflow-hidden border border-studio-border [&>svg]:w-full [&>svg]:h-auto">
            <ShareCard score={result.score} hardware={result.hardware} date={result.date} />
          </div>
          {result.notes.length > 0 && (
            <ul className="text-micro text-studio-subtle space-y-0.5">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

/** The last game capture's stutter measurements (bench sessions are scripted stutters, not the machine's); null when none is saved. */
async function latestSmoothness(version: string): Promise<SmoothnessInput | null> {
  if (!api) return null;
  const sessions = (await api.sessions.list()).filter((s) => !BENCH_EXE.test(s.exe));
  if (sessions.length === 0) return null;
  const latest = sessions.reduce((a, b) => (Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a));
  const { report } = analyse(await api.sessions.load(latest.id), version);
  return { measurements: report.report.measurements, causes: report.report.causes, durationS: report.session.durationS };
}
