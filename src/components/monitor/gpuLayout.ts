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
 * A GPU the app reads through LibreHardwareMonitor alone, with no NVML: an integrated GPU
 * (plan 17d row 1: 'GPU panel = the iGPU's LHM sensors (clock, load, shared memory)') or a
 * discrete AMD or Intel card (plan 17d mid-range row: 'AMD cards get LHM sensors and no
 * NVML/NVAPI'). The first laptop's RX 6700S carries core and memory clocks, core and hot-spot
 * temperatures, package power, a fan and the card's own VRAM figures; its Radeon iGPU beside
 * it carries only the D3D memory and engine rows, so every field but the name is optional.
 */
export interface IgpuLayout {
  hardware: string;
  name: string;
  clock?: string;
  memClock?: string;
  load?: string;
  /** D3D shared memory in MB, used and total: what an iGPU draws its memory from. */
  sharedUsed?: string;
  sharedTotal?: string;
  dedicatedUsed?: string;
  /** The card's own VRAM figures from its driver (ADL on AMD), in MB; a discrete card's memory bar. */
  vramUsed?: string;
  vramTotal?: string;
  power?: string;
  temperature?: string;
  hotSpot?: string;
  fan?: string;
  fanDuty?: string;
  engines: EngineIds[];
}

/**
 * The library node for a GPU that is not the NVML card. `prefer` names the node wanted (the
 * discrete adapter's name from the snapshot, which matches the library's name for it);
 * without a match the node with the most VRAM stands in, so a discrete card is never
 * mistaken for the iGPU beside it. Null when no such node exists.
 */
export function igpuLayout(index: SensorIndex, nvmlName: string | undefined, prefer?: string): IgpuLayout | null {
  const nodes = index.hardware(/^Gpu/i, (n) => nvmlName === undefined || n !== nvmlName).filter((id) => !/^\/nvml\//.test(id));
  if (nodes.length === 0) return null;
  const vramOf = (hw: string) => index.find(hw, 'SmallData', /^GPU Memory Total$/i)?.id;
  const byVram = [...nodes].sort((a, b) => (vramOf(b) ? 1 : 0) - (vramOf(a) ? 1 : 0));
  const hw = (prefer && nodes.find((id) => index.hardwareName(id) === prefer)) ?? byVram[0];
  return {
    hardware: hw,
    name: index.hardwareName(hw) ?? 'Integrated GPU',
    clock: index.find(hw, 'Clock', /^GPU Core$/i)?.id,
    memClock: index.find(hw, 'Clock', /^GPU Memory$/i)?.id,
    load: index.find(hw, 'Load', /^GPU Core$/i)?.id,
    sharedUsed: index.find(hw, 'SmallData', /^D3D Shared Memory Used$/i)?.id,
    sharedTotal: index.find(hw, 'SmallData', /^D3D Shared Memory Total$/i)?.id,
    dedicatedUsed: index.find(hw, 'SmallData', /^D3D Dedicated Memory Used$/i)?.id,
    vramUsed: index.find(hw, 'SmallData', /^GPU Memory Used$/i)?.id,
    vramTotal: vramOf(hw),
    power: (index.find(hw, 'Power', /^GPU (Core|Package)$/i) ?? index.find(hw, 'Power', /^GPU SoC$/i))?.id,
    temperature: (index.find(hw, 'Temperature', /^GPU (Core|Temperature)$/i) ?? index.find(hw, 'Temperature', /SoC/i))?.id,
    hotSpot: index.find(hw, 'Temperature', /Hot ?Spot/i)?.id,
    fan: index.find(hw, 'Fan', /^GPU Fan/i)?.id,
    fanDuty: index.find(hw, 'Control', /^GPU Fan/i)?.id,
    engines: ENGINES.map((e) => ({ name: e.name, ids: index.findAll(hw, 'Load', e.pattern).map((f) => f.meta.id) })).filter((e) => e.ids.length > 0)
  };
}

/** The other library GPU nodes beside the one a panel shows: on a hybrid laptop, the iGPU that drives the desktop while the card sleeps. */
export function otherGpuNodes(index: SensorIndex, shown: string, nvmlName: string | undefined): string[] {
  return index
    .hardware(/^Gpu/i, (n) => nvmlName === undefined || n !== nvmlName)
    .filter((id) => id !== shown && !/^\/nvml\//.test(id))
    .map((id) => index.hardwareName(id) ?? id);
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
