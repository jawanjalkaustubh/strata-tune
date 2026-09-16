import React, { useMemo, useRef } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel } from './Panel';
import { Bar, toneByLimit } from './Bar';
import { ChipDiagram, type CoreGroup } from './ChipDiagram';
import { cpuLayout, groupCores } from './cpuLayout';
import { cpuLimits } from './cpuLimits';
import { vendorOf } from './vendors';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
}

const degrees = (x: number) => `${x.toFixed(1)} °C`;

/** Chip diagram beside the bars (the panel is never narrower than 600 px above md), so the two halves read as one instrument (plan 17a). */
export const CpuPanel: React.FC<Props> = ({ index, tick, ring, snapshot }) => {
  const layout = useMemo(() => cpuLayout(index, snapshot?.cpu), [index, snapshot]);
  const limits = useMemo(() => cpuLimits(snapshot?.cpu.name), [snapshot]);
  const vendor = useMemo(() => vendorOf(snapshot?.cpu.name), [snapshot]);
  const groupIds = useMemo(() => groupCores(layout, limits.ccds), [layout, limits]);

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));

  // The highest nominal clock seen is the boost reference: WMI only knows the base clock.
  const boost = useRef(0);
  for (const c of layout.cores) {
    const n = v(c.nominal);
    if (n !== undefined && n > boost.current) boost.current = n;
  }

  const groups: CoreGroup[] = groupIds.map((g) => ({
    label: g.label,
    tdie: v(g.tdie),
    cores: g.cores.map((c) => {
      const ls = c.loads.map((id) => tick.sensors[id]).filter((x): x is number => x !== undefined);
      return {
        n: c.n,
        effectiveMhz: v(c.effective),
        nominalMhz: v(c.nominal),
        load: ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : undefined,
        smuW: v(c.smu),
        vid: v(c.vid)
      };
    })
  }));

  const tctl = v(layout.tctl);
  const pkg = v(layout.packageW);
  const effs = groups.flatMap((g) => g.cores.map((c) => c.effectiveMhz)).filter((x): x is number => x !== undefined);
  const avgEff = v(layout.avgEffective) ?? (effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : undefined);
  const pkgHigh = layout.packageW ? ring.high((t) => t.sensors[layout.packageW!]) : 0;
  const tempMax = limits.tjmax ? limits.tjmax + 10 : 110;
  const clockMax = Math.max(boost.current, avgEff ?? 0, 1000);

  return (
    <Panel title="CPU" vendor={vendor}>
      <div className="flex flex-col md:flex-row gap-x-4 gap-y-3">
        {layout.cores.length > 0 && (
          <div className="md:shrink-0 md:w-[280px]">
            <ChipDiagram groups={groups} tctl={tctl} packageW={pkg} tjmax={limits.tjmax} powerLimitW={limits.powerW} vendor={vendor} />
          </div>
        )}
        <div className="flex-1 min-w-0 space-y-1.5">
          <Bar
            label="Tctl"
            value={tctl}
            format={degrees}
            max={tempMax}
            limit={limits.tjmax}
            limitLabel={limits.tjmax ? `Tjmax ${limits.tjmax} °C` : undefined}
            tone={toneByLimit(tctl ?? 0, limits.tjmax)}
            history={hist(layout.tctl)}
          />
          <Bar
            label="Package"
            value={pkg}
            format={(x) => `${x.toFixed(1)} W`}
            max={limits.powerW ? limits.powerW * 1.15 : Math.max(pkgHigh * 1.2, 100)}
            limit={limits.powerW}
            limitLabel={limits.powerW ? `${limits.powerName} ${limits.powerW} W` : undefined}
            sub={limits.powerW ? `of ${limits.powerW} W` : undefined}
            tone={toneByLimit(pkg ?? 0, limits.powerW)}
            history={hist(layout.packageW)}
          />
          <Bar
            label="Avg effective"
            value={avgEff}
            format={(x) => `${(x / 1000).toFixed(2)} GHz`}
            max={clockMax}
            mark={boost.current || undefined}
            markLabel={`Highest boost seen ${(boost.current / 1000).toFixed(2)} GHz`}
            tone="ok"
            history={hist(layout.avgEffective)}
          />
          {layout.ccds.map((m) => (
            <Bar key={m.id} label={m.name} value={tick.sensors[m.id]} format={degrees} max={tempMax} limit={limits.tjmax} tone={toneByLimit(tick.sensors[m.id] ?? 0, limits.tjmax)} history={hist(m.id)} />
          ))}
        </div>
      </div>
    </Panel>
  );
};
