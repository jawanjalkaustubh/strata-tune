import React from 'react';
import { TONE, type Tone } from './Pill';
import { toneByLimit } from './Bar';
import { Tooltip, useTooltip } from './Tooltip';
import { analysePins, CONNECTOR_LIMIT_W, PIN_LIMIT_A, type PinReading } from './pins';

interface Props {
  pins: PinReading[];
  totalAmps?: number;
  totalWatts?: number;
  /** 60 s of a pin's current, for the hover sparkline. */
  history: (pin: PinReading) => (number | undefined)[] | undefined;
}

const SLOT_W = 26;
const SLOT_H = 44;
const GAP = 8;
const PAD = 10;
const TEXT_H = 36;
const TEXT = '#f1f5f9';
const MUTED = '#94a3b8';

const Figure: React.FC<{ label: string; value: string; tone: Tone; title: string }> = ({ label, value, tone, title }) => (
  <span className="inline-flex items-baseline gap-1" title={title}>
    <span className="label">{label}</span>
    <span className={`figure text-[12px] ${TONE[tone].text}`}>{value}</span>
  </span>
);

/**
 * The 12V-2x6 connector block (plan 17a): six pins as vertical bars on the 0–9.5 A
 * per-pin scale with A, W and V beneath; the connector total against its 600 W
 * rating; and the two figures GPU Tweak never computes, spread (max − min) and
 * max/mean, toned emerald ≤ 10 %, amber to 20 %, red past it or at the pin rating.
 * The pin carrying the most current takes that tone so the eye finds it first.
 */
export const PinHeader: React.FC<Props> = ({ pins, totalAmps, totalWatts, history }) => {
  const { host, tip, bind } = useTooltip();
  const a = analysePins(pins);
  const width = PAD * 2 + pins.length * SLOT_W + (pins.length - 1) * GAP;
  const height = PAD * 2 + SLOT_H + TEXT_H;
  const pinFill = (p: PinReading, i: number) => {
    if (p.amps === undefined || p.amps < 0.3) return TONE.idle.hex;
    if (p.amps >= PIN_LIMIT_A) return TONE.bad.hex;
    if (a.tone !== 'ok' && a.tone !== 'idle' && i === a.maxIndex) return TONE[a.tone].hex;
    return TONE.ok.hex;
  };
  const watts = totalWatts ?? (totalAmps !== undefined ? totalAmps * 12 : undefined);
  const totalTone = toneByLimit(watts ?? 0, CONNECTOR_LIMIT_W, 0.9);
  const totalPct = watts === undefined ? 0 : Math.min(watts / (CONNECTOR_LIMIT_W * 1.1), 1) * 100;
  const figures = a.live > 0;

  return (
    <div ref={host} className="relative space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="label">12V-2x6</span>
        <span className="flex flex-wrap items-baseline gap-x-3">
          {figures && <Figure label="Spread" value={`${a.spreadA.toFixed(2)} A · ${a.spreadPct.toFixed(0)} %`} tone={a.tone} title="Highest pin minus lowest, and as a share of the mean" />}
          {figures && <Figure label="Max/mean" value={`${a.maxOverMean.toFixed(2)}×`} tone={a.tone} title={`Mean ${a.meanA.toFixed(2)} A per pin`} />}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full h-auto max-w-full" style={{ maxWidth: width * 1.2 }} role="img" aria-label="12V-2x6 pins">
        <rect x={1} y={1} width={width - 2} height={height - 2} rx={5} fill="#121620" stroke="#323b4e" />
        {pins.map((p, i) => {
          const x = PAD + i * (SLOT_W + GAP);
          const frac = p.amps === undefined ? 0 : Math.min(p.amps / PIN_LIMIT_A, 1);
          const fillH = Math.round(frac * (SLOT_H - 2));
          const tipFor = {
            title: `Pin ${p.n}`,
            lines: [`${p.amps === undefined ? '—' : `${p.amps.toFixed(2)} A`} of ${PIN_LIMIT_A} A`, p.watts === undefined ? '' : `${p.watts.toFixed(1)} W`, p.volts === undefined ? '' : `${p.volts.toFixed(3)} V`, `mean ${a.meanA.toFixed(2)} A`].filter(Boolean),
            history: history(p),
            historyMax: PIN_LIMIT_A
          };
          return (
            <g key={p.n} transform={`translate(${x} ${PAD})`} {...bind(tipFor)}>
              <rect width={SLOT_W} height={SLOT_H} rx={3} fill="#0c0e14" stroke="#323b4e" />
              <rect x={1} y={1 + (SLOT_H - 2 - fillH)} width={SLOT_W - 2} height={fillH} rx={2} fill={pinFill(p, i)} />
              <text x={SLOT_W / 2} y={SLOT_H + 12} textAnchor="middle" className="chip-figure" fill={TEXT}>
                {p.amps === undefined ? '—' : p.amps.toFixed(1)}
              </text>
              <text x={SLOT_W / 2} y={SLOT_H + 22} textAnchor="middle" className="chip-nominal" fill={MUTED}>
                {p.watts === undefined ? `#${p.n}` : `${p.watts.toFixed(0)} W`}
              </text>
              <text x={SLOT_W / 2} y={SLOT_H + 32} textAnchor="middle" className="chip-nominal" fill={MUTED}>
                {p.volts === undefined ? '' : `${p.volts.toFixed(2)} V`}
              </text>
            </g>
          );
        })}
      </svg>
      {watts !== undefined && (
        <div className="grid grid-cols-[7.5rem_1fr_6.5rem] items-center gap-x-3 min-w-0">
          <span className="label truncate">Connector</span>
          <div className="relative h-1.5 rounded-full bg-studio-border my-1">
            <div className={`absolute inset-y-0 left-0 rounded-full ${TONE[totalTone].fill} transition-[width] duration-200 ease-linear`} style={{ width: `${totalPct.toFixed(2)}%` }} />
            <div className={`absolute -top-1 h-3.5 w-px ${totalTone === 'bad' ? 'bg-rose-400' : 'bg-slate-300/80'}`} style={{ left: `${((CONNECTOR_LIMIT_W / (CONNECTOR_LIMIT_W * 1.1)) * 100).toFixed(2)}%` }} title={`${CONNECTOR_LIMIT_W} W rating`} />
          </div>
          <span className={`figure text-right text-[12px] whitespace-nowrap ${TONE[totalTone].text}`}>
            {totalAmps !== undefined && <span className="text-studio-subtle text-[10px] mr-1">{totalAmps.toFixed(1)} A</span>}
            {watts.toFixed(0)} W<span className="text-studio-subtle text-[10px] ml-1">of {CONNECTOR_LIMIT_W}</span>
          </span>
        </div>
      )}
      <Tooltip tip={tip} hostWidth={host.current?.clientWidth} />
    </div>
  );
};
