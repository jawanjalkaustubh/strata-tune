import React, { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { api, ipcErrorMessage } from '../../api';
import type { Timers } from '../../collector-types';

interface Props {
  connected: boolean;
}

/** powercfg watches for this long, then analyses; about ten seconds in all on the dev box. */
export const TRACE_SECONDS = 5;

const ms = (v: number | null) => (v === null ? 'unknown' : `${v} ms`);

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1 border-b border-studio-border/60 last:border-b-0">
    <span className="label leading-5">{label}</span>
    <span className="text-mini text-studio-text leading-5 break-words">{children}</span>
  </div>
);

/**
 * About → Timers (plan 17): the Windows timer resolution and the clock behind
 * QueryPerformanceCounter, read by the collector, and on request the processes holding
 * the timer raised. What is and is not knowable is said on the page: the resolution is a
 * kernel fact; the requester needs powercfg's elevated trace; the boot setting behind the
 * counter (useplatformclock) is inferred from its frequency, not read.
 */
export const TimersTool: React.FC<Props> = ({ connected }) => {
  const [timers, setTimers] = useState<Timers | null>(null);
  const [busy, setBusy] = useState<'read' | 'trace' | null>(null);
  const [error, setError] = useState('');

  const read = (trace: boolean) => {
    if (!api || !connected) return;
    setBusy(trace ? 'trace' : 'read');
    setError('');
    api.about
      .timers(trace ? TRACE_SECONDS : undefined)
      .then((t) => setTimers((prev) => (trace || !prev ? t : { ...t, requesters: prev.requesters, requestersNote: prev.requestersNote })))
      .catch((e) => setError(ipcErrorMessage(e)))
      .finally(() => setBusy(null));
  };

  useEffect(() => {
    if (!api || !connected) return;
    let live = true;
    setBusy('read');
    api.about
      .timers()
      .then((t) => live && setTimers(t))
      .catch((e) => live && setError(ipcErrorMessage(e)))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [connected]);

  const raised = timers && timers.currentMs !== null && timers.coarsestMs !== null && timers.currentMs < timers.coarsestMs;
  const foreign = timers?.requesters?.filter((r) => !r.own) ?? [];
  const own = timers?.requesters?.filter((r) => r.own) ?? [];

  return (
    <div className="space-y-3">
      {!connected && <p className="text-mini text-studio-muted">The timer probe runs in the collector; it is not connected.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => read(false)} disabled={busy !== null || !connected}>
          <RefreshCw size={13} className={busy === 'read' ? 'animate-spin' : ''} /> Read again
        </button>
        <button className="btn btn-accent" onClick={() => read(true)} disabled={busy !== null || !raised || !connected} title={raised ? `powercfg's energy trace, about ${TRACE_SECONDS + 5} s` : 'Nothing holds the timer raised: there is nobody to name'}>
          <Search size={13} /> {busy === 'trace' ? `Tracing (about ${TRACE_SECONDS + 5} s)…` : 'Find who holds it'}
        </button>
      </div>
      {error && <p className="text-micro text-rose-300">{error}</p>}
      {timers && (
        <div>
          <Fact label="Timer resolution">
            <span className="figure">{ms(timers.currentMs)}</span> now · finest {ms(timers.finestMs)} · default {ms(timers.coarsestMs)}
          </Fact>
          <Fact label="Performance counter">
            <span className="figure">{timers.qpcFrequency.toLocaleString()} Hz</span> · {timers.qpcSource}
          </Fact>
          <Fact label="Clock source">{timers.qpcNote}</Fact>
          <Fact label="Holding the timer">
            {timers.requesters === null ? (
              raised ? (
                'not traced yet: a process holds the timer raised, and the trace names it'
              ) : (
                'nobody: the timer is at the platform default'
              )
            ) : (
              <>
                {foreign.length === 0 && own.length === 0 && (timers.requestersNote ?? 'nobody')}
                {foreign.map((r) => (
                  <div key={r.pid}>
                    <span className="figure">{r.periodMs ?? '?'} ms</span> · {r.name} (pid {r.pid}){r.path ? <span className="text-studio-subtle"> · {r.path}</span> : null}
                  </div>
                ))}
                {own.map((r) => (
                  <div key={r.pid} className="text-studio-subtle">
                    <span className="figure">{r.periodMs ?? '?'} ms</span> · {r.name} (pid {r.pid}) · Strata Tune itself; Chromium raises the timer while the window animates
                  </div>
                ))}
              </>
            )}
          </Fact>
        </div>
      )}
      <div className="text-micro text-studio-subtle leading-relaxed space-y-1">
        <p>
          Windows ticks its scheduler at the default 15.625 ms; games and audio apps ask for 0.5 to 1 ms while they run, which smooths frame pacing and costs a little
          idle power. NtQueryTimerResolution reports what the kernel is using; which process asked is not a public API, so the trace is powercfg's energy report, run
          by the elevated collector for {TRACE_SECONDS} s.
        </p>
        <p>
          The counter's clock is inferred from its frequency (10 MHz is the TSC, 14.318 MHz the HPET, 3.58 MHz the ACPI timer), because the boot setting that picks it
          (bcdedit useplatformclock / useplatformtick) is not read by this app.
        </p>
      </div>
    </div>
  );
};
