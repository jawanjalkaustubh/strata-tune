/**
 * Whole-system power (master plan §13), the Phase 1 headline number: the two
 * measured figures the collector already has, plus flat per-device models for
 * what nothing measures. Every part carries its tag, and the UI shows the split.
 * Wall-side efficiency waits for Phase 6's psu.json.
 */

export interface SystemPowerInputs {
  /** LHM "Package": MSR energy delta on Zen 4/5, core + SoC. */
  cpuPackageW?: number;
  /** NVML board power. */
  gpuBoardW?: number;
  dimmCount: number;
  /** Current queue depth per physical disk; an absent counter reads as idle. */
  diskQueues: number[];
  /** Fans and pumps reporting rpm > 0. */
  spinningFans: number;
}

export type PowerTag = 'measured' | 'estimated';

export interface PowerPart {
  label: string;
  watts: number;
  tag: PowerTag;
}

export interface SystemPower {
  parts: PowerPart[];
  measuredW: number;
  estimatedW: number;
  totalW: number;
}

/** DDR5 UDIMM: 2.5 W idle to 5 W loaded; without a bandwidth counter the midpoint is the estimate. */
const DIMM_W = 3.5;
/** NVMe: 0.5 W idle, 6 W busy, weighted by queue depth (one outstanding request counts as busy). */
const DISK_IDLE_W = 0.5;
const DISK_ACTIVE_W = 6;
const FAN_W = 2;
/** Chipset(s), VRM losses, USB, audio, RGB, network: one flat figure until Phase 6's board table. */
const BOARD_W = 25;

export function systemPower(i: SystemPowerInputs): SystemPower {
  const parts: PowerPart[] = [];
  if (i.cpuPackageW !== undefined && Number.isFinite(i.cpuPackageW)) parts.push({ label: 'CPU package', watts: i.cpuPackageW, tag: 'measured' });
  if (i.gpuBoardW !== undefined && Number.isFinite(i.gpuBoardW)) parts.push({ label: 'GPU board', watts: i.gpuBoardW, tag: 'measured' });
  parts.push({ label: 'Board', watts: BOARD_W, tag: 'estimated' });
  if (i.dimmCount > 0) parts.push({ label: `RAM (${i.dimmCount} DIMM)`, watts: i.dimmCount * DIMM_W, tag: 'estimated' });
  if (i.diskQueues.length > 0) {
    const drives = i.diskQueues.reduce((sum, q) => sum + DISK_IDLE_W + (DISK_ACTIVE_W - DISK_IDLE_W) * Math.min(Math.max(q, 0), 1), 0);
    parts.push({ label: `Drives (${i.diskQueues.length})`, watts: drives, tag: 'estimated' });
  }
  if (i.spinningFans > 0) parts.push({ label: `Fans (${i.spinningFans})`, watts: i.spinningFans * FAN_W, tag: 'estimated' });
  const sum = (tag: PowerTag) => parts.filter((p) => p.tag === tag).reduce((s, p) => s + p.watts, 0);
  const measuredW = sum('measured');
  const estimatedW = sum('estimated');
  return { parts, measuredW, estimatedW, totalW: measuredW + estimatedW };
}
