import React, { useMemo, useRef } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Sparkline } from './Sparkline';
import { BAR_GRID } from './Bar';
import { TONE } from './Pill';
import { systemPower, type SystemPower as Estimate } from '../../analysis/power';
import { COMFORTABLE, PSU_TRANSIENT_NOTE, psuVerdict, wallWatts } from '../../analysis/psu';
import { useSettings } from '../useSettings';
import { PsuForm, psuBadge, psuOf } from '../advisor/PsuForm';
import { NO_CAPS, type Caps } from './caps';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
  panel?: PanelChrome;
  /** Plan 17d: on a laptop the PSU question is replaced by the battery's own line. */
  caps?: Caps;
}

/** The battery as the library reads it (plan 17d: 'Monitor leads with CPU, battery and the board'): charge, the rate in or out, the estimated time left. */
export function batteryLine(index: SensorIndex, tick: Tick): string | null {
  const hw = index.hardware(/^Battery$/i);
  if (!hw.length) return null;
  const v = (type: 'Level' | 'Power' | 'TimeSpan', name: RegExp) => {
    const id = index.find(hw, type, name)?.id;
    const x = id ? tick.sensors[id] : undefined;
    return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  };
  const charge = v('Level', /^Charge Level$/i);
  const rate = v('Power', /^Charge\/Discharge Rate$/i);
  const left = v('TimeSpan', /^Remaining Time/i);
  const parts: string[] = [];
  if (charge !== undefined) parts.push(`${charge.toFixed(0)} % charged`);
  if (rate !== undefined && rate !== 0) parts.push(rate < 0 ? `discharging at ${Math.abs(rate).toFixed(1)} W` : `charging at ${rate.toFixed(1)} W`);
  if (left !== undefined && left > 0 && (rate === undefined || rate < 0)) parts.push(`about ${Math.round(left / 60)} min left`);
  return parts.length ? parts.join(' · ') : 'no reading yet';
}

/**
 * The SYSTEM POWER row (plan §13, shipped in Phase 1): package and board power
 * measured, the rest flat estimates, one bar with the split visible and every
 * part tagged. With the PSU set (the form sits here and on the stats card) the
 * wall-side figure follows from the 80 PLUS curve, and the session's peak DC
 * against the rating answers "bigger PSU?" in one line once it passes 70 %.
 */
