import React from 'react';
import { AlertOctagon } from 'lucide-react';
import type { FlightLine, TuneReverted } from '../../collector-types';
import { sparkPath } from '../monitor/Sparkline';
import { TONE } from '../monitor/Pill';
import { hasAny, SLOWDOWN } from '../../analysis/nvmlBits';
import { pair, signed } from './wire';

const W = 600;
const H = 96;

type Sample = Extract<FlightLine, { kind: 'sample' }>;
type Event = Extract<FlightLine, { kind: 'event' }>;

interface Series {
  label: string;
  colour: string;
  pick: (s: Sample) => number | null | undefined;
  unit: string;
}

/** The memory-junction temperature is an LHM sensor in the sample's `sensors`; its id comes from the live sensor tree (gpuLayout). */
const series = (memJunctionId?: string): Series[] => [
  { label: 'SM clock', colour: TONE.ok.hex, pick: (s) => s.gpu?.clocks.smMhz, unit: 'MHz' },
  { label: 'Memory clock', colour: TONE.info.hex, pick: (s) => s.gpu?.clocks.memMhz, unit: 'MHz' },
  { label: 'Board power', colour: TONE.warn.hex, pick: (s) => (s.gpu ? s.gpu.powerMw / 1000 : null), unit: 'W' },
  // Violet and pink for the temperatures: rose stays the state colour of the throttle marks beneath (plan 17a).
  { label: 'Core temp', colour: '#a78bfa', pick: (s) => s.gpu?.temperatureC, unit: '°C' },
  { label: 'Memory junction', colour: '#f472b6', pick: (s) => (memJunctionId ? s.sensors[memJunctionId] : null), unit: '°C' }
];

const seconds = (iso: string) => new Date(iso).getTime() / 1000;

/**
 * After a hard hang (plan 16): the last 30 s the recorder flushed before the card
 * died, each series on its own scale so the shape reads, with the seconds a throttle
 * bit was set marked beneath and the ladder's own events (a candidate applied, a
 * pattern started) as ticks above. Inline SVG, drawn once; nothing here updates.
 */
export const FlightRecorder: React.FC<{ reverted: TuneReverted; flight: FlightLine[] | null; memJunctionId?: string }> = ({ reverted, flight, memJunctionId }) => {
  const samples = (flight ?? []).filter((l): l is Sample => l.kind === 'sample');
  const events = (flight ?? []).filter((l): l is Event => l.kind === 'event');
  const drawn = series(memJunctionId).map((s) => {
    const values = samples.map((x) => s.pick(x) ?? undefined);
    const have = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
    if (have.length < 2) return null;
    const min = Math.min(...have);
    const max = Math.max(...have);
    const pad = (max - min) * 0.1 || 1;
    return { ...s, last: have[have.length - 1], d: sparkPath(values, W, H, min - pad, max + pad) };
  }).filter((s): s is NonNullable<typeof s> => !!s);
  const t0 = samples.length > 0 ? seconds(samples[0].at) : 0;
  const t1 = samples.length > 0 ? seconds(samples[samples.length - 1].at) : 1;
  const x = (iso: string) => Math.min(Math.max(((seconds(iso) - t0) / (t1 - t0 || 1)) * W, 0), W);
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 space-y-2 min-w-0">
      <div className="flex items-start gap-2 text-rose-200 text-mini">
        <AlertOctagon size={15} className="shrink-0 mt-0.5" />
        <span>
          The card hard-hung at core {signed(reverted.candidate.coreMhz)} / memory {signed(reverted.candidate.memMhz)} MHz ({reverted.at}) — {reverted.reason}. The baseline ({pair(reverted.baseline)}) is back.{' '}
          {samples.length > 0 ? `Here is the last ${Math.round(t1 - t0)} s before it died:` : 'The recorder has no samples from before it died.'}
        </span>
      </div>
      {samples.length > 0 && (
        <>
          <svg className="block w-full" style={{ height: H }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Flight recorder, the last seconds before the hang">
            {drawn.map((s) => (
              <path key={s.label} d={s.d} fill="none" stroke={s.colour} strokeWidth={1.5} strokeOpacity={0.9} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
            {samples.map((s, i) => (s.gpu && hasAny(s.gpu.clocksEventReasons.raw, SLOWDOWN) ? <rect key={i} x={x(s.at) - 1} y={H - 3} width={2} height={3} fill={TONE.bad.hex} /> : null))}
            {events.map((e, i) => (
              <rect key={`e${i}`} x={x(e.at) - 0.5} y={0} width={1} height={6} fill="#f1f5f9" opacity={0.7}>
                <title>{e.text}</title>
              </rect>
            ))}
          </svg>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-studio-muted">
            {drawn.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5" style={{ background: s.colour }} /> {s.label}{' '}
                <span className="figure text-studio-text">
                  {Math.round(s.last)} {s.unit}
                </span>
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2 h-1" style={{ background: TONE.bad.hex }} /> throttle bit set
            </span>
            {events.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-px h-2 bg-studio-text/70" /> ladder event (hover)</span>}
            <span className="flex-1" />
            <span className="figure">−{Math.round(t1 - t0)} s … 0 s</span>
          </div>
          {events.length > 0 && (
            <ol className="text-micro text-studio-muted space-y-0.5">
              {events.slice(-4).map((e, i) => (
                <li key={i} className="figure">
                  {Math.round(seconds(e.at) - t1)} s: {e.text}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
};
