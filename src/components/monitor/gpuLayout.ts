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

export interface EngineIds {
  name: string;
  /** LHM lists one row per D3D engine instance (six Copy engines on a 5090); the schematic shows the busiest. */
  ids: string[];
}

export interface GpuLayout {
  hotSpot?: string;
  memJunction?: string;
  coreV?: string;
  /** PCIe throughput in B/s, for the link sparkline on the card's edge. */
  rx?: string;
  tx?: string;
  pins: PinIds[];
  connectorA?: string;
  connectorW?: string;
  fans: FanIds[];
  engines: EngineIds[];
}

/** The engine loads the plan names (17a), in that order; the other D3D rows (compute, security, VR) stay in the full sensor view. */
const ENGINES: { name: string; pattern: RegExp }[] = [
  { name: '3D', pattern: /^D3D 3D$/ },
  { name: 'Copy', pattern: /^D3D Copy/ },
  { name: 'Decode', pattern: /^D3D Video Decode/ },
  { name: 'Encode', pattern: /^D3D Video Encode/ },
  { name: 'OFA', pattern: /^D3D Optical Flow/ },
  { name: 'JPEG', pattern: /^D3D JPEG/ }
];

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
    coreV: index.find(hw, 'Voltage', /^GPU Core( Voltage)?$/i)?.id,
    rx: index.find(hw, 'Throughput', /PCIe Rx/i)?.id,
    tx: index.find(hw, 'Throughput', /PCIe Tx/i)?.id,
    pins: [...byPin.values()].sort((a, b) => a.n - b.n),
    connectorA: index.find(hw, 'Current', /^12VHPWR Connector$/)?.id,
    connectorW: index.find(hw, 'Power', /^12VHPWR Connector$/)?.id,
    // On a liquid-cooled card these are the radiator fans: "Fan 1", not "GPU Fan 1" (plan 17a).
    fans: index.findAll(hw, 'Fan', /^GPU Fan (\d+)$/).map((f) => ({ id: f.meta.id, name: `Fan ${f.match[1]}`, duty: controls.find((c) => c.match[1] === f.match[1])?.meta.id })),
    engines: ENGINES.map((e) => ({ name: e.name, ids: index.findAll(hw, 'Load', e.pattern).map((f) => f.meta.id) })).filter((e) => e.ids.length > 0)
  };
}
