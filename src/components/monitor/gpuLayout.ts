import type { SensorIndex } from './sensors';

export interface PinIds {
  n: number;
  ampsId?: string;
  voltsId?: string;
  wattsId?: string;
}

export interface FanIds {
  id: string;
  name: string;
  duty?: string;
}

export interface GpuLayout {
  hotSpot?: string;
  memJunction?: string;
  bus?: string;
  pins: PinIds[];
  connectorA?: string;
  connectorW?: string;
  fans: FanIds[];
}

/** The LibreHardwareMonitor node for the NVML card; a box with an iGPU has two GPU nodes, so the name decides. */
export function gpuLayout(index: SensorIndex, gpuName: string | undefined): GpuLayout {
  const hw = index.hardware(/^Gpu/i, (n) => n === gpuName)[0] ?? index.hardware(/^GpuNvidia$/i)[0] ?? index.hardware(/^Gpu/i)[0];
  const byPin = new Map<number, PinIds>();
  const pin = (n: number) => {
    let p = byPin.get(n);
    if (!p) byPin.set(n, (p = { n }));
    return p;
  };
  const PIN = /^12VHPWR Pin (\d+)$/;
  for (const f of index.findAll(hw, 'Current', PIN)) pin(+f.match[1]).ampsId = f.meta.id;
  for (const f of index.findAll(hw, 'Voltage', PIN)) pin(+f.match[1]).voltsId = f.meta.id;
  for (const f of index.findAll(hw, 'Power', PIN)) pin(+f.match[1]).wattsId = f.meta.id;
  const controls = index.findAll(hw, 'Control', /^GPU Fan (\d+)$/);
  return {
    hotSpot: index.find(hw, 'Temperature', /Hot ?Spot/i)?.id,
    memJunction: index.find(hw, 'Temperature', /Memory Junction/i)?.id,
    bus: index.find(hw, 'Load', /^GPU Bus$/)?.id,
    pins: [...byPin.values()].sort((a, b) => a.n - b.n),
    connectorA: index.find(hw, 'Current', /^12VHPWR Connector$/)?.id,
    connectorW: index.find(hw, 'Power', /^12VHPWR Connector$/)?.id,
    // On a liquid-cooled card these are the radiator fans: "Fan 1", not "GPU Fan 1" (plan 17a).
    fans: index.findAll(hw, 'Fan', /^GPU Fan (\d+)$/).map((f) => ({ id: f.meta.id, name: `Fan ${f.match[1]}`, duty: controls.find((c) => c.match[1] === f.match[1])?.meta.id }))
  };
}
