import React, { useMemo, useRef } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Bar, toneByLimit } from './Bar';
import { useSettings } from '../useSettings';
import { ChipDiagram, type CoreGroup } from './ChipDiagram';
import { cpuLayout, groupCores } from './cpuLayout';
import { cpuLimits } from './cpuLimits';
import { vendorOf } from './vendors';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
  panel?: PanelChrome;
  /** Opens the Monitor page's CPU tuning menu; the tag on the Package bar's "of N W" is the way in. */
  onOpenPowerLimit?: () => void;
}

const degrees = (x: number) => `${x.toFixed(1)} °C`;

/** The LHM node the rename is keyed by ("/amdcpu/0", "/intelcpu/0"). */
export const cpuKey = (index: SensorIndex) => index.hardware(/^cpu$/i)[0];

/**
 * The socket power ceiling the Package bar is judged against: the user's configured PPT/PL2
 * when set, else the part's stock value, tagged so nobody reads a raised PBO limit off a
 * stock tick (the sensors cannot read the BIOS limit; docs/dependencies.md).
 */
export function cpuPowerLimit(limits: { powerW?: number; powerName?: string }, cpuPptW: number | null | undefined) {
  const set = typeof cpuPptW === 'number' && cpuPptW > 0;
  return { watts: set ? cpuPptW : limits.powerW, stock: !set, name: limits.powerName ?? 'PPT' };
}

/** Chip diagram beside the bars once the panel is 560 px wide (index.css .split; the bars go compact under 360 px), under them in a narrower cell, so the two halves read as one instrument (plan 17a). */
export const CpuPanel: React.FC<Props> = ({ index, tick, ring, snapshot, panel, onOpenPowerLimit }) => {
  const settings = useSettings();
  const layout = useMemo(() => cpuLayout(index, snapshot?.cpu), [index, snapshot]);
  const limits = useMemo(() => cpuLimits(snapshot?.cpu.name), [snapshot]);
  const vendor = useMemo(() => vendorOf(snapshot?.cpu.name), [snapshot]);
  const groupIds = useMemo(() => groupCores(layout, limits.ccds), [layout, limits]);
  const power = cpuPowerLimit(limits, settings.cpuPptW);

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
  // Until the user sets the limit they run, the tick is the part's stock value and says so;
  // once set, the figure is tagged as theirs, on its own line so the figure column never
  // clips it (plan 17a). Either tag opens the menu.
  const limitTag = power.stock ? 'stock' : 'set by you';
  const pptSub = power.watts ? (
    <>
      of {power.watts} W
      <button
        className={`${power.stock ? 'ml-1' : 'block ml-auto'} underline decoration-dotted underline-offset-2 hover:text-studio-text`}
        onClick={onOpenPowerLimit}
        title={power.stock ? `Stock ${power.name} from the parts table; set the limit you run (PBO) to judge against it` : `The ${power.name} you set in the BIOS, entered in the gear menu; no sensor reads it`}
      >
        {limitTag}
      </button>
    </>
  ) : undefined;

  return (
    <Panel kind="CPU" title={snapshot?.cpu.name ?? 'CPU'} nameKey={cpuKey(index)} vendor={vendor} {...panel}>
      <div className="split">
        {layout.cores.length > 0 && (
          <div className="shrink-0 w-[40%] min-w-[min(100%,280px)] max-w-[min(100%,340px)]">
            <ChipDiagram groups={groups} tctl={tctl} packageW={pkg} tjmax={limits.tjmax} powerLimitW={power.watts} vendor={vendor} />
          </div>
        )}
        <div className="bars flex-1 min-w-0 space-y-1.5">
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
            max={power.watts ? Math.max(power.watts * 1.15, pkgHigh * 1.05) : Math.max(pkgHigh * 1.2, 100)}
            limit={power.watts}
            limitLabel={power.watts ? `${power.name} ${power.watts} W (${limitTag})` : undefined}
            sub={pptSub}
            tone={toneByLimit(pkg ?? 0, power.watts)}
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
