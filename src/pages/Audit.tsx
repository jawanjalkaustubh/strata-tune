import React, { useEffect, useMemo, useState } from 'react';
import { Play, Copy, Check, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { runAudit, rankTop, type AuditFinding } from '../analysis/audit';
import type { LoadKind, LoadRun } from '../collector-types';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { loadSettings } from '../settings';
import { navigate } from '../components/navigate';
import { gpuTitle } from '../components/monitor/vendors';
import { panelName } from '../components/monitor/Panel';
import { gpuKey } from '../components/monitor/GpuPanel';
import { BOARD_KEY, boardName } from '../components/monitor/BoardPanel';

const KEY = 'strata-tune.audit';
const TOP = 5;

interface Saved {
  at: string;
  machine: string;
  findings: AuditFinding[];
  /** Sampled steps that failed, with the reason; their checks read "unknown". */
  skipped: string[];
}

/** Expected seconds per step drive the progress line; the whole run is about 50 s. */
const STEPS = [
  { label: 'Reading the system snapshot', seconds: 2 },
  { label: 'Sampling idle background load', seconds: 5 },
  { label: 'PCIe link under a light load', seconds: 3 },
  { label: 'Thermal headroom under a heavy load', seconds: 20 },
  { label: 'CPU under an all-core load', seconds: 20 }
];

/** The CPU package-power rule judges against the limit the user sets on the Monitor page (phase1-polish item 2); the card links there. */
const LINKS_TO_CPU_PPT = 'cpu-package-power';
const TOTAL_SECONDS = STEPS.reduce((a, s) => a + s.seconds, 0);

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    return { ...s, skipped: s.skipped ?? [] };
  } catch {
    return null;
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode or full storage: the result still shows this session */
  }
}

