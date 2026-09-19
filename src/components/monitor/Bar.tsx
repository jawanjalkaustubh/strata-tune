import React from 'react';
import { Sparkline } from './Sparkline';
import { TONE, type Tone } from './Pill';

export interface BarProps {
  label: string;
  /** null or undefined collapses the row: an absent sensor is not a zero (plan 17a). */
  value: number | null | undefined;
  format: (v: number) => string;
  min?: number;
  max: number;
  /** The limit is a tick, never a second bar. */
  limit?: number;
  limitLabel?: string;
  /** A second, quieter tick (the GPU's maximum power limit, the boost seen this session). */
  mark?: number;
  markLabel?: string;
  /** Tolerance band drawn as a lighter region. */
  band?: [number, number];
  tone: Tone;
  history?: (number | undefined)[];
  /** Small text after the value, e.g. "of 230 W"; a node when part of it is a control (the Package bar's stock tag). */
  sub?: React.ReactNode;
  /** Something to say about the value ("no tacho at 100 %"): its own muted line under the figure, wrapping, never widening the column past the note width. */
  note?: string;
}

/** Label · track · figure columns shared by every bar-shaped row (index.css .bar-row: a fixed figure column so tracks in a column line up, compact under 360 px). */
export const BAR_GRID = 'bar-row';

/** Near the limit amber, at it red; nothing to compare against stays as given. */
export function toneByLimit(value: number, limit: number | undefined, warnAt = 0.9, fallback: Tone = 'ok'): Tone {
  if (limit === undefined || limit <= 0) return fallback;
  if (value >= limit) return 'bad';
  if (value >= limit * warnAt) return 'warn';
  return 'ok';
}

export function toneByThresholds(value: number, warn: number, bad: number): Tone {
  return value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';
}

export function toneByBand(value: number, band: [number, number]): Tone {
  return value < band[0] || value > band[1] ? 'warn' : 'ok';
}

/**
 * Thin rounded bar, tabular figure, optional sparkline; width is the only thing
 * that transitions. The limit tick is quiet slate until the value reaches it:
 * red is reserved for state, so an idle panel shows no red marks (plan 17a).
 */
export const Bar: React.FC<BarProps> = (p) => {
  if (p.value === null || p.value === undefined || !Number.isFinite(p.value)) return null;
  const min = p.min ?? 0;
  const span = p.max - min;
  const pct = (v: number) => `${(span > 0 ? Math.min(Math.max((v - min) / span, 0), 1) * 100 : 0).toFixed(2)}%`;
  const t = TONE[p.tone];
  return (
    <div className={BAR_GRID}>
      <span className="label truncate" title={p.label}>
        {p.label}
      </span>
      <div className="min-w-0 py-1">
        <div className="relative h-1.5 rounded-full bg-studio-border">
          {p.band && <div className="absolute inset-y-0 rounded-full bg-white/10" style={{ left: pct(p.band[0]), width: `calc(${pct(p.band[1])} - ${pct(p.band[0])})` }} />}
          <div className={`absolute inset-y-0 left-0 rounded-full ${t.fill} transition-[width] duration-200 ease-linear`} style={{ width: pct(p.value) }} />
          {p.mark !== undefined && <div className="absolute -top-1 h-3.5 w-px bg-slate-300/60" style={{ left: pct(p.mark) }} title={p.markLabel} />}
          {p.limit !== undefined && <div className={`absolute -top-1 h-3.5 w-px ${p.tone === 'bad' ? 'bg-rose-400' : 'bg-slate-300/80'}`} style={{ left: pct(p.limit) }} title={p.limitLabel} />}
        </div>
        {p.history && <Sparkline className={`${t.text} mt-1`} points={p.history} min={min} max={p.max} />}
      </div>
      <span className={`figure text-right text-[12px] whitespace-nowrap ${t.text}`}>
        {p.format(p.value)}
        {p.sub && <span className="bar-sub text-studio-subtle text-[10px]">{p.sub}</span>}
        {p.note && <span className="block max-w-[9rem] ml-auto whitespace-normal leading-tight text-studio-subtle text-[10px]">{p.note}</span>}
      </span>
    </div>
  );
};
