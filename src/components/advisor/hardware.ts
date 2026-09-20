import type { GpuFacts, SensorMeta, SensorRow, StaticSnapshot, Volume } from '../../collector-types';
import { DEFAULT_RAM_BANDWIDTH_GBS, ramBandwidthFromModules } from '../../analysis/advisor';
import { discreteAdapter } from '../../analysis/adapters';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** What the advisor needs about this machine, from the collector or from the standalone picker. */
export interface HardwareFacts {
  source: 'collector' | 'picker';
  gpuName: string;
  /** The driver's facts for the card in the slot (power limits, clocks, ceilings): what "this card" means on the stats card. null standalone. */
  gpu: GpuFacts | null;
  /** The collector lists no discrete GPU (plan 17d row 1): models run on the CPU from RAM, and the page says a discrete GPU is what changes it. */
  integrated: boolean;
  /** SMBIOS says portable: no PSU tile on the stats card (plan 17d). False standalone. */
  laptop: boolean;
  cpuName: string | null;
  driver: string | null;
  vramBytes: number;
  vramFreeBytes: number;
  ramBytes: number;
  ramFreeBytes: number;
  ramBandwidthGBs: number;
  /** The RAM figure is DEFAULT_RAM_BANDWIDTH_GBS, not one read from the module rows: tagged default on the page. */
  ramBandwidthDefault: boolean;
  /** null when no drive is known (standalone with the field left blank). */
  freeDiskBytes: number | null;
  /** The volume the free space was read from, for the label. */
  diskLetter: string | null;
}

/** LibreHardwareMonitor's "Memory Available" (GB) when the collector streams it; the static snapshot has only the total. */
export function freeRamBytes(meta: SensorMeta[], latest: SensorRow): number | null {
  const m = meta.find((s) => /memory/i.test(s.hardwareType) && s.sensorType === 'Data' && /^Memory Available$/i.test(s.name));
  const v = m ? latest.values[m.id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v * GIB : null;
}

/**
 * A non-NVIDIA card's VRAM as its driver reports it through the library ("GPU Memory Used" /
 * "GPU Memory Total" in MB on the node named like the adapter): what NVML's vram block is on
 * an NVIDIA card. Null when the node carries no such rows (an iGPU, or the library without ADL).
 */
export function libraryVram(meta: SensorMeta[], latest: SensorRow, adapterName: string): { usedMiB: number; totalMiB: number } | null {
  const rows = meta.filter((s) => /^Gpu/i.test(s.hardwareType) && s.hardwareName === adapterName && s.sensorType === 'SmallData');
  const total = rows.find((s) => /^GPU Memory Total$/i.test(s.name));
  const used = rows.find((s) => /^GPU Memory Used$/i.test(s.name));
  const t = total ? latest.values[total.id] : undefined;
  const u = used ? latest.values[used.id] : undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  return { usedMiB: typeof u === 'number' && Number.isFinite(u) ? u : 0, totalMiB: t };
}

/** Ollama's blob directory decides which drive's free space counts; the boot volume is the default install. */
export function modelVolume(volumes: Volume[], modelsDir: string | null): Volume | null {
  const letter = modelsDir?.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
  return volumes.find((v) => v.letter.toUpperCase() === letter) ?? volumes.find((v) => v.isBoot) ?? null;
}

/**
 * What the advisor knows about this machine. The card is the discrete adapter whatever its
 * vendor (src/analysis/adapters.ts): NVML's facts on an NVIDIA card; on an AMD or Intel card
 * the adapter's dedicated memory from the snapshot, refined by the library's own VRAM rows
 * (`vram`, from libraryVram) when the driver reports them. Only a machine with no discrete
 * adapter at all is `integrated` (plan 17d row 1); the first laptop's RX 6700S is not.
 */
export function factsFromSnapshot(s: StaticSnapshot, freeRam: number | null, modelsDir: string | null, vram: { usedMiB: number; totalMiB: number } | null = null): HardwareFacts {
  const gpu = s.gpus[0];
  const card = discreteAdapter(s);
  const vol = modelVolume(s.volumes, modelsDir);
  const ramBytes = s.ram.totalMiB * MIB;
  const mts = s.ram.modules.some((m) => m.configuredMts > 0);
  const totalMiB = gpu?.vram.totalMiB ?? vram?.totalMiB ?? card?.dedicatedMiB ?? 0;
  const usedMiB = gpu?.vram.usedMiB ?? vram?.usedMiB ?? 0;
  return {
    source: 'collector',
    gpuName: card?.name ?? 'Integrated graphics (no discrete GPU)',
    gpu: gpu ?? null,
    integrated: !card,
    laptop: s.chassis.isLaptop,
    cpuName: s.cpu.name,
    driver: gpu?.driver || card?.driverVersion || s.gpuDriver.version || null,
    vramBytes: totalMiB * MIB,
    vramFreeBytes: card ? Math.max(0, totalMiB - usedMiB) * MIB : 0,
    ramBytes,
    ramFreeBytes: freeRam ?? ramBytes,
    ramBandwidthGBs: ramBandwidthFromModules(s.ram.modules),
    ramBandwidthDefault: !mts,
    freeDiskBytes: vol ? vol.freeBytes : null,
    diskLetter: vol ? vol.letter : null
  };
}

export interface PickerChoice {
  gpuName: string;
  ramGiB: number;
  /** Blank means unknown: the download column then shows sizes without a verdict. */
  freeDiskGiB: number | null;
}

/** Standalone: spec VRAM from the table row, everything else from the two inputs. */
export function factsFromPicker(p: PickerChoice, vramGiB: number): HardwareFacts {
  return {
    source: 'picker',
    gpuName: p.gpuName,
    gpu: null,
    integrated: false,
    laptop: false,
    cpuName: null,
    driver: null,
    vramBytes: vramGiB * GIB,
    vramFreeBytes: vramGiB * GIB,
    ramBytes: p.ramGiB * GIB,
    ramFreeBytes: p.ramGiB * GIB,
    ramBandwidthGBs: DEFAULT_RAM_BANDWIDTH_GBS,
    ramBandwidthDefault: true,
    freeDiskBytes: p.freeDiskGiB === null ? null : p.freeDiskGiB * GIB,
    diskLetter: null
  };
}

/**
 * Whether a cached bench was taken on the GPU now selected. Vendor prefixes differ between
 * NVML, DXGI and the table, and the table names memory variants ("4060 Ti 16 GB") that the
 * driver does not; after stripping both, the names must be equal, so a 5070's bench never
 * stands in for a 5070 Ti's.
 */
export function sameGpu(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(nvidia|amd|intel|geforce|radeon)\b|\(tm\)|\(r\)/g, '')
      .replace(/\b\d+\s*gb\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}
