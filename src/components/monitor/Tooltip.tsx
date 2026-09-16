import React, { useCallback, useRef, useState } from 'react';
import { Sparkline } from './Sparkline';

export interface Tip {
  title: string;
  lines: string[];
  /** A 60 s history drawn under the lines, on the given scale. */
  history?: (number | undefined)[];
  historyMax?: number;
}

interface Placed extends Tip {
  x: number;
  y: number;
}

/**
 * Hover detail for the diagrams. A native SVG <title> takes a second to show and
 * cannot hold a sparkline; this is a small panel in the same typography, placed by
 * the pointer and clipped to its host. `bind(tip)` goes on the hovered element.
 */
export function useTooltip() {
  const host = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Placed | null>(null);
  const bind = useCallback(
    (t: Tip) => ({
      onMouseMove: (e: React.MouseEvent) => {
        const r = host.current?.getBoundingClientRect();
        if (!r) return;
        setTip({ ...t, x: e.clientX - r.left, y: e.clientY - r.top });
      },
      onMouseLeave: () => setTip(null)
    }),
    []
  );
  return { host, tip, bind };
}

export const Tooltip: React.FC<{ tip: Placed | null; hostWidth?: number }> = ({ tip, hostWidth }) => {
  if (!tip) return null;
  // Flip to the left of the pointer near the host's right edge so the panel stays readable.
  const flip = hostWidth !== undefined && tip.x > hostWidth - 170;
  return (
    <div
      className="pointer-events-none absolute z-10 w-40 rounded border border-studio-border-light bg-studio-bg/95 px-2 py-1.5 space-y-0.5"
      style={{ left: flip ? tip.x - 172 : tip.x + 12, top: tip.y + 12 }}
    >
      <div className="label text-studio-text">{tip.title}</div>
      {tip.lines.map((l) => (
        <div key={l} className="figure text-[11px] text-studio-muted whitespace-nowrap">
          {l}
        </div>
      ))}
      {tip.history && <Sparkline className="text-studio-text mt-1" points={tip.history} min={0} max={tip.historyMax ?? 1} />}
    </div>
  );
};
