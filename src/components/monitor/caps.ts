import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import { gpuLayout } from './gpuLayout';

/**
 * Plan 17d, rule 2: the one capability object the pages branch on, computed once from the
 * snapshot, the sensor list and the tick, never from string-matching inside a component.
 * Every flag is a fact about this machine: NVML lists a discrete NVIDIA card, NVAPI answered
 * for it, the card has per-pin 12V-2x6 shunts, LibreHardwareMonitor exposes an integrated
 * GPU, a battery, the chassis is a laptop, the board's power limit moves (Dynamic Boost),
 * the CPU carries an NPU, the platform is ARM64 (Snapdragon X).
 */
export interface Caps {
  nvml: boolean;
  nvapi: boolean;
  pins: boolean;
  igpu: boolean;
  battery: boolean;
  laptop: boolean;
  dynamicBoost: boolean;
  npu: boolean;
  arm64: boolean;
}

/** Ryzen AI, Core Ultra and Snapdragon X parts carry an NPU (src/analysis/tune.ts deviceClass uses the same rule). */
const NPU_CPU = /Ryzen\s*AI|Core\s*Ultra|Snapdragon(\(R\)|\s)*X/i;
const ARM64_CPU = /Snapdragon/i;

export function capsOf(snapshot: StaticSnapshot | null, index: SensorIndex | null, tick: Tick | null): Caps {
  const gpu = tick?.gpu[0] ?? snapshot?.gpus[0];
  const nvml = !!gpu;
  const laptop = !!snapshot?.chassis.isLaptop;
  // The NVML card's own library node is not an iGPU; any other GPU node (AMD, Intel) is one.
  const igpu = !!index && index.hardware(/^Gpu/i, (n) => !gpu || n !== gpu.name).length > 0;
  return {
    nvml,
    nvapi: !!gpu && (gpu.pstateDeltas != null || gpu.units != null),
    pins: !!index && !!gpu && gpuLayout(index, gpu.name).pins.length > 0,
    igpu,
    battery: !!index && index.hardware(/^Battery$/i).length > 0,
    laptop,
    dynamicBoost: laptop && !!gpu && gpu.powerMaxLimitMw > gpu.powerLimitMw,
    npu: !!snapshot && NPU_CPU.test(snapshot.cpu.name),
    arm64: !!snapshot && ARM64_CPU.test(snapshot.cpu.name)
  };
}

/** Every flag off: what a page shows before the first sample. */
export const NO_CAPS: Caps = { nvml: false, nvapi: false, pins: false, igpu: false, battery: false, laptop: false, dynamicBoost: false, npu: false, arm64: false };
