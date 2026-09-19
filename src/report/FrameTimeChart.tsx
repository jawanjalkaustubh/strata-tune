import React, { useEffect, useRef, useState } from 'react';
import type { Measurements, StutterCase, StutterMark, TimelinePoint } from './report-types';

interface Props {
  timeline: TimelinePoint[];
  stutters: StutterMark[];
  measurements: Measurements;
  durationS: number;
}

const H = 220;
const PAD = { top: 16, right: 14, bottom: 26, left: 46 };
const FALLBACK_W = 800;

/** Fill class for a stutter dot: the card protecting itself is red, the engine's own is slate, everything fixable amber. */
export function dotTone(c: StutterCase): 'bad' | 'idle' | 'warn' {
  if (c === 2 || c === 3) return 'bad';
  if (c === 7 || c === 8) return 'idle';
  return 'warn';
}

/** The chart is drawn in pixels at the width it gets, so labels stay 11 px at 800 and at 1280. */
function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_W);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(320, Math.round(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const Y_STEPS = [2, 5, 10, 20, 25, 50, 100, 200];
/**
 * Top of the axis: room above the worst 1 % and above nine in ten stutters, so the
 * dots are on the chart and one 400 ms spike does not squash the line to the floor.
 */
function yCeiling(m: Measurements, stutters: StutterMark[]): number {
  const sizes = stutters.map((s) => s.ms).sort((a, b) => a - b);
  const p90 = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.9))] : 0;
  const want = Math.max(m.worst1PctMs * 1.4, m.typicalMs * 2.5, 16.7, Math.min(p90 * 1.1, 200));
  for (const step of Y_STEPS) {
    if (want <= step * 4) return step * 4;
  }
  return Math.ceil(want / 200) * 200;
}

const X_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
function xStep(durationS: number): number {
  for (const s of X_STEPS) if (durationS / s <= 8) return s;
  return 3600;
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `${r}s`;
};

/**
 * Frame time over the session: the per-second mean as the line, the per-second
 * worst frame as a faint trace behind it, every stutter as a dot, typical and
 * worst 1 % as dashed references. A stutter above the axis ceiling sits on the
 * ceiling as a hollow dot rather than flattening the line. Drawn back to front:
 * grid, reference lines, traces, dots, and the two labels last with a halo, so
 * neither a dashed line nor a dot ever cuts through a label.
 */
export const FrameTimeChart: React.FC<Props> = ({ timeline, stutters, measurements: m, durationS }) => {
  const [ref, W] = useWidth();
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const yMax = yCeiling(m, stutters);
  const xMax = Math.max(durationS, timeline[timeline.length - 1]?.t ?? 0, 1);
  const x = (t: number) => PAD.left + (t / xMax) * innerW;
  const y = (ms: number) => PAD.top + innerH - (Math.min(ms, yMax) / yMax) * innerH;

  const path = (pick: (p: TimelinePoint) => number) => timeline.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(pick(p)).toFixed(1)}`).join('');

  const yTicks = [0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const step = xStep(xMax);
  const xTicks: number[] = [];
  for (let t = 0; t <= xMax; t += step) xTicks.push(t);

  // The two reference labels sit at the left edge with a halo in the panel colour, so
  // the data can run under them; when the lines are within a label's height the worst one moves up.
  const typicalY = y(m.typicalMs);
  const worstY = y(m.worst1PctMs);
  const worstLabelY = typicalY - worstY < 12 ? typicalY - 12 : worstY;
  const labelX = PAD.left + 6;
  const showWorst = m.worst1PctMs > m.typicalMs;
  const clipped = stutters.some((s) => s.ms > yMax);

  return (
    <div ref={ref}>
      <svg className="rp-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Frame time over the session">
        {yTicks.map((v, i) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
              {i === yTicks.length - 1 ? `${v} ms` : v}
            </text>
          </g>
        ))}
        <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor={t === 0 ? 'start' : t + step > xMax ? 'end' : 'middle'}>
            {clock(t)}
          </text>
        ))}

        <line className="ref-typical" x1={PAD.left} x2={W - PAD.right} y1={typicalY} y2={typicalY} />
        {showWorst && <line className="ref-worst" x1={PAD.left} x2={W - PAD.right} y1={worstY} y2={worstY} />}

        {timeline.length > 1 && <path className="peak" d={path((p) => p.maxMs)} />}
        {timeline.length > 1 && <path className="line" d={path((p) => p.ms)} />}

        {stutters.map((s, i) => {
          const tone = dotTone(s.case);
          return s.ms > yMax ? (
            <circle key={i} className={`clipped dot-${tone}`} cx={x(s.t)} cy={y(yMax)} r={3} style={{ stroke: `var(--${tone})` }}>
              <title>{`${s.ms.toFixed(0)} ms at ${clock(s.t)}`}</title>
            </circle>
          ) : (
            <circle key={i} className={`dot-${tone}`} cx={x(s.t)} cy={y(s.ms)} r={2.5}>
              <title>{`${s.ms.toFixed(1)} ms at ${clock(s.t)}`}</title>
            </circle>
          );
        })}

        <text className="ref-label ref-typical-t" x={labelX} y={typicalY - 4}>
          typical {m.typicalMs.toFixed(1)} ms
        </text>
        {showWorst && (
          <text className="ref-label ref-worst-t" x={labelX} y={worstLabelY - 4}>
            worst 1 % {m.worst1PctMs.toFixed(1)} ms
          </text>
        )}
      </svg>
      <div className="rp-legend">
        <span>
          <i className="sq" style={{ background: 'var(--ok)' }} /> frame time, per second
        </span>
        <span>
          <i className="sq" style={{ background: 'var(--subtle)' }} /> worst frame that second
        </span>
        <span>
          <i style={{ background: 'var(--warn)' }} /> stutter
        </span>
        <span>
          <i style={{ background: 'var(--bad)' }} /> stutter while the card throttled
        </span>
        <span>
          <i className="engine" /> stutter in the engine
        </span>
        {clipped && (
          <span>
            <i className="hollow" /> above the chart — hover for the value
          </span>
        )}
      </div>
    </div>
  );
};
