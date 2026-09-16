import type { SensorMeta, SensorRow, StaticSnapshot, Volume } from '../../collector-types';
import { DEFAULT_RAM_BANDWIDTH_GBS, ramBandwidthFromModules } from '../../analysis/advisor';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** What the advisor needs about this machine, from the collector or from the standalone picker. */
export interface HardwareFacts {
  source: 'collector' | 'picker';
  gpuName: string;
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

/** Ollama's blob directory decides which drive's free space counts; the boot volume is the default install. */
export function modelVolume(volumes: Volume[], modelsDir: string | null): Volume | null {
  const letter = modelsDir?.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
  return volumes.find((v) => v.letter.toUpperCase() === letter) ?? volumes.find((v) => v.isBoot) ?? null;
}

export function factsFromSnapshot(s: StaticSnapshot, freeRam: number | null, modelsDir: string | null): HardwareFacts {
  const gpu = s.gpus[0];
  const vol = modelVolume(s.volumes, modelsDir);
  const ramBytes = s.ram.totalMiB * MIB;
  const mts = s.ram.modules.some((m) => m.configuredMts > 0);
  return {
    source: 'collector',
    gpuName: gpu?.name ?? 'No NVML GPU',
    cpuName: s.cpu.name,
    driver: s.gpuDriver.version || gpu?.driver || null,
    vramBytes: (gpu?.vram.totalMiB ?? 0) * MIB,
    vramFreeBytes: gpu ? (gpu.vram.totalMiB - gpu.vram.usedMiB) * MIB : 0,
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
