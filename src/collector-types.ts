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
  /** Tune's rollback state, so a crash revert shows in the status pill; absent until the store has opened. */
  tune?: TuneHealth | null;
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
  /**
   * nvmlDeviceGetPowerManagementDefaultLimit: the board's default limit, its TDP (575 W on a
   * Founders Edition 5090, 600 W on the Astral), where powerMaxLimitMw is the top of the
   * slider. 0 when the card answers NOT_SUPPORTED; optional because saved snapshots from
   * before 2026-09-16 have no such key.
   */
  powerDefaultLimitMw?: number;
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
  /**
   * The P0 offsets NVAPI reports (NvAPI_GPU_GetPstates20, the route GPU Tweak III and
   * Afterburner apply through), so the audit's OC row can show an offset that clockOffsets
   * reads as 0. Null without nvapi64.dll or the interface. Optional because saved snapshots
   * from before 2026-09-16 have no such key; the live wire always carries it.
   */
  pstateDeltas?: { coreMhz: number; memMhz: number } | null;
  /**
   * Unit counts NVML never reports, read once per session through NVAPI (the way GPU-Z and
   * HWiNFO read them) and matched to this device by PCI bus. `shaders`
   * (NvAPI_GPU_GetGpuCoreCount) and `rops` (NvAPI_GPU_GetROPCount, a private interface id)
   * are direct reads. `sms` is NvAPI_GPU_GetTotalSMCount when the driver answers it, else
   * the TPC count (NvAPI_GPU_GetShaderSubPipeCount) times the architecture's SMs per TPC;
   * `tmus` is the SM count times the architecture's texture units per SM (two SMs of four
   * TMUs per TPC since Volta, one of eight on Maxwell and Pascal), so those two are derived
   * and null on older or unknown architectures. A call the driver refused is null, never 0, so
   * a missing-ROPs verdict (audit rule gpu-units) is only ever drawn from a real reading;
   * the whole block is null when nvapi64.dll is absent or NVAPI did not list the card. The
   * dev box reads 21760 / 170 / 176 / 680 on the RTX 5090. Optional because saved sessions
   * and audits recorded before 2026-09-16 have no such key; the live wire always carries it.
   */
  units?: { shaders: number | null; sms: number | null; rops: number | null; tmus: number | null; source: 'nvapi' } | null;
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

/**
 * 'light' and 'heavy' run the GPU worker; 'cpu' runs the all-logical-CPU vector FMA (logistic
 * map) kernel and leaves the GPU alone; 'fillrate' runs the bench's --fillrate mode (full-screen
 * quads as fast as the card writes pixels) with the GPU sampled at 2 Hz like the worker kinds,
 * so the pixel rate can be paired with the SM clock it was measured at (src/analysis/gpuUnits.ts).
 */
export type LoadKind = 'light' | 'heavy' | 'cpu' | 'fillrate';

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
  /**
   * The bench's one JSON line for a finished 'fillrate' run: pixels written per wall second
   * over `seconds` of measurement (a 1 s warm-up is not counted), the frames that made them
   * and the offscreen target they were drawn into. Null for every other kind, and for a
   * fill-rate run that failed before printing it; optional because runs saved before
   * 2026-09-16 have no such key, while the live wire always carries it.
   */
  fillRate?: { pixelsPerSecond: number; seconds: number; frames: number; width: number; height: number } | null;
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

// ---- OC auto-tune (plan section 16): GET /tune/state, the SSE 'tune' event, the state file ----

/**
 * The rollback state machine. PENDING is on disk before any apply; VALIDATING is a kept
 * result waiting for one clean shutdown and a start; KNOWN_GOOD is the only state in which
 * nothing of Tune's is on the card; REVERTED says the last start found a candidate applied
 * without a clean shutdown and put the baseline back.
 */
export type TuneRollback = 'KNOWN_GOOD' | 'PENDING' | 'VALIDATING' | 'REVERTED';
export type TuneRunKind = 'core' | 'memory' | 'validate';
export type TuneRunState = 'running' | 'done' | 'failed' | 'stopped';
export type TunePattern = 'heavy' | 'light' | 'transient';
export type TunePhase = 'reference' | 'coarse' | 'bisect' | 'sweep' | 'validate' | 'restore';
/** Per candidate: 'invalid' means a throttle bit was set during the heavy pattern, so the rung proves nothing. */
export type TuneVerdict = 'stable' | 'unstable' | 'invalid' | 'device-lost';
export type TuneValidity = 'ok' | 'throttled' | 'unknown';
export type TuneConfidence = 'high' | 'medium' | 'low';

/** NVAPI's P0 frequency deltas in kHz (exact, what a revert restores) with the MHz pair the page shows. */
export interface TuneDeltas {
  coreKhz: number;
  memKhz: number;
  coreMhz: number;
  memMhz: number;
}

export interface TuneReverted {
  candidate: TuneDeltas;
  baseline: TuneDeltas;
  at: string;
  reason: string;
}

export interface TuneHistoryEntry {
  at: string;
  state: TuneRollback;
  candidate: TuneDeltas | null;
  note: string;
}

