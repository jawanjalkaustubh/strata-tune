import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Copy, Check, ChevronDown, ChevronUp, Settings2, Square } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { rankTop, type AuditFinding } from '../analysis/audit';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { navigate } from '../components/navigate';
import { auditRun, STEPS, totalSeconds, type AuditResult, type AuditRun, type Step } from '../components/audit/run';
import type { CollectorApi } from '../api';

const KEY = 'strata-tune.audit';
const TOP = 5;

/** The CPU package-power rule judges against the limit the user sets on the Monitor page (phase1-polish item 2); the card links there. */
const LINKS_TO_CPU_PPT = 'cpu-package-power';

function loadSaved(): AuditResult | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AuditResult;
    return { ...s, skipped: s.skipped ?? [] };
  } catch {
    return null;
  }
}

function save(s: AuditResult) {
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

/** An interrupted run shows the checks that completed; the ones its missing steps would have fed read unknown and are counted, not listed. */
export const visibleFindings = (s: AuditResult): AuditFinding[] => rankTop(s.findings, s.findings.length).filter((f) => !s.interrupted || f.state !== 'unknown');

export function reportText(s: AuditResult): string {
  const lines = [`Strata Tune audit — ${new Date(s.at).toLocaleString()}`, s.machine, ''];
  visibleFindings(s).forEach((f, i) => {
    lines.push(`${i + 1}. [${STATE[f.state].label.toUpperCase()}] ${f.title}${showsCost(f) ? ` — ${f.costText}` : ''}`);
    if (f.detail) lines.push(`   ${f.detail}`);
    if (f.fix) lines.push(`   Fix${f.fixWhere === 'none' ? '' : ` (${f.fixWhere})`}: ${f.fix}`);
  });
  if (s.skipped.length) lines.push('', 'Skipped:', ...s.skipped.map((x) => `- ${x}`));
  if (s.interrupted) lines.push('', `Interrupted at step ${s.interrupted.step} of ${s.interrupted.of} (${s.interrupted.label}); the steps after it did not run.`);
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

interface Running {
  steps: Step[];
  step: number;
  stepStartedAt: number;
}

/**
 * The run in flight lives here, outside the panel, because the Tune page unmounts when the
 * user looks at the Monitor mid-audit: on the first laptop (2026-09-19) the run went on
 * invisibly, the panel came back with Run enabled, and a second audit's three load steps
 * were refused with 409 by the first's. A panel that mounts while a run is live re-attaches
 * to it: the same progress line, the same Stop, and its result when it lands.
 */
interface LiveRun {
  run: AuditRun;
  running: Running;
  /** Settles with the result or the error, once; never rejects unhandled. */
  outcome: Promise<{ result: AuditResult } | { error: string }>;
}

let live: LiveRun | null = null;
const watchers = new Set<(running: Running | null) => void>();

function startLive(c: CollectorApi): LiveRun {
  const first: Running = { steps: STEPS, step: 0, stepStartedAt: Date.now() };
  const run = auditRun(c, (steps, step) => {
    if (!live) return;
    live.running = { steps, step, stepStartedAt: Date.now() };
    for (const w of watchers) w(live.running);
  });
  const outcome = run.done
    .then((result) => {
      // A stopped run is shown, not kept: the last complete audit stays the one to come back to.
      if (!result.interrupted) save(result);
      return { result };
    })
    .catch((e: unknown) => ({ error: ipcErrorMessage(e) }))
    .finally(() => {
      live = null;
      for (const w of watchers) w(null);
    });
  live = { run, running: first, outcome };
  return live;
}

/** The progress line with its Stop beside it from the first second (plan section 17c); `now` paces the bar. */
export const AuditProgress: React.FC<{ running: Running; now: number; onStop: () => void }> = ({ running, now, onStop }) => {
  const total = totalSeconds(running.steps);
  const progress = (totalSeconds(running.steps.slice(0, running.step)) + Math.min(Math.max((now - running.stepStartedAt) / 1000, 0), running.steps[running.step].seconds)) / total;
  return (
    <div className="rounded-md border border-studio-border bg-studio-panel px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-3 text-mini">
        <span className="text-studio-text min-w-0">
          Step {running.step + 1} of {running.steps.length}: {running.steps[running.step].label}…
        </span>
        <span className="flex-1" />
        <span className="figure text-studio-subtle whitespace-nowrap">
          {Math.round(progress * total)} / ~{total} s
        </span>
        <button className="btn bg-rose-500/15 text-rose-300 hover:text-rose-200" onClick={onStop} title="Stops the step in flight and skips the rest (Escape)">
          <Square size={12} /> Stop
        </button>
      </div>
      <div className="relative h-1.5 rounded-full bg-studio-border">
        <div className="absolute inset-y-0 left-0 rounded-full bg-studio-accent transition-[width] duration-200 ease-linear" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
};

interface ResultProps {
  saved: AuditResult;
  /** Run again is offered in the interrupted banner; disabled while the collector is away or a run is going. */
  canRun: boolean;
  onRun: () => void;
}

/** The result: the interrupted banner when Stop cut the run short, the skipped steps, the ranked cards with the rest behind "Show all". */
export const AuditResultView: React.FC<ResultProps> = ({ saved, canRun, onRun }) => {
  const [showAll, setShowAll] = useState(false);
  const ranked = useMemo(() => visibleFindings(saved), [saved]);
  const unknownCount = saved.findings.length - ranked.length;
  const top = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP);
  return (
    <>
      {saved.interrupted && (
        <div className="rounded-md border border-amber-400/40 bg-amber-400/10 text-amber-200 text-mini px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex-1 min-w-0">
            Interrupted at step {saved.interrupted.step} of {saved.interrupted.of} ({saved.interrupted.label}).{' '}
            {ranked.length === 0 ? 'No check completed.' : `The ${ranked.length} check${ranked.length === 1 ? '' : 's'} that completed ${ranked.length === 1 ? 'is' : 'are'} below`}
            {ranked.length > 0 && unknownCount > 0 && `; ${unknownCount} read unknown without the steps that did not run`}
            {ranked.length > 0 && '.'}
          </span>
          <button className="btn" disabled={!canRun} onClick={onRun}>
            <Play size={13} /> Run again
          </button>
        </div>
      )}
      {saved.machine && (
        <p className="text-micro text-studio-subtle">
          {saved.interrupted ? 'Stopped' : 'Last run'} {new Date(saved.at).toLocaleString()} · {saved.machine}
        </p>
      )}
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
  );
};

/**
 * The audit (plan sections 8 and 17): the ranked findings, nothing changed on the machine.
 * Self-contained: it owns its run, its Stop and its result. The Tune page carries it as its
 * top half (user, 2026-09-16: the audit belongs in the Tune section) and only adds the padding.
 */
export const AuditPanel: React.FC = () => {
  const status = useCollectorStatus();
  const [saved, setSaved] = useState<AuditResult | null>(loadSaved);
  const [running, setRunning] = useState<Running | null>(() => live?.running ?? null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // Stop for the run in flight (plan section 17c); set by run(), cleared when it ends.
  const stopRef = useRef<(() => void) | null>(live?.run.stop ?? null);

  // Follow the module's run: its steps while it goes, its result when it lands, whether this panel started it or found it running.
  const attach = (l: LiveRun) => {
    stopRef.current = l.run.stop;
    void l.outcome.then((o) => {
      if ('error' in o) setError(o.error);
      else setSaved(o.result);
      stopRef.current = null;
    });
  };
  useEffect(() => {
    const w = (r: Running | null) => setRunning(r);
    watchers.add(w);
    if (live) attach(live);
    return () => {
      watchers.delete(w);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  // Escape stops the run while it is on screen, the same as the button.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running]);

  const run = () => {
    // One run at a time across mounts: a panel that comes back mid-run shows that run, never starts another.
    if (!api || running || live) return;
    setError('');
    const l = startLive(api.collector);
    setRunning(l.running);
    attach(l);
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

  const canRun = status.status === 'connected' && !running;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold text-studio-text">Audit</h1>
        <CollectorStatusPill state={status} />
        <span className="flex-1" />
        {saved && (
          <button className="btn" onClick={copy} title="Plain text of every finding">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy report'}
          </button>
        )}
        <button className="btn btn-accent" disabled={!canRun} onClick={run}>
          <Play size={13} /> {saved ? 'Run again' : 'Run audit'}
        </button>
      </header>

      {running && <AuditProgress running={running} now={now} onStop={() => stopRef.current?.()} />}

      {error && <div className="rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-mini px-3 py-2">Audit stopped: {error}</div>}

      {!saved && !running && (
        <div className="rounded-md border border-studio-border bg-studio-panel/50 p-5 space-y-2">
          <p className="text-mini text-studio-muted leading-relaxed">
            The audit reads your configuration and sensors, samples the machine idling, runs the GPU for a few seconds lightly and for twenty seconds flat out to
            measure the PCIe link and thermal headroom, then loads every CPU core for twenty seconds (about {totalSeconds(STEPS)} seconds in all), and ranks what costs
            this PC performance, with a fix for each. It changes nothing.
          </p>
          {status.status !== 'connected' && <p className="text-micro text-studio-subtle">{status.message}</p>}
        </div>
      )}

      {saved && <AuditResultView key={saved.at} saved={saved} canRun={canRun} onRun={run} />}
    </div>
  );
};
