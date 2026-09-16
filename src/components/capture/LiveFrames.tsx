import React, { useEffect, useState } from 'react';
import type { CaptureFrames } from '../../api';

const W = 480;
const H = 40;
/** The scale never drops below one stutter's worth, so a calm capture reads as a low flat line rather than noise filling the box. */
const FLOOR_MS = 50;
const STUTTER_MS = 50;

/** One path through the last two seconds of frame times; no animation, redrawn at 2 Hz (plan 17). */
const Spark: React.FC<{ ms: number[] }> = ({ ms }) => {
  const max = Math.max(FLOOR_MS, ...ms);
  const n = ms.length;
  const y = (v: number) => H - 1 - (Math.min(v, max) / max) * (H - 2);
  const d = n > 1 ? ms.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (n - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`).join('') : '';
  const stutterY = y(STUTTER_MS);
  return (
    <svg className="block w-full h-10" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1={0} x2={W} y1={stutterY} y2={stutterY} stroke="#f43f5e" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke="#10b981" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

/** Whole seconds since the capture started, ticking once a second on the wall clock. */
function useElapsed(startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

/** Elapsed time, frame count, the rate over the last two seconds, and the sparkline, while a capture runs. */
export const LiveFrames: React.FC<{ frames: CaptureFrames; startedAt: string | null }> = ({ frames, startedAt }) => {
  const elapsed = useElapsed(startedAt);
  const total = frames.recentMs.reduce((a, b) => a + b, 0);
  const fps = frames.recentMs.length > 1 && total > 0 ? (1000 * frames.recentMs.length) / total : null;
  const worst = frames.recentMs.length ? Math.max(...frames.recentMs) : null;
  return (
    <section className="rounded-md border border-studio-border bg-studio-panel p-3 space-y-2 min-w-0">
      <div className="flex items-baseline gap-4 flex-wrap">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="label">Elapsed</span>
          <span className="figure text-[13px] text-studio-text">{clock(elapsed)}</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="label">Frames</span>
          <span className="figure text-[13px] text-studio-text">{frames.count.toLocaleString()}</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="label">Rate</span>
          <span className="figure text-[13px] text-studio-text">{fps === null ? '—' : `${fps.toFixed(0)} fps`}</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="label">Worst 2 s</span>
          <span className={`figure text-[13px] ${worst !== null && worst > STUTTER_MS ? 'text-rose-400' : 'text-studio-text'}`}>{worst === null ? '—' : `${worst.toFixed(1)} ms`}</span>
        </span>
        <span className="label ml-auto">last 2 s · red line 50 ms</span>
      </div>
      <Spark ms={frames.recentMs} />
    </section>
  );
};