/**
 * What a finished hunt found, with the baseline it was measured from; `validated` flips after a
 * validate run passes, `promoted` when a kept result went through a clean shutdown and a clean
 * boot (the plan's known-good; the offsets are not re-applied after that boot). The reference
 * clocks are what NVML saw under load with nothing applied; `throttledFraction` is the share of
 * the validation's heavy samples with a limit bit set (a power-limited card passes and says so).
 */
export interface TuneResult {
  kind: TuneRunKind;
  deltas: TuneDeltas;
  baseline: TuneDeltas;
  bandwidthGBs: number | null;
  referenceHash: string;
  confidence: TuneConfidence;
  validated: boolean;
  foundAt: string;
  promoted: boolean;
  referenceSmMhz: number | null;
  referenceMemMhz: number | null;
  throttledFraction: number | null;
}

export interface TuneCandidate {
  deltas: TuneDeltas;
  verdict: TuneVerdict;
  /** Failure-ladder stage that tripped (1 hash, 2 bandwidth, 3 TDR); null for stable and invalid. */
  stage: number | null;
  failedPattern: TunePattern | null;
  bandwidthGBs: number | null;
  /** Share of the heavy pattern's samples with a power or thermal limit bit set. */
  throttledFraction: number;
  note: string;
}

/** The live run: GET /tune/state `run` and the SSE `tune` event at 2 Hz while Tune is enabled or a run is going. */
export interface TuneRun {
  id: string;
  kind: TuneRunKind;
  state: TuneRunState;
  startedAt: string;
  elapsedS: number;
  phase: TunePhase;
  candidate: TuneDeltas | null;
  stage: number | null;
  pattern: TunePattern | null;
  patternElapsedS: number;
  patternSeconds: number;
  deviceLostCount: number;
  errorCount: number;
  bandwidthGBs: number | null;
  bestBandwidthGBs: number | null;
  validity: TuneValidity;
  lastEvent: string;
  candidates: TuneCandidate[];
  result: TuneResult | null;
  error: string | null;
}

export interface TuneNvapi {
  available: boolean;
  reason: string | null;
  deltas: TuneDeltas | null;
  range: { deltas: TuneDeltas; coreMinKhz: number; coreMaxKhz: number; memMinKhz: number; memMaxKhz: number; editable: boolean } | null;
}

/** GET /tune/state, and the body of every successful POST /tune/* reply. */
export interface TuneStatus {
  enabled: boolean;
  state: TuneRollback;
  baseline: TuneDeltas | null;
  candidate: TuneDeltas | null;
  appliedAt: string | null;
  lastCleanShutdown: string | null;
  /** Set when a start found a crash: which candidate did it. */
  reverted: TuneReverted | null;
  result: TuneResult | null;
  history: TuneHistoryEntry[];
  nvapi: TuneNvapi;
  run: TuneRun | null;
  /** The logon task 'Strata Tune revert-if-pending' exists. */
  revertTaskRegistered: boolean;
  /** GET /tune/flight has a last-crash file. */
  flightAvailable: boolean;
  stateFile: string;
  /** Why the logon task is not registered (this exe's folder is writable by others), or null. */
  revertTaskProblem: string | null;
  /** What stops Tune altogether (the state folder could not be restricted, the file does not parse, another user's collector owns it), or null. */
  problem: string | null;
}

/** POST /tune/enable: on, the warning's acknowledgement travels with it (plan section 27a). */
export interface TuneEnableRequest {
  enabled: boolean;
  acknowledgedAt?: string;
  appVersion?: string;
}

/** POST /tune/start; `enabled` is the UI's own setting, checked beside the collector's file flag. */
export interface TuneStartRequest {
  kind: TuneRunKind;
  enabled: boolean;
  /** At most this many candidates tried, then the run ends unconverged (a bounded smoke test); absent is unlimited. */
  maxCandidates?: number;
}

/** GET /tune/export: the copy-pasteable Afterburner / GPU Tweak value set. */
export interface TuneExport {
  coreMhz: number;
  memMhz: number;
  baseline: { coreMhz: number; memMhz: number };
  text: string;
  validated: boolean;
  confidence: TuneConfidence;
  measuredAt: string;
}

export interface TuneHealth {
  state: TuneRollback;
  reverted: TuneReverted | null;
  runActive: boolean;
  /** Set while a run's baseline could not be put back: the candidate may still be on the card. */
  restoreFailure: string | null;
}

/**
 * One line of GET /tune/flight (application/x-ndjson): the last 30 s before a hard hang,
 * samples at 2 Hz and the ladder's events merged by time. `sensors` holds the /nvml/ and
 * /gpu-* ids only.
 */
export type FlightLine =
  | { kind: 'sample'; at: string; qpc: number; gpu: GpuFacts | null; cpu: { qpc: number; packageW: number | null; tctlC: number | null; avgEffectiveMhz: number | null; maxCoreMhz: number | null } | null; sensors: Record<string, number> }
  | { kind: 'event'; at: string; text: string; candidate: TuneDeltas | null; stage: number | null; pattern: TunePattern | null };
