/**
 * Wire contract between the elevated .NET collector and the UI (master plan §5–§7).
 * The C# records in collector/StrataTune.Shared serialise to exactly these shapes
 * (System.Text.Json, camelCase). Change both sides together.
 *
 * Timestamps are raw QueryPerformanceCounter ticks (Stopwatch.GetTimestamp on the
 * collector side); `qpcFrequency` in Health converts them. Nothing here is wall-clock
 * except Health.startedAt, which is only for display.
 */

export interface Health {
  ok: boolean;
  pid: number;
  version: string;
  elevated: boolean;
  pawnIo: { installed: boolean; version: string | null };
  nvml: { available: boolean; driver: string | null };
  qpcFrequency: number;
  startedAt: string;
  /** Seconds since the collector started. */
  uptime: number;
}

/** Written by the collector to %LOCALAPPDATA%\Strata Tune\collector.json once it is listening. */
export interface Handshake {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export type SensorType =
  | 'Voltage' | 'Current' | 'Power' | 'Clock' | 'Temperature' | 'Load' | 'Frequency' | 'Fan'
  | 'Flow' | 'Control' | 'Level' | 'Factor' | 'Data' | 'SmallData' | 'Throughput' | 'TimeSpan'
  | 'Timing' | 'Energy' | 'Noise' | 'Conductivity' | 'Humidity';

export interface SensorMeta {
  /** Stable per machine, e.g. "/amdcpu/0/power/0" or "/nvml/0/clocks/sm". Never the name. */
  id: string;
  /** Hardware node the sensor belongs to, e.g. "/amdcpu/0" or "/lpc/nct6687dr/0". */
  hardware: string;
  hardwareName: string;
  hardwareType: string;
  name: string;
  sensorType: SensorType;
  unit: string;
}

/** One row of the sensor stream: every subscribed sensor at one instant. */
export interface SensorRow {
  qpc: number;
  /** Sensor id → value. Missing keys mean "no reading this tick". */
  values: Record<string, number>;
}

/** 1 Hz fold of older full-rate rows (plan §6: ring buffer sized by time). */
export interface SensorSummaryRow {
  qpcStart: number;
  qpcEnd: number;
  min: Record<string, number>;
  max: Record<string, number>;
  mean: Record<string, number>;
}

export interface GpuFacts {
  index: number;
  name: string;
  driver: string;
  pcie: { currentGen: number; currentWidth: number; maxGen: number; maxWidth: number; gpuMaxGen: number };
  bar1TotalMiB: number;
  vram: { totalMiB: number; usedMiB: number };
  powerMw: number;
  powerLimitMw: number;
  powerMaxLimitMw: number;
  clocks: { smMhz: number; memMhz: number };
  temperatureC: number;
  utilisation: { gpu: number; memory: number };
  /** Raw NVML clocks-event-reasons bitmask plus the decoded known bits; unknown bits stay in `raw`. */
  clocksEventReasons: { raw: number; names: string[] };
}

export interface RamModule {
  slot: string;          // Win32_PhysicalMemory.DeviceLocator, e.g. "DIMMA2"
  partNumber: string;    // trimmed
  manufacturer: string;
  capacityMiB: number;
  configuredMts: number; // ConfiguredClockSpeed
  reportedMts: number;   // Speed (configured on many boards, not SPD — see dependencies.md)
}

export interface PhysicalDisk {
  deviceId: string;      // MSFT_PhysicalDisk.DeviceId ("0", "1", …)
  friendlyName: string;
  mediaType: 'HDD' | 'SSD' | 'SCM' | 'Unspecified';
  busType: string;       // "NVMe", "SATA", "USB", …
  sizeBytes: number;
}

export interface Volume {
  letter: string;        // "C"
  label: string;
  fileSystem: string;
  sizeBytes: number;
  freeBytes: number;
  isBoot: boolean;
  /** PhysicalDisk.deviceId this volume lives on, when the mapping is known. */
  diskDeviceId: string | null;
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
}

/** Captured once per session (plan §6 `snapshot`, inputs for the §8 audit). */
export interface StaticSnapshot {
  capturedAt: string;
  os: { caption: string; build: string; };
  chassis: { isLaptop: boolean; chassisTypes: number[] };
  cpu: { name: string; family: number; model: number; cores: number; logical: number; maxClockMhz: number };
  motherboard: { manufacturer: string; product: string; biosVersion: string; biosDate: string };
  ram: { totalMiB: number; modules: RamModule[] };
  gpus: GpuFacts[];
  gpuDriver: { version: string; date: string | null };
  powerPlan: { guid: string; name: string };
  disks: PhysicalDisk[];
  volumes: Volume[];
  /** Models Ollama currently holds in memory (http://127.0.0.1:11434/api/ps), or null if Ollama is not running. */
  ollama: OllamaModel[] | null;
}

/** Per-process idle sample for the "background hogs" check. */
export interface ProcessSample {
  pid: number;
  name: string;
  cpuPercent: number;    // 0–100 of the whole machine over the sample window
  workingSetMiB: number;
}

export interface HogsResult {
  seconds: number;
  logicalCpus: number;
  processes: ProcessSample[];  // sorted by cpuPercent desc, own processes excluded
}

export type LoadKind = 'light' | 'heavy';

export interface LoadRunRequest {
  kind: LoadKind;
  seconds: number;
}

export interface LoadRun {
  id: string;
  kind: LoadKind;
  seconds: number;
  state: 'running' | 'done' | 'failed';
  /** Worker exit code once finished; 0 ok, 3 no hardware GPU, 10 device lost. */
  exitCode: number | null;
  qpcStart: number;
  qpcEnd: number | null;
  /** GPU facts sampled at 2 Hz for the duration, so the caller can compare t=2 s against t=20 s. */
  gpuSamples: { qpc: number; smMhz: number; memMhz: number; powerMw: number; temperatureC: number; clocksEventReasons: number; pcieGen: number; pcieWidth: number }[];
  error: string | null;
}

/** One SSE `tick` event, 2 Hz, on GET /stream. */
export interface Tick {
  qpc: number;
  sensors: Record<string, number>;
  gpu: GpuFacts[];
}
