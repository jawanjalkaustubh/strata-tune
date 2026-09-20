/**
 * GET /snapshot on macOS: what WMI, SMBIOS and NVML give the Windows collector, from sysctl,
 * system_profiler, diskutil, df, pmset and IOKit. The Apple GPU is listed as a display adapter
 * (vendor "apple", not integrated) whose "dedicated" memory is Metal's recommended working
 * set: the share of unified memory the GPU may hold, which is what a model's fit is judged by.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { BatteryInfo, DisplayAdapter, OllamaModel, PhysicalDisk, StaticSnapshot, Volume } from '../../src/collector-types';
import type { BatteryReading } from './sensors';

const MIB = 1024 ** 2;

export interface WorkerInfo {
  device: string;
  luid: string;
  unified: boolean;
  recommendedMaxWorkingSetBytes: number;
  maxBufferBytes: number;
}

export interface SnapshotDeps {
  /** The Metal device from the worker's --info, or null when the worker is not built. */
  workerInfo: () => Promise<WorkerInfo | null>;
  battery: () => Promise<BatteryReading | null>;
  /** The chip's top P-core clock (macmon's soc info), 0 when unknown. */
  maxClockMhz: () => number;
  /** The GPU as the collector names it (with its core count), plus what Apple does not publish and macOS knows. */
  gpu: () => { name: string; cores: number | null; maxClockMhz: number | null };
  ollamaUrl?: string;
}

function run(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 8 * MIB }, (err, out) => resolve(err ? '' : String(out))));
}

