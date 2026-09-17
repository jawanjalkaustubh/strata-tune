import React from 'react';
import type { TuneRun } from '../../collector-types';
import { TONE, type Tone } from '../monitor/Pill';
import { axisOf, bisectOf, candidateTitle, notRising, on, signed, STAGE_NAME, tripped as trippedBy, VERDICT_TONE, type Axis } from './wire';

/** A round step for the axis labels: 25 / 50 / 100 / 250 MHz, whichever gives four to eight labels. */
function niceStep(span: number): number {
  for (const step of [10, 25, 50, 100, 250, 500, 1000]) if (span / step <= 8) return step;
  return 2000;
}

const PHASE: Record<TuneRun['phase'], string> = {
  reference: 'reference at the baseline',
  coarse: 'coarse ladder',
  bisect: 'bisecting',
  sweep: 'bandwidth sweep',
  validate: 'validating',
  restore: 'restoring the baseline'
};

/**
 * The run's candidates as ticks on one axis (plan 16): emerald held, red tripped (the
 * ladder stage that caught it is named in the header, where it cannot cover a tick),
 * amber invalid (a throttle bit during the heavy pattern), the bisect window as a band,
 * the rung under test hollow. Plain DOM positioned in percent, so it costs nothing at
 * 2 Hz and needs no canvas (plan 17c). Without a run there is nothing to draw but the
 * sentence that says so.
 */
export const Ladder: React.FC<{ run: TuneRun | null }> = ({ run }) => {
  if (!run) return <p className="text-mini text-studio-muted px-1">No candidates yet. A hunt raises the offset step by step and marks each rung here.</p>;
  const axis: Axis = axisOf(run);
  const steps = run.candidates;
  const current = run.state === 'running' ? run.candidate : null;
  const bisect = bisectOf(run, axis);
  const values = steps.map((c) => on(c.deltas, axis));
  if (current) values.push(on(current, axis));
  if (bisect) values.push(bisect.lo, bisect.hi);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo;
  const pad = Math.max(niceStep(span) / 2, span * 0.08, 5);
  const min = lo - pad;
  const max = hi + pad;
  const pct = (v: number) => `${(((v - min) / (max - min)) * 100).toFixed(2)}%`;
  const step = niceStep(max - min);
  const labels: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) labels.push(v);
  const tripped = steps.find((c) => trippedBy(run, c));
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="label">
          {axis} ladder · MHz offset
          <span className="text-studio-subtle ml-3">{run.state === 'running' ? PHASE[run.phase] : `${run.kind} run ${run.state}`}</span>
          {tripped && (
            <span className="text-rose-300 ml-3">
              tripped at {signed(on(tripped.deltas, axis))} · {tripped.stage ? `stage ${tripped.stage} · ${STAGE_NAME[tripped.stage] ?? 'unknown'}` : 'bandwidth stopped rising'}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3 text-micro text-studio-subtle">
          <Key tone="ok" text="stable" /> <Key tone="bad" text="unstable" /> <Key tone="warn" text="invalid" />
          {bisect && <Key tone="idle" text="bisect window" band />}
        </span>
      </div>
      <div className="relative h-11 mx-1">
        <div className="absolute left-0 right-0 top-3 h-1.5 rounded-full bg-studio-border" />
        {bisect && (
          <div className="absolute top-2 h-3.5 rounded-sm bg-slate-400/20 border-x border-slate-300/60" style={{ left: pct(bisect.lo), width: `calc(${pct(bisect.hi)} - ${pct(bisect.lo)})` }} title={`Bisecting between ${signed(bisect.lo)} and ${signed(bisect.hi)} MHz`} />
        )}
        <div className="absolute top-1.5 w-px h-4 bg-slate-400/70" style={{ left: pct(0) }} title="Baseline" />
        {labels.map((v) => (
          <span key={v} className="absolute top-7 -translate-x-1/2 figure text-[10px] text-studio-subtle" style={{ left: pct(v) }}>
            {v > 0 ? `+${v}` : v}
          </span>
        ))}
        {steps.map((c, i) => (
          <span key={i} className={`absolute top-1 h-5 w-1 rounded-sm -translate-x-1/2 ${TONE[notRising(run, c) ? 'bad' : VERDICT_TONE[c.verdict]].fill}`} style={{ left: pct(on(c.deltas, axis)) }} title={candidateTitle(c, axis)} aria-label={candidateTitle(c, axis)} />
        ))}
        {current && (
          <span
            className="absolute top-1 h-5 w-1 rounded-sm -translate-x-1/2 border-2 bg-transparent"
            style={{ left: pct(on(current, axis)), borderColor: TONE.info.hex }}
            title={`${axis} ${signed(on(current, axis))} MHz: under test (${run.pattern ?? 'starting'})`}
            aria-label={`${axis} ${signed(on(current, axis))} MHz: under test`}
          />
        )}
      </div>
    </div>
  );
};

const Key: React.FC<{ tone: Tone; text: string; band?: boolean }> = ({ tone, text, band }) => (
  <span className="inline-flex items-center gap-1">
    <span className={`inline-block ${band ? 'w-3 h-2 bg-slate-400/20 border-x border-slate-300/60' : `w-1 h-2.5 rounded-sm ${TONE[tone].fill}`}`} /> {text}
  </span>
);