export const SystemPower: React.FC<Props> = ({ index, tick, ring, snapshot, panel, caps = NO_CAPS }) => {
  const psu = psuOf(useSettings());
  const battery = caps.battery ? batteryLine(index, tick) : null;
  const ids = useMemo(() => {
    const cpu = index.hardware(/^cpu$/i);
    const io = index.hardware(/^(SuperIO|EmbeddedController)$/i);
    const gpuFans = index.findAll(index.hardware(/^Gpu/i), 'Fan', /./).map((f) => f.meta.id);
    return {
      packageW: index.find(cpu, 'Power', /^(?:CPU )?Package$/)?.id,
      fans: [...index.findAll(io, 'Fan', /./).map((f) => f.meta.id), ...gpuFans],
      queues: index.findAll(undefined, 'Factor', /^Disk queue length$/).map((f) => f.meta.id)
    };
  }, [index]);
  const dimmCount = snapshot?.ram.modules.length ?? 0;

  const estimate = (t: Tick): Estimate =>
    systemPower({
      cpuPackageW: ids.packageW === undefined ? undefined : t.sensors[ids.packageW],
      gpuBoardW: t.gpu[0] ? t.gpu[0].powerMw / 1000 : undefined,
      dimmCount,
      diskQueues: ids.queues.map((id) => t.sensors[id] ?? 0),
      spinningFans: ids.fans.filter((id) => (t.sensors[id] ?? 0) > 0).length
    });

  const now = estimate(tick);
  // The ring holds a minute; the PSU verdict wants the whole session's peak, kept across renders.
  const sessionPeak = useRef(0);
  sessionPeak.current = Math.max(sessionPeak.current, now.totalW);
  if (now.measuredW === 0) return null;
  const high = Math.max(ring.high((t) => estimate(t).totalW), now.totalW);
  const max = Math.max(high * 1.2, 400);
  const pct = (w: number) => `${((Math.min(w, max) / max) * 100).toFixed(2)}%`;
  const measured = now.parts.filter((p) => p.tag === 'measured');
  const estimated = now.parts.filter((p) => p.tag === 'estimated');
  const part = (p: { label: string; watts: number }) => `${p.label} ${p.watts.toFixed(0)} W`;
  const verdict = psu ? psuVerdict(sessionPeak.current, psu.watts) : null;

  return (
    <Panel
      kind="System power"
      {...panel}
      aside={
        psu ? (
          <span className="figure text-[12px] text-studio-muted whitespace-nowrap" title={`${PSU_TRANSIENT_NOTE} The 80 PLUS ${psuBadge(psu.rating)} minimum curve at this load; real units do a little better.`}>
            ≈ {wallWatts(now.totalW, psu.watts, psu.rating).toFixed(0)} W at the wall <span className="text-studio-subtle">(est., {psuBadge(psu.rating)})</span>
          </span>
        ) : undefined
      }
    >
      <div className={BAR_GRID}>
        <span className="label truncate">Total</span>
        <div className="min-w-0 py-1">
          <div className="relative h-1.5 rounded-full bg-studio-border">
            <div className={`absolute inset-y-0 left-0 rounded-full ${TONE.ok.fill} transition-[width] duration-200 ease-linear`} style={{ width: pct(now.measuredW) }} title={`Measured ${now.measuredW.toFixed(0)} W`} />
            <div className={`absolute inset-y-0 rounded-r-full ${TONE.idle.fill} transition-[width] duration-200 ease-linear`} style={{ left: pct(now.measuredW), width: `calc(${pct(now.totalW)} - ${pct(now.measuredW)})` }} title={`Estimated ${now.estimatedW.toFixed(0)} W`} />
            <div className="absolute -top-1 h-3.5 w-px bg-slate-300/60" style={{ left: pct(high) }} title={`Highest this session ${high.toFixed(0)} W`} />
          </div>
          <Sparkline className={`${TONE.ok.text} mt-1`} points={ring.series((t) => estimate(t).totalW)} min={0} max={max} />
        </div>
        <span className={`figure text-right text-[12px] whitespace-nowrap ${TONE.ok.text}`}>{now.totalW.toFixed(0)} W</span>
      </div>
      <p className="text-micro text-studio-subtle pl-0.5">
        <span className={TONE.ok.text}>measured</span> {measured.map(part).join(' · ')} <span className="mx-1 text-studio-border-light">|</span>
        <span className="text-slate-400">estimated</span> {estimated.map(part).join(' · ')}
      </p>
      {caps.laptop ? (
        // A laptop has no PSU to set: the battery's line stands where the PSU question would be (plan 17d row 1).
        <p className="text-micro text-studio-subtle pl-0.5 flex items-center gap-2 flex-wrap">
          <span className="label">Battery</span>
          <span>{battery ?? 'no battery sensor in the tree (on mains, or the library does not read this battery)'}</span>
        </p>
      ) : (
        <p className="text-micro text-studio-subtle pl-0.5 flex items-center gap-2 flex-wrap">
          <span className="label">PSU</span>
          <PsuForm />
          {verdict && (
            <span title={PSU_TRANSIENT_NOTE}>
              {verdict.loadFraction > COMFORTABLE
                ? verdict.sentence
                : `headroom fine: peak ${sessionPeak.current.toFixed(0)} W DC this session, ${Math.round(verdict.loadFraction * 100)} % of the rating`}
            </span>
          )}
          {!psu && <span>for the wall-side figure and the headroom verdict</span>}
        </p>
      )}
    </Panel>
  );
};
