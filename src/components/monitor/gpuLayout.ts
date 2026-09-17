import type { SensorIndex } from './sensors';

/** One 12V-2x6 pin with a current sensor; voltage and power ride along when the card senses them too. */
export interface PinIds {
  n: number;
  ampsId: string;
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
  /**
   * Empty on a card without per-pin shunts (a Founders Edition reports board power only), and
   * then the whole 12V-2x6 block, its spread and max/mean and the connector totals do not exist
   * (plan section 17a): nothing is shown from totals alone, because a total is already the
   * board-power bar.
   */
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

/**
 * An integrated GPU's LibreHardwareMonitor sensors (plan 17d row 1: 'GPU panel = the iGPU's
 * LHM sensors (clock, load, shared memory)'): the AMD or Intel node that is not the NVML card,
 * the dev box's own /gpu-amd/0 shape. Null when no such node exists.
 */
export interface IgpuLayout {
  hardware: string;
  name: string;
  clock?: string;
  load?: string;
  /** D3D shared memory in MB, used and total: what an iGPU draws its memory from. */
  sharedUsed?: string;
  sharedTotal?: string;
  dedicatedUsed?: string;
  power?: string;
  temperature?: string;
  engines: EngineIds[];
}

export function igpuLayout(index: SensorIndex, nvmlName: string | undefined): IgpuLayout | null {
  const hw = index.hardware(/^Gpu/i, (n) => nvmlName === undefined || n !== nvmlName).find((id) => !/^\/nvml\//.test(id));
  if (!hw) return null;
  return {
    hardware: hw,
    name: index.hardwareName(hw) ?? 'Integrated GPU',
    clock: index.find(hw, 'Clock', /^GPU Core$/i)?.id,
    load: index.find(hw, 'Load', /^GPU Core$/i)?.id,
    sharedUsed: index.find(hw, 'SmallData', /^D3D Shared Memory Used$/i)?.id,
    sharedTotal: index.find(hw, 'SmallData', /^D3D Shared Memory Total$/i)?.id,
    dedicatedUsed: index.find(hw, 'SmallData', /^D3D Dedicated Memory Used$/i)?.id,
    power: (index.find(hw, 'Power', /^GPU (Core|Package)$/i) ?? index.find(hw, 'Power', /^GPU SoC$/i))?.id,
    temperature: (index.find(hw, 'Temperature', /^GPU (Core|Temperature)$/i) ?? index.find(hw, 'Temperature', /SoC/i))?.id,
    engines: ENGINES.map((e) => ({ name: e.name, ids: index.findAll(hw, 'Load', e.pattern).map((f) => f.meta.id) })).filter((e) => e.ids.length > 0)
  };
}

/** The LibreHardwareMonitor node for the NVML card; a box with an iGPU has two GPU nodes, so the name decides. */
export function gpuLayout(index: SensorIndex, gpuName: string | undefined): GpuLayout {
  const hw = index.hardware(/^Gpu/i, (n) => n === gpuName)[0] ?? index.hardware(/^GpuNvidia$/i)[0] ?? index.hardware(/^Gpu/i)[0];
  // A pin exists by its current sensor; the analysis is of currents, so a voltage or power row alone makes no pin.
  const PIN = /^12VHPWR Pin (\d+)$/;
  const byPin = new Map<number, PinIds>();
  for (const f of index.findAll(hw, 'Current', PIN)) byPin.set(+f.match[1], { n: +f.match[1], ampsId: f.meta.id });
  for (const f of index.findAll(hw, 'Voltage', PIN)) if (byPin.has(+f.match[1])) byPin.get(+f.match[1])!.voltsId = f.meta.id;
  for (const f of index.findAll(hw, 'Power', PIN)) if (byPin.has(+f.match[1])) byPin.get(+f.match[1])!.wattsId = f.meta.id;
  const pins = [...byPin.values()].sort((a, b) => a.n - b.n);
  const controls = index.findAll(hw, 'Control', /^GPU Fan (\d+)$/);
  return {
    hotSpot: index.find(hw, 'Temperature', /Hot ?Spot/i)?.id,
    memJunction: index.find(hw, 'Temperature', /Memory Junction/i)?.id,
    coreV: index.find(hw, 'Voltage', /^GPU Core( Voltage)?$/i)?.id,
    rx: index.find(hw, 'Throughput', /PCIe Rx/i)?.id,
    tx: index.find(hw, 'Throughput', /PCIe Tx/i)?.id,
    pins,
    connectorA: pins.length > 0 ? index.find(hw, 'Current', /^12VHPWR Connector$/)?.id : undefined,
    connectorW: pins.length > 0 ? index.find(hw, 'Power', /^12VHPWR Connector$/)?.id : undefined,
    // On a liquid-cooled card these are the radiator fans: "Fan 1", not "GPU Fan 1" (plan 17a).
    fans: index.findAll(hw, 'Fan', /^GPU Fan (\d+)$/).map((f) => ({ id: f.meta.id, name: `Fan ${f.match[1]}`, duty: controls.find((c) => c.match[1] === f.match[1])?.meta.id })),
    engines: ENGINES.map((e) => ({ name: e.name, ids: index.findAll(hw, 'Load', e.pattern).map((f) => f.meta.id) })).filter((e) => e.ids.length > 0)
  };
}
