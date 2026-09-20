import type { DisplayAdapter, StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import { gpuLayout } from './gpuLayout';
import { discreteAdapter, integratedAdapter } from '../../analysis/adapters';

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
  /**
   * The discrete card whatever its vendor (src/analysis/adapters.ts): NVML's card, or the
   * adapter Windows lists with its own memory. Null with only a processor's graphics. An AMD
   * or Intel card here has `nvml` false and is read through the library alone (the first
   * laptop's RX 6700S, 2026-09-19); before that day it was shown as "integrated · no discrete card".
   */
  dgpu: DisplayAdapter | null;
  /** The processor's graphics beside the card on a hybrid laptop, or on its own; from the snapshot's adapter list. */
  igpuAdapter: DisplayAdapter | null;
}

/** Ryzen AI, Core Ultra and Snapdragon X parts carry an NPU (src/analysis/tune.ts deviceClass uses the same rule). */
const NPU_CPU = /Ryzen\s*AI|Core\s*Ultra|Snapdragon(\(R\)|\s)*X/i;
const ARM64_CPU = /Snapdragon/i;

export function capsOf(snapshot: StaticSnapshot | null, index: SensorIndex | null, tick: Tick | null): Caps {
  const gpu = tick?.gpu[0] ?? snapshot?.gpus[0];
  const nvml = !!gpu;
  const laptop = !!snapshot?.chassis.isLaptop;
  const dgpu = snapshot ? discreteAdapter(snapshot) : null;
  const igpuAdapter = snapshot ? integratedAdapter(snapshot) : null;
  // The card's own library node is not an iGPU; with the adapter list (snapshots since
  // 2026-09-19) the iGPU is the adapter Windows calls integrated, and a library GPU node that
  // is neither the NVML card nor the discrete adapter is one on older snapshots.
  const libraryNodes = index ? index.hardware(/^Gpu/i, (n) => (!gpu || n !== gpu.name) && (!dgpu || n !== dgpu.name)) : [];
  const igpu = snapshot?.adapters ? igpuAdapter !== null : libraryNodes.length > 0;
  return {
    nvml,
    nvapi: !!gpu && (gpu.pstateDeltas != null || gpu.units != null),
    pins: !!index && !!gpu && gpuLayout(index, gpu.name).pins.length > 0,
    igpu,
    battery: !!index && index.hardware(/^Battery$/i).length > 0,
    laptop,
    dynamicBoost: laptop && !!gpu && gpu.powerMaxLimitMw > gpu.powerLimitMw,
    npu: !!snapshot && NPU_CPU.test(snapshot.cpu.name),
    arm64: !!snapshot && ARM64_CPU.test(snapshot.cpu.name),
    dgpu,
    igpuAdapter
  };
}

/** Every flag off: what a page shows before the first sample. */
export const NO_CAPS: Caps = { nvml: false, nvapi: false, pins: false, igpu: false, battery: false, laptop: false, dynamicBoost: false, npu: false, arm64: false, dgpu: null, igpuAdapter: null };
