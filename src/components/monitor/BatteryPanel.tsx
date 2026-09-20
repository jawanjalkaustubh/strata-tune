import React, { useMemo } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Bar, toneByThresholds } from './Bar';
import type { Tone } from './Pill';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
  panel?: PanelChrome;
}

/**
 * The LibreHardwareMonitor battery node's rows, by the names the library gives them on the
 * first laptop (an ASUS pack, 2026-09-19): "Charge Level", "Voltage", "Charge Current" /
 * "Discharge Current", "Charge Rate" / "Discharge Rate" (the one in force is in the list),
 * "Designed Capacity", "Fully-Charged Capacity", "Remaining Capacity" (mWh), "Degradation
 * Level" and, unplugged, "Remaining Time (Estimated)". Every one optional: a pack reports what
 * its controller offers.
 */
export interface BatteryLayout {
  hardware: string;
  name: string;
  charge?: string;
  chargeRate?: string;
  dischargeRate?: string;
  voltage?: string;
  remaining?: string;
  designed?: string;
  fullCharged?: string;
  degradation?: string;
  timeLeft?: string;
}

export function batteryLayout(index: SensorIndex): BatteryLayout | null {
  const hw = index.hardware(/^Battery$/i)[0];
  if (!hw) return null;
  return {
    hardware: hw,
    name: index.hardwareName(hw) ?? 'Battery',
    charge: index.find(hw, 'Level', /^Charge Level$/i)?.id,
    // "Charge/Discharge Rate" is the one signed row older library builds (and the class-matrix mocks before 2026-09-19) carry; it reads as the charge row, negative when discharging.
    chargeRate: (index.find(hw, 'Power', /^Charge Rate$/i) ?? index.find(hw, 'Power', /^Charge\/Discharge Rate$/i))?.id,
    dischargeRate: index.find(hw, 'Power', /^Discharge Rate$/i)?.id,
    voltage: index.find(hw, 'Voltage', /^Voltage$/i)?.id,
    remaining: index.find(hw, 'Energy', /^Remaining Capacity$/i)?.id,
    designed: index.find(hw, 'Energy', /^Designed Capacity$/i)?.id,
    fullCharged: index.find(hw, 'Energy', /^Fully[- ]Charged Capacity$/i)?.id,
    degradation: index.find(hw, 'Level', /^Degradation Level$/i)?.id,
    timeLeft: index.find(hw, 'TimeSpan', /^Remaining Time/i)?.id
  };
}

/** Watts into the pack (positive) or out of it (negative), from whichever rate row the tick carries; undefined with neither. */
export function batteryFlowW(layout: BatteryLayout, sensors: Record<string, number>): number | undefined {
  const charge = layout.chargeRate !== undefined ? sensors[layout.chargeRate] : undefined;
  const discharge = layout.dischargeRate !== undefined ? sensors[layout.dischargeRate] : undefined;
  if (typeof discharge === 'number' && Number.isFinite(discharge) && discharge > 0) return -discharge;
  if (typeof charge === 'number' && Number.isFinite(charge)) return charge;
  return typeof discharge === 'number' && Number.isFinite(discharge) ? -discharge : undefined;
}

const minutes = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

/**
 * The battery panel (plan 17d, the laptop rows: 'Monitor leads with CPU, battery and the
 * board'): charge, the watts flowing in or out, the pack's voltage, the time the controller
 * estimates, and wear as full-charge capacity against the design figure. The panel exists
 * only when the tree has a battery node; the page leaves it out of the grid otherwise.
 */
export const BatteryPanel: React.FC<Props> = ({ index, tick, ring, snapshot, panel }) => {
  const layout = useMemo(() => batteryLayout(index), [index]);
  if (!layout) return null;
  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));
  const charge = v(layout.charge);
  const rate = batteryFlowW(layout, tick.sensors);
  const flowHistory = ring.series((t) => {
    const w = batteryFlowW(layout, t.sensors);
    return w === undefined ? undefined : Math.abs(w);
  });
  const designed = v(layout.designed);
  const full = v(layout.fullCharged);
  const wear = v(layout.degradation) ?? (designed && full ? Math.max(0, (1 - full / designed) * 100) : undefined);
  // The live flow decides (the snapshot's flag is from connect time: the first laptop was unplugged after it and read "plugged in" over 19 W out); the snapshot only stands in without a rate row.
  const onAc = rate !== undefined && rate !== 0 ? rate > 0 : snapshot?.battery ? snapshot.battery.onAc : undefined;
  const flow = rate === undefined ? undefined : rate < 0 ? `discharging ${Math.abs(rate).toFixed(1)} W` : rate > 0 ? `charging ${rate.toFixed(1)} W` : onAc ? 'on the wall, full' : 'idle';
  const timeLeft = v(layout.timeLeft);
  const rateHigh = Math.max(...flowHistory.filter((x): x is number => x !== undefined), Math.abs(rate ?? 0), 30);
  const chargeTone: Tone = charge === undefined ? 'ok' : charge <= 10 ? 'bad' : charge <= 20 ? 'warn' : 'ok';
  const aside = onAc === undefined ? undefined : onAc ? 'plugged in' : 'on battery';
  return (
    <Panel kind="Battery" title={layout.name} nameKey={layout.hardware} aside={aside ? <span className="figure text-[12px] text-studio-muted">{aside}</span> : undefined} {...panel}>
      <div className="bars space-y-1.5 min-w-0">
        <Bar label="Charge" value={charge} format={(x) => `${x.toFixed(0)} %`} max={100} sub={flow} tone={chargeTone} history={hist(layout.charge)} />
        <Bar label="Flow" value={rate === undefined ? undefined : Math.abs(rate)} format={(x) => `${x.toFixed(1)} W`} max={rateHigh * 1.1} sub={rate === undefined ? undefined : rate < 0 ? 'out' : rate > 0 ? 'in' : undefined} tone={rate !== undefined && rate < 0 ? 'warn' : 'ok'} history={flowHistory} />
        <Bar label="Voltage" value={v(layout.voltage)} format={(x) => `${x.toFixed(2)} V`} max={Math.max(v(layout.voltage) ?? 0, 1) * 1.2} tone="ok" history={hist(layout.voltage)} />
        {timeLeft !== undefined && timeLeft > 0 && rate !== undefined && rate < 0 && (
          <p className="text-micro text-studio-subtle pl-0.5">About {minutes(timeLeft)} left at this rate, the controller's estimate.</p>
        )}
        {wear !== undefined && (
          <Bar
            label="Wear"
            value={wear}
            format={(x) => `${x.toFixed(0)} %`}
            max={100}
            sub={designed && full ? `${(full / 1000).toFixed(1)} of ${(designed / 1000).toFixed(1)} Wh as new` : undefined}
            note={wear >= 30 ? 'The pack holds well under its design capacity; a replacement is what brings the runtime back.' : undefined}
            tone={toneByThresholds(wear, 20, 30)}
          />
        )}
      </div>
    </Panel>
  );
};
