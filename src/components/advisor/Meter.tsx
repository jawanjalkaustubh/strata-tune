import React from 'react';
import { TONE, type Tone } from '../monitor/Pill';

interface Props {
  value: number;
  max: number;
  /** Drawn as a tick, never a second bar (plan 17a). */
  tick?: number;
  tickLabel?: string;
  tone: Tone;
  title?: string;
}

/** Thin rounded bar with a limit tick; the row layout around it belongs to the caller. */
export const Meter: React.FC<Props> = ({ value, max, tick, tickLabel, tone, title }) => {
  const pct = (v: number) => `${(max > 0 ? Math.min(Math.max(v / max, 0), 1) * 100 : 0).toFixed(2)}%`;
  return (
    <div className="relative h-1.5 rounded-full bg-studio-border" title={title}>
      <div className={`absolute inset-y-0 left-0 rounded-full ${TONE[tone].fill} transition-[width] duration-200 ease-linear`} style={{ width: pct(value) }} />
      {tick !== undefined && <div className="absolute -top-1 h-3.5 w-px bg-slate-300/70" style={{ left: pct(tick) }} title={tickLabel} />}
    </div>
  );
};