/** `diskutil info X` as key/value lines ("   Disk Size:   2.0 TB (2001111162880 Bytes) ..."). */
export function parseDiskutil(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s+([^:]+?):\s+(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const bytesOf = (s: string | undefined): number => {
  const m = /\((\d+) Bytes\)/.exec(s ?? '');
  return m ? Number(m[1]) : 0;
};

/** `df -kP`: the APFS boot volume and anything mounted under /Volumes; system snapshots and the VM volume are left out. */
export function parseDf(text: string): { device: string; sizeBytes: number; freeBytes: number; mount: string }[] {
  const out: { device: string; sizeBytes: number; freeBytes: number; mount: string }[] = [];
  for (const line of text.split('\n').slice(1)) {
    const m = /^(\/dev\/\S+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/.exec(line);
    if (!m) continue;
    const mount = m[4].trim();
    if (mount !== '/' && !mount.startsWith('/Volumes/')) continue;
    out.push({ device: m[1], sizeBytes: Number(m[2]) * 1024, freeBytes: Number(m[3]) * 1024, mount });
  }
  return out;
}

/** pmset's power mode: 0 automatic, 1 low power, 2 high power (only on the Max/Ultra MacBook Pros). */
export function powerModeOf(pmsetText: string): { guid: string; name: string } {
  const m = /\bpowermode\s+(\d)/.exec(pmsetText);
  const n = m ? Number(m[1]) : -1;
  const name = n === 1 ? 'Low Power' : n === 2 ? 'High Power' : n === 0 ? 'Automatic' : 'Unknown';
  return { guid: n >= 0 ? `macos-powermode-${n}` : '', name };
}

async function ollamaResident(url: string): Promise<OllamaModel[] | null> {
  try {
    const r = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = (await r.json()) as { models?: { name?: string; model?: string; size?: number; size_vram?: number }[] };
    return (j.models ?? []).map((m) => ({ name: String(m.name ?? m.model ?? ''), sizeBytes: m.size ?? 0, sizeVramBytes: m.size_vram ?? 0 }));
  } catch {
    return null;
  }
}

async function disks(): Promise<PhysicalDisk[]> {
  const list = await run('diskutil', ['list', 'physical']);
  const ids = [...list.matchAll(/^\/dev\/(disk\d+)/gm)].map((m) => m[1]);
  const out: PhysicalDisk[] = [];
  for (const id of ids) {
    const info = parseDiskutil(await run('diskutil', ['info', id]));
    const size = bytesOf(info['Disk Size']);
    if (!size) continue;
    out.push({
      deviceId: id,
      friendlyName: info['Device / Media Name'] || info['Media Name'] || id,
      mediaType: info['Solid State'] === 'Yes' ? 'SSD' : info['Solid State'] === 'No' ? 'HDD' : 'Unspecified',
      busType: info['Protocol'] || 'Unknown',
      sizeBytes: size
    });
  }
  return out;
}

async function volumes(): Promise<Volume[]> {
  const rows = parseDf(await run('df', ['-kP']));
  const out: Volume[] = [];
  for (const r of rows) {
    const info = parseDiskutil(await run('diskutil', ['info', r.device]));
    const store = /^(disk\d+)/.exec(info['APFS Physical Store'] ?? '')?.[1] ?? null;
    out.push({
      letter: r.mount,
      label: info['Volume Name'] || (r.mount === '/' ? 'Macintosh HD' : path.basename(r.mount)),
      fileSystem: info['File System Personality'] || 'APFS',
      sizeBytes: bytesOf(info['Container Total Space']) || r.sizeBytes,
      freeBytes: bytesOf(info['Container Free Space']) || r.freeBytes,
      isBoot: r.mount === '/',
      diskDeviceId: store
    });
  }
  return out;
}

export async function macSnapshot(deps: SnapshotDeps): Promise<StaticSnapshot> {
  const [sysctl, profilerJson, pmset, worker, battery, physical, vols, resident] = await Promise.all([
    run('sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.physicalcpu', 'hw.logicalcpu', 'hw.memsize', 'hw.model', 'kern.osproductversion', 'kern.osversion']),
    run('system_profiler', ['SPHardwareDataType', '-json'], 15_000),
    run('pmset', ['-g']),
    deps.workerInfo(),
    deps.battery(),
    disks(),
    volumes(),
    ollamaResident(deps.ollamaUrl ?? 'http://127.0.0.1:11434')
  ]);
  const [cpuName = 'Apple Silicon', physicalcpu = '0', logicalcpu = '0', memsize = '0', model = '', osVersion = '', osBuild = ''] = sysctl.split('\n').map((l) => l.trim());
  let profiler: Record<string, string> = {};
  try {
    profiler = (JSON.parse(profilerJson) as { SPHardwareDataType?: Record<string, string>[] }).SPHardwareDataType?.[0] ?? {};
  } catch {
    /* system_profiler absent or slow: the sysctl facts stand */
  }
  // sysctl first: from a Finder-launched process system_profiler has answered "Mac" / "Unknown" (2026-09-20).
  const generic = (v: string | undefined) => !v || /^(Mac|Unknown)$/i.test(v.trim());
  const machineName = generic(profiler.machine_name) ? model : profiler.machine_name;
  const chip = generic(cpuName) ? (generic(profiler.chip_type) ? 'Apple Silicon' : profiler.chip_type) : cpuName;
  const totalMiB = Number(memsize) / MIB;
  // Without the worker, Apple's default GPU wired limit: about three quarters of unified memory on 36 GB+ machines, two thirds below.
  const workingSetMiB = worker ? worker.recommendedMaxWorkingSetBytes / MIB : Math.round(totalMiB * (totalMiB >= 36 * 1024 ? 0.75 : 0.667));
  const gpu = deps.gpu();
  const adapter: DisplayAdapter = {
    name: gpu.name,
    vendor: 'apple',
    dedicatedMiB: Math.round(workingSetMiB),
    driverVersion: `Metal (macOS ${osVersion})`,
    driverDate: null,
    integrated: false,
    ...(gpu.cores ? { cores: gpu.cores } : {}),
    ...(gpu.maxClockMhz ? { maxClockMhz: gpu.maxClockMhz } : {})
  };
  const batteryInfo: BatteryInfo = battery ? { present: true, onAc: battery.onAc, percent: battery.percent } : { present: false, onAc: true, percent: null };
  return {
    capturedAt: new Date().toISOString(),
    os: { caption: `macOS ${osVersion}`, build: osBuild },
    chassis: { isLaptop: /MacBook/i.test(machineName) || batteryInfo.present, chassisTypes: [] },
    cpu: { name: chip, family: 0, model: 0, cores: Number(physicalcpu), logical: Number(logicalcpu), maxClockMhz: deps.maxClockMhz() },
    motherboard: { manufacturer: 'Apple', product: `${machineName} (${model})`, biosVersion: profiler.boot_rom_version || '', biosDate: '' },
    ram: { totalMiB: Math.round(totalMiB), modules: [{ slot: 'Unified', partNumber: '', manufacturer: 'Apple', capacityMiB: Math.round(totalMiB), configuredMts: 0, reportedMts: 0 }] },
    gpus: [],
    gpuDriver: { version: adapter.driverVersion, date: null },
    powerPlan: { ...powerModeOf(pmset), overlayGuid: null },
    disks: physical,
    volumes: vols,
    ollama: resident,
    adapters: [adapter],
    battery: batteryInfo
  };
}
