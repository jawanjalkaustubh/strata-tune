import React from 'react';
import { TONE, type Tone } from './Pill';
import { toneByLimit } from './Bar';
import { Sparkline } from './Sparkline';
import { Tooltip, useTooltip } from './Tooltip';
import { analysePins, CONNECTOR_LIMIT_W, PIN_LIMIT_A, type PinReading } from './pins';

interface Props {
  pins: PinReading[];
  totalAmps?: number;
  totalWatts?: number;
  /** 60 s of a pin's current, drawn under each pin and in its hover tip. */
  history: (pin: PinReading) => (number | undefined)[] | undefined;
}

const Figure: React.FC<{ label: string; value: string; tone: Tone; title: string }> = ({ label, value, tone, title }) => (
  <span className="inline-flex items-baseline gap-1" title={title}>
    <span className="label">{label}</span>
    <span className={`figure text-[12px] ${TONE[tone].text}`}>{value}</span>
  </span>
);

/**
 * The 12V-2x6 connector block (plan 17a): six pins as vertical bars on the 0–9.5 A
 * per-pin scale with A, W and V beneath and each pin's 60 s current under that; the
 * connector total against its 600 W rating; and the two figures GPU Tweak never
 * computes, spread (max − min) and max/mean, toned emerald ≤ 10 %, amber to 20 %, red
 * past it or at the pin rating. The pin carrying the most current takes that tone so
 * the eye finds it first; with the connector idle every pin is slate, like the figures.
 * Plain DOM so the bars fill whatever column the panel gives them while the text
 * keeps its size.
 */
export const PinHeader: React.FC<Props> = ({ pins, totalAmps, totalWatts, history }) => {
  const { host, tip, bind } = useTooltip();
  const a = analysePins(pins);
  const idle = a.tone === 'idle';
  const pinTone = (p: PinReading, i: number): Tone => {
    if (p.amps === undefined || idle) return 'idle';
    if (p.amps >= PIN_LIMIT_A) return 'bad';
    if (a.tone !== 'ok' && i === a.maxIndex) return a.tone;
    return 'ok';
  };
  // The connector bar is the measured total: watts when the card senses them, else the
  // current against the rating's 50 A, never a watts figure made up at a nominal 12 V.
  const total = totalWatts !== undefined
    ? { value: totalWatts, limit: CONNECTOR_LIMIT_W, text: `${totalWatts.toFixed(0)} W`, of: `of ${CONNECTOR_LIMIT_W}` }
    : totalAmps !== undefined
      ? { value: totalAmps, limit: CONNECTOR_LIMIT_W / 12, text: `${totalAmps.toFixed(1)} A`, of: `of ${CONNECTOR_LIMIT_W / 12} A` }
      : undefined;
  const totalTone = toneByLimit(total?.value ?? 0, total?.limit, 0.9);
  const totalPct = total === undefined ? 0 : Math.min(total.value / (total.limit * 1.1), 1) * 100;
  const figures = a.live > 0;

  return (
    <div ref={host} className="relative space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="label normal-case">12V-2x6</span>
        <span className="flex flex-wrap items-baseline gap-x-3">
          {figures && <Figure label="Spread" value={`${a.spreadA.toFixed(2)} A · ${a.spreadPct.toFixed(0)} %`} tone={a.tone} title="Highest pin minus lowest, and as a share of the mean" />}
          {figures && <Figure label="Max/mean" value={`${a.maxOverMean.toFixed(2)}×`} tone={a.tone} title={`Mean ${a.meanA.toFixed(2)} A per pin`} />}
        </span>
      </div>
      <div className="rounded-md border border-studio-border-light bg-studio-surface px-2 pt-1.5 pb-1.5">
        <div className="grid grid-cols-6 gap-x-2">
          {pins.map((p, i) => {
            const tone = pinTone(p, i);
            const frac = p.amps === undefined ? 0 : Math.min(p.amps / PIN_LIMIT_A, 1);
            const series = history(p);
            const tipFor = {
              title: `Pin ${p.n}`,
              lines: [`${p.amps === undefined ? '—' : `${p.amps.toFixed(2)} A`} of ${PIN_LIMIT_A} A`, p.watts === undefined ? '' : `${p.watts.toFixed(1)} W`, p.volts === undefined ? '' : `${p.volts.toFixed(3)} V`, `mean ${a.meanA.toFixed(2)} A`].filter(Boolean),
              history: series,
              historyMax: PIN_LIMIT_A
            };
            return (
              <div key={p.n} className="min-w-0 flex flex-col items-center" {...bind(tipFor)}>
                <span className="label text-[10px]">{p.n}</span>
                <div className="relative w-full max-w-12 h-16 mt-0.5 rounded border border-studio-border-light bg-studio-bg overflow-hidden" role="img" aria-label={`Pin ${p.n} ${p.amps === undefined ? 'no reading' : `${p.amps.toFixed(2)} A`}`}>
                  <div className={`absolute inset-x-0 bottom-0 ${TONE[tone].fill} transition-[height] duration-200 ease-linear`} style={{ height: `${(frac * 100).toFixed(1)}%` }} />
                </div>
                <span className={`figure text-[12px] mt-1 whitespace-nowrap ${tone === 'idle' || tone === 'ok' ? 'text-studio-text' : TONE[tone].text}`}>{p.amps === undefined ? '—' : p.amps.toFixed(1)}</span>
                <span className="figure text-[10px] text-studio-muted whitespace-nowrap">{p.watts === undefined ? '' : `${p.watts.toFixed(0)} W`}</span>
                <span className="figure text-[10px] text-studio-muted whitespace-nowrap">{p.volts === undefined ? '' : `${p.volts.toFixed(1)} V`}</span>
                {series && <Sparkline className={`${TONE[tone].text} mt-1`} points={series} min={0} max={PIN_LIMIT_A} />}
              </div>
            );
          })}
        </div>
      </div>
      {total !== undefined && (
        <div className="grid grid-cols-[5rem_minmax(4rem,1fr)_max-content] items-center gap-x-3 min-w-0">
          <span className="label truncate">Connector</span>
          <div className="relative h-1.5 rounded-full bg-studio-border my-1">
            <div className={`absolute inset-y-0 left-0 rounded-full ${TONE[totalTone].fill} transition-[width] duration-200 ease-linear`} style={{ width: `${totalPct.toFixed(2)}%` }} />
            <div className={`absolute -top-1 h-3.5 w-px ${totalTone === 'bad' ? 'bg-rose-400' : 'bg-slate-300/80'}`} style={{ left: `${(100 / 1.1).toFixed(2)}%` }} title={`${CONNECTOR_LIMIT_W} W rating`} />
          </div>
          <span className={`figure text-right text-[12px] whitespace-nowrap ${TONE[totalTone].text}`}>
            {totalWatts !== undefined && totalAmps !== undefined && <span className="text-studio-subtle text-[10px] mr-1">{totalAmps.toFixed(1)} A</span>}
            {total.text}<span className="text-studio-subtle text-[10px] ml-1">{total.of}</span>
          </span>
        </div>
      )}
      <Tooltip tip={tip} hostWidth={host.current?.clientWidth} />
    </div>
  );
};