const STATE: Record<AuditFinding['state'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' },
  warn: { label: 'Warn', cls: 'text-amber-400 border-amber-400/40 bg-amber-400/10' },
  bad: { label: 'Fix', cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10' },
  info: { label: 'Info', cls: 'text-slate-300 border-slate-500/40 bg-slate-500/10' },
  unknown: { label: 'Unknown', cls: 'text-slate-400 border-slate-500/60 border-dashed' }
};

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** The cost text says what the fault would cost; on a passing check it would read as a price of being fine, and when the detail already says it, it is said once. */
const showsCost = (f: AuditFinding) => (f.state === 'warn' || f.state === 'bad' || f.state === 'info') && !!f.costText && !plain(f.detail).includes(plain(f.costText));

function reportText(s: Saved): string {
  const lines = [`Strata Tune audit — ${new Date(s.at).toLocaleString()}`, s.machine, ''];
  rankTop(s.findings, s.findings.length).forEach((f, i) => {
    lines.push(`${i + 1}. [${STATE[f.state].label.toUpperCase()}] ${f.title}${showsCost(f) ? ` — ${f.costText}` : ''}`);
    if (f.detail) lines.push(`   ${f.detail}`);
    if (f.fix) lines.push(`   Fix${f.fixWhere === 'none' ? '' : ` (${f.fixWhere})`}: ${f.fix}`);
  });
  if (s.skipped.length) lines.push('', 'Skipped:', ...s.skipped.map((x) => `- ${x}`));
  return lines.join('\n');
}

const Card: React.FC<{ f: AuditFinding }> = ({ f }) => (
  <article className="rounded-md border border-studio-border bg-studio-panel px-3 py-2.5 space-y-1">
    <div className="flex items-start gap-2.5">
      <span className={`shrink-0 mt-0.5 inline-flex items-center h-5 px-1.5 rounded border label ${STATE[f.state].cls}`}>{STATE[f.state].label}</span>
      <h3 className="text-sm font-semibold text-studio-text leading-5">{f.title}</h3>
      {showsCost(f) && <span className="ml-auto shrink-0 max-w-[45%] text-right text-mini text-studio-muted leading-5">{f.costText}</span>}
    </div>
    {f.detail && <p className="text-mini text-studio-muted leading-relaxed">{f.detail}</p>}
    {f.fix && (
      <p className="text-mini text-studio-text leading-relaxed">
        {f.fixWhere !== 'none' && (
          <span className="inline-flex items-center h-4 px-1 mr-1.5 rounded border border-studio-border-light text-[10px] uppercase tracking-wider text-studio-muted align-middle">{f.fixWhere}</span>
        )}
        {f.fix}
      </p>
    )}
    {f.id === LINKS_TO_CPU_PPT && (
      <button className="btn -ml-2" onClick={() => navigate({ page: 'monitor', intent: 'cpu-ppt' })}>
        <Settings2 size={13} /> Set the CPU power limit
      </button>
    )}
  </article>
);

/** Home page (plan sections 8 and 17): the ranked findings, nothing changed on the machine. */
export const Audit: React.FC = () => {
  const status = useCollectorStatus();
  const [saved, setSaved] = useState<Saved | null>(loadSaved);
  const [running, setRunning] = useState<{ step: number; stepStartedAt: number } | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  const run = async () => {
    if (!api || running) return;
    const c = api.collector;
    setError('');
    setShowAll(false);
    const step = (i: number) => setRunning({ step: i, stepStartedAt: Date.now() });
    // The snapshot is the audit; the sampled steps are optional inputs (AuditInputs
    // takes null), so one failed worker run costs its checks, not the whole result.
    const skipped: string[] = [];
    const optional = async <T,>(i: number, read: () => Promise<T>): Promise<T | null> => {
      step(i);
      try {
        return await read();
      } catch (e) {
        skipped.push(`${STEPS[i].label}: ${ipcErrorMessage(e)}`);
        return null;
      }
    };
    // A worker that exits non-zero resolves as a failed run; its reason belongs in the Skipped box, not in silence.
    const load = async (i: number, kind: LoadKind, seconds: number): Promise<LoadRun | null> => {
      const r = await optional(i, () => c.load(kind, seconds));
      if (r && r.state !== 'done') {
        skipped.push(`${STEPS[i].label}: ${r.error ?? `the worker exited ${r.exitCode ?? 'without a code'}`}`);
        return null;
      }
      return r;
    };
    try {
      step(0);
      const snapshot = await c.snapshot();
      const hogs = await optional(1, () => c.hogs(5));
      const pcieUnderLoad = await load(2, 'light', 3);
      const thermalRamp = await load(3, 'heavy', 20);
      const cpuLoad = await load(4, 'cpu', 20);
      const nowIso = new Date().toISOString();
      const settings = loadSettings();
      const findings = runAudit({ snapshot, hogs, pcieUnderLoad, thermalRamp, cpuLoad, cpuPptW: settings.cpuPptW, nowIso });
      // The names the Monitor shows (the user's own where set); " / " because a GPU title carries " · " of its own.
      const gpu = snapshot.gpus[0];
      const result: Saved = {
        at: nowIso,
        machine: [snapshot.cpu.name, gpu ? panelName(settings.panelNames, gpuKey(gpu), gpuTitle(gpu)) : 'no NVML GPU', panelName(settings.panelNames, BOARD_KEY, boardName(snapshot))].join(' / '),
        findings,
        skipped
      };
      save(result);
      setSaved(result);
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setRunning(null);
    }
  };

  const copy = () => {
    if (!saved) return;
    navigator.clipboard
      .writeText(reportText(saved))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setError('Could not copy to the clipboard'));
  };

  const ranked = useMemo(() => (saved ? rankTop(saved.findings, saved.findings.length) : []), [saved]);
  const top = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP);

  const progress = running
    ? (STEPS.slice(0, running.step).reduce((a, s) => a + s.seconds, 0) + Math.min(Math.max((now - running.stepStartedAt) / 1000, 0), STEPS[running.step].seconds)) / TOTAL_SECONDS
    : 0;

  return (
    <div className="p-4 max-w-4xl w-full mx-auto space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold text-studio-text">Audit</h1>
        <CollectorStatusPill state={status} />
        <span className="flex-1" />
        {saved && (
          <button className="btn" onClick={copy} title="Plain text of every finding">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy report'}
          </button>
        )}
        <button className="btn btn-accent" disabled={status.status !== 'connected' || !!running} onClick={run}>
          <Play size={13} /> {saved ? 'Run again' : 'Run audit'}
        </button>
      </header>

      {running && (
        <div className="rounded-md border border-studio-border bg-studio-panel px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between gap-3 text-mini">
            <span className="text-studio-text">
              Step {running.step + 1} of {STEPS.length}: {STEPS[running.step].label}…
            </span>
            <span className="figure text-studio-subtle">{Math.round(progress * TOTAL_SECONDS)} / ~{TOTAL_SECONDS} s</span>
          </div>
          <div className="relative h-1.5 rounded-full bg-studio-border">
            <div className="absolute inset-y-0 left-0 rounded-full bg-studio-accent transition-[width] duration-200 ease-linear" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
        </div>
      )}

      {error && <div className="rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-mini px-3 py-2">Audit stopped: {error}</div>}

      {!saved && !running && (
        <div className="rounded-md border border-studio-border bg-studio-panel/50 p-5 space-y-2">
          <p className="text-mini text-studio-muted leading-relaxed">
            The audit reads your configuration and sensors, samples the machine idling, runs the GPU for a few seconds lightly and for twenty seconds flat out to
            measure the PCIe link and thermal headroom, then loads every CPU core for twenty seconds (about 50 seconds in all), and ranks what costs this PC
            performance, with a fix for each. It changes nothing.
          </p>
          {status.status !== 'connected' && <p className="text-micro text-studio-subtle">{status.message}</p>}
        </div>
      )}

      {saved && (
        <>
          <p className="text-micro text-studio-subtle">
            Last run {new Date(saved.at).toLocaleString()} · {saved.machine}
          </p>
          {saved.skipped.length > 0 && (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 text-amber-200 text-mini px-3 py-2 space-y-0.5">
              {saved.skipped.map((s) => (
                <p key={s}>Skipped {s}</p>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {top.map((f) => (
              <Card key={f.id} f={f} />
            ))}
          </div>
          {rest.length > 0 && (
            <button className="btn" onClick={() => setShowAll((s) => !s)}>
              {showAll ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {showAll ? 'Show top five' : `Show all ${ranked.length}`}
            </button>
          )}
          {showAll && (
            <div className="space-y-2">
              {rest.map((f) => (
                <Card key={f.id} f={f} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
