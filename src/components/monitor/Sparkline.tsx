import React from 'react';

interface Props {
  /** Oldest first; undefined breaks the line (no reading, or the window not yet full). */
  points: (number | undefined)[];
  min: number;
  max: number;
  className?: string;
}

const W = 120;
const H = 16;
/** Four seconds at 2 Hz: a shorter history is a dot, not a trend, so it stays blank until then. */
const MIN_POINTS = 8;

/**
 * 60 s history under a bar, on the bar's own scale so a spike reads against
 * the limit rather than against itself. One path, no animation. The box is
 * always laid out so the row does not jump when the line first appears.
 */
export const Sparkline: React.FC<Props> = ({ points, min, max, className = '' }) => {
  const n = points.length;
  const span = max - min;
  const have = points.filter((v) => v !== undefined && Number.isFinite(v)).length;
  let d = '';
  let pen = false;
  if (n > 1 && span > 0 && have >= MIN_POINTS) {
    points.forEach((v, i) => {
      if (v === undefined || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      const x = (i / (n - 1)) * W;
      const y = H - 1 - ((Math.min(Math.max(v, min), max) - min) / span) * (H - 2);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true;
    });
  }
  return (
    <svg className={`block w-full h-4 ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeOpacity={0.7} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};
