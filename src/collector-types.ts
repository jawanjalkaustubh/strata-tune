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
  /** A source that failed to open at start is reported here and left out of the stream, never served as zeros. */
  lhm: { available: boolean };
  pdh: { available: boolean };
  qpcFrequency: number;
  startedAt: string;
  /** Seconds since the collector started. */
  uptime: number;
  /**
   * True while the sensor groups are still being opened in the background: the collector
   * answers and streams from its first moment, and the sensor list (/sensors/meta) grows
   * until this turns false. Re-fetch the meta once it does.
   */
  warming: boolean;
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

/** GET /sensors/window?seconds=N: full-rate `rows` for N ≤ 600, `summaries` beyond; the other list is empty. */
export interface SensorWindow {
  seconds: number;
  qpcNow: number;
  rows: SensorRow[];
  summaries: SensorSummaryRow[];
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
  /** PCI subsystem ids from nvmlDeviceGetPciInfo_v3: the vendor id names the board partner (src/data/vendors.json); null when the driver did not report them. */
  pciSubsystem: { vendorId: number; deviceId: number } | null;
  /**
   * Applied overclock offsets at P0 from nvmlDeviceGetClockOffsets (NVML 12.5+), and the
   * driver's clock-table ceilings for the SM and memory clocks from nvmlDeviceGetMaxClockInfo
   * (3090 / 14001 MHz on the dev box's RTX 5090: the top of the driver's table, not the
   * board's rated boost, which lives in src/data/gpus.json). A card held above a ceiling
   * under load is overclocked by a route the offsets do not report (a vendor tool, a VF
   * curve): the dev box reads offsets 0 / 0 and holds 3226 / 16032 MHz. A driver without
   * the export gives null for the whole block; a field the card does not answer is null alone.
   */
  clockOffsets: { smMhz: number | null; memMhz: number | null; maxClockSmMhz: number | null; maxClockMemMhz: number | null } | null;
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

/** The active scheme, and on Windows 10/11 the power-mode overlay (Best performance …) the Settings slider sets on top of it. */
export interface PowerPlanInfo {
  guid: string;
  name: string;
  /** Overlay scheme GUID, lowercase; null when the API is absent or no overlay is active (the Balanced slider position). */
  overlayGuid: string | null;
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
  powerPlan: PowerPlanInfo;
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

/** 'light' and 'heavy' run the GPU worker; 'cpu' runs the all-logical-CPU vector FMA (logistic map) kernel and leaves the GPU alone. */
export type LoadKind = 'light' | 'heavy' | 'cpu';

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
  /** GPU facts sampled at 2 Hz for the duration, so the caller can judge the steady window (t ≥ 3 s) against the start. */
  gpuSamples: { qpc: number; smMhz: number; memMhz: number; powerMw: number; temperatureC: number; clocksEventReasons: number; pcieGen: number; pcieWidth: number }[];
  /**
   * The CPU at 2 Hz from LibreHardwareMonitor for a 'cpu' run (empty for the GPU kinds). The
   * first sample is taken before the worker starts, so it is the idle reference. A sensor
   * the box does not expose reads NaN on the wire as null.
   */
  cpuSamples: { qpc: number; packageW: number | null; tctlC: number | null; avgEffectiveMhz: number | null; maxCoreMhz: number | null }[];
  error: string | null;
}

/** One SSE `tick` event, 2 Hz, on GET /stream. */
export interface Tick {
  qpc: number;
  sensors: Record<string, number>;
  gpu: GpuFacts[];
  /** Health.warming, on every tick, so a client sees the moment the sensor list is complete. */
  warming: boolean;
}
