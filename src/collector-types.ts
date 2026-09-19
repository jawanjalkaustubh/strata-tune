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
   * The memory offset is what the driver says, counted on the effective data rate like the
   * vendor sliders (a +2036 NVML MHz P0 delta reads +4072 here); thisCard.ts nvmlMemOffsetMhz
   * halves it before it meets an NVML clock.
   */
  clockOffsets: { smMhz: number | null; memMhz: number | null; maxClockSmMhz: number | null; maxClockMemMhz: number | null } | null;
  /**
   * The P0 offsets NVAPI reports (NvAPI_GPU_GetPstates20, the route GPU Tweak III and
   * Afterburner apply through), so the audit's OC row can show an offset that clockOffsets
   * reads as 0. Null without nvapi64.dll or the interface. Optional because saved snapshots
   * from before 2026-09-16 have no such key; the live wire always carries it.
   */
  pstateDeltas?: PstateDeltas | null;
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
  /** 'cancelled' is Stop (POST /load/{id}/cancel, plan section 17c): the process was killed, the samples taken until then are kept, no error is recorded. */
  state: 'running' | 'done' | 'failed' | 'cancelled';
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
 * The state machine as trimmed on 2026-09-16: IDLE (nothing of Tune's is on the card) →
 * PENDING (a rung is on the card; on disk before the apply) → IDLE. REVERTED is only the
 * attribution shown after a crash, which rung was on the card when the machine or the
 * collector died, until the next run starts.
 */
export type TuneRollback = 'IDLE' | 'PENDING' | 'REVERTED';
/** hunt is the memory ladder then the core ladder, each from the card as found; core and memory run one ladder alone. */
export type TuneRunKind = 'hunt' | 'core' | 'memory';
export type TuneLadderKind = 'core' | 'memory';
export type TuneRunState = 'running' | 'done' | 'failed' | 'stopped';
/**
 * The two halves of a rung (plan section 16, 'a rung is a minute of realistic load'): variable
 * is 30 s of heavy bursts 2–4 s apart with light or idle gaps, hash-checked on every burst;
 * sustained is 30 s of full load, hash-checked on every dispatch, whose throughput and
 * closing stream pass are the rung's score.
 */
export type TunePattern = 'variable' | 'sustained';
/**
 * reference is the stock hash; as-found the two-minute scored run of the card with nothing
 * written; vendor the user's tune written through our route; climb and bisect the rungs;
 * official the two-minute scored run of the certified pair; restore puts the baseline back;
 * holds-now reads what the card holds after that.
 */
export type TunePhase = 'reference' | 'as-found' | 'vendor' | 'climb' | 'bisect' | 'official' | 'restore' | 'holds-now';
/** Per rung: 'invalid' means the rung says nothing about the silicon (the cooler limited it, the repeats disagreed, another tool wrote the offsets). */
export type TuneVerdict = 'stable' | 'unstable' | 'invalid' | 'device-lost';
/** 'throttled' is a thermal-limit bit under the sustained half (the cooler is the limit); a power cap is the normal state and never sets it. */
export type TuneValidity = 'ok' | 'throttled' | 'unknown';
export type TuneConfidence = 'high' | 'medium' | 'low';
/**
 * Why a ladder ended: hash, throughput / bandwidth and device-lost are the failure ladder's
 * stages 1–3; thermal is the cooler; inconsistent a scored run whose repeats disagreed;
 * foreign-tune a vendor tool's tune found on the card before anything was written (our
 * route would replace it, so nothing was) with no value entered for it; vendor-mismatch a
 * value entered that the card as found does not bear out (also before anything was
 * written); additivity a first rung the driver did not add on top of the card as found;
 * driver-max and ceiling the driver's offset range and clock ceiling; cap the request's
 * rung limit; top-of-table a core ladder whose offsets move neither the top of the curve, the
 * sustained clock nor the throughput (plan section 16: the card already runs at the top of its
 * clock table, certified +0 core, a result and not a failure); user-cap the user's own
 * "never test above" clock.
 */
export type TuneStopReason = 'hash' | 'throughput' | 'bandwidth' | 'device-lost' | 'thermal' | 'inconsistent' | 'foreign-tune' | 'vendor-mismatch' | 'additivity' | 'driver-max' | 'ceiling' | 'cap' | 'top-of-table' | 'user-cap';

/** NVAPI's P0 frequency deltas in kHz (exact, what a revert restores) with the MHz pair the page shows. */
export interface TuneDeltas {
  coreKhz: number;
  memKhz: number;
  coreMhz: number;
  memMhz: number;
}

/**
 * A core / memory pair in MHz, exactly the C# PstateDeltas record: P0 offsets as NVAPI reports
 * them, a result's certified offsets, or a vendor tool's values in its slider's units
 * (src/analysis/tune.ts vendorSlider / vendorDeltas convert between ours and theirs).
 */
export interface PstateDeltas {
  coreMhz: number;
  memMhz: number;
}

/** The clocks NVML saw the card hold under the sustained half. */
export interface HeldClocks {
  smMhz: number;
  memMhz: number;
}

/**
 * A rung's or a scored run's points on the fixed scale of plan section 16 (a reference RTX
 * 5090 at reference clocks = 10,000, half compute and half bandwidth; the constants and their
 * arithmetic are in src/analysis/tune.ts): the total, its two halves, and the measured
 * figures they came from.
 */
export interface TuneScore {
  points: number;
  computePoints: number;
  bandwidthPoints: number;
  throughputGsps: number;
  bandwidthGBs: number;
}

/** Average and peak of one telemetry figure over a scored run's samples. */
export interface TelemetryStat {
  avg: number;
  max: number;
}

/**
 * The GPU over a scored run, from the flight recorder's 2 Hz samples: what the .html comparison
 * sheet tabulates (plan section 16). A figure this card does not report is null and the sheet
 * leaves its row out; `limitShare` is the share of samples under each decoded NVML limit reason.
 */
export interface GpuTelemetry {
  coreMhz: TelemetryStat;
  memMhz: TelemetryStat;
  coreC: TelemetryStat;
  hotspotC: TelemetryStat | null;
  memoryJunctionC: TelemetryStat | null;
  boardW: TelemetryStat;
  powerCapW: number;
  limitShare: Record<string, number>;
  fanPercent: TelemetryStat | null;
}

/** The CPU over the same samples; null on a box where the library does not read the CPU (no PawnIO, ARM64). */
export interface CpuTelemetry {
  effectiveMhz: TelemetryStat | null;
  packageW: TelemetryStat | null;
  tctlC: TelemetryStat | null;
}

export interface TelemetrySummary {
  samples: number;
  seconds: number;
  gpu: GpuTelemetry | null;
  cpu: CpuTelemetry | null;
}

/**
 * A scored run: the as-found card (two minutes, nothing written) or the official run of the
 * certified pair. `repeats` is how many times the 60 s shape ran; `score` is null when the run
 * failed a stage; `held` the peak clocks under the sustained halves, `topSmMhz` under the
 * variable halves; `steppedDown` marks an official run re-run one fine step lower after a failure.
 */
export interface ScoredRun {
  deltas: TuneDeltas;
  repeats: number;
  verdict: TuneVerdict;
  score: TuneScore | null;
  held: HeldClocks | null;
  topSmMhz: number | null;
  note: string;
  telemetry: TelemetrySummary | null;
  steppedDown: boolean;
  /** The sustained halves' mean SM clock: what a core offset moves on a power-capped card when the top of the curve cannot (plan section 16); optional because results saved before 2026-09-17 have no such key. */
  meanSmMhz?: number | null;
}

/** How one ladder ended: the offset (MHz above the baseline P0 delta) it stopped at, the failure-ladder stage when the reason is one, and the sentence. */
export interface TuneLadderStop {
  ladder: TuneLadderKind;
  reason: TuneStopReason;
  offsetMhz: number;
  stage: number | null;
  note: string;
}

export interface TuneReverted {
  candidate: TuneDeltas;
  baseline: TuneDeltas;
  at: string;
  reason: string;
  /** 4: a hard hang, the ladder's last stage. */
  stage: number;
}

export interface TuneHistoryEntry {
  at: string;
  state: TuneRollback;
  candidate: TuneDeltas | null;
  note: string;
}

/**
 * What a finished hunt found. `deltas` are the certified P0 offsets (the baseline plus what
 * each ladder certified; equal to the baseline when nothing above it held), `baseline` the
 * P0 offsets the run climbed from and restored: the deltas read at the start, or the user's
 * vendor tune written through our route when one was on the card (`vendor`, in the slider's
 * units, null otherwise); `certified` their difference in MHz: what goes on top in the
 * vendor tool. `baselineHeld` is the card as found under the sustained half before anything
 * was written (a vendor tool's tune inside it), `heldAtCertified` the same clocks at the
 * certified rungs; `firstFailure` the lowest rung that failed a ladder stage after the
 * bisect; `stops` how each ladder ended. `asFound` is the two-minute scored run of the card
 * before anything was written and `official` the same of the certified pair, the benchmark;
 * `holdsNow` what the card held under a short sustained load after the restore, beside
 * `baselineHeld` (plan section 16, rule 4); `rungs` every rung as tested, with its points.
 */
export interface TuneResult {
  kind: TuneRunKind;
  deltas: TuneDeltas;
  baseline: TuneDeltas;
  vendor: PstateDeltas | null;
  baselineHeld: HeldClocks | null;
  heldAtCertified: HeldClocks | null;
  firstFailure: TuneLadderStop | null;
  stops: TuneLadderStop[];
  bandwidthGBs: number | null;
  referenceHash: string;
  confidence: TuneConfidence;
  foundAt: string;
  certified: PstateDeltas;
  asFound: ScoredRun | null;
  official: ScoredRun | null;
  holdsNow: HeldClocks | null;
  rungs: TuneCandidate[];
}

/**
 * One rung as tested. `held` is the sustained half's peak SM / memory clock; `topSmMhz` the
 * peak SM clock under the variable half (the top of the curve, where a core offset shows
 * without the power cap in the way); `throughputGsps` the sustained half's hash-kernel
 * throughput, the figure a core rung must not lower; `throttledFraction` the share of
 * sustained samples with any limit bit, shown because a power cap is normal, never a verdict;
 * `score` the rung's points (null when it failed before its sustained half finished).
 */
export interface TuneCandidate {
  ladder: TuneLadderKind;
  deltas: TuneDeltas;
  verdict: TuneVerdict;
  /** Failure-ladder stage that tripped (1 hash, 2 throughput or bandwidth, 3 driver reset); null for stable and invalid. */
  stage: number | null;
  failedPattern: TunePattern | null;
  held: HeldClocks | null;
  topSmMhz: number | null;
  throughputGsps: number | null;
  bandwidthGBs: number | null;
  throttledFraction: number;
  note: string;
  score: TuneScore | null;
  /** The sustained half's mean SM clock (the whole 30 s averaged), the second additivity signal when the top of the curve does not move; optional as above. */
  meanSmMhz?: number | null;
}

/** The live run: GET /tune/state `run` and the SSE `tune` event at 2 Hz while Tune is enabled or a run is going. */
export interface TuneRun {
  id: string;
  kind: TuneRunKind;
  state: TuneRunState;
  startedAt: string;
  elapsedS: number;
  phase: TunePhase;
  ladder: TuneLadderKind | null;
  candidate: TuneDeltas | null;
  stage: number | null;
  pattern: TunePattern | null;
  patternElapsedS: number;
  patternSeconds: number;
  deviceLostCount: number;
  errorCount: number;
  bandwidthGBs: number | null;
  bestBandwidthGBs: number | null;
  /** The card as found, known once the as-found scored run has run. */
  baselineHeld: HeldClocks | null;
  validity: TuneValidity;
  lastEvent: string;
  candidates: TuneCandidate[];
  result: TuneResult | null;
  error: string | null;
  /** Which repeat of the 60 s shape a scored run is on (1-based); 0 outside one. */
  repeat: number;
  /** The as-found scored run once it is done, before any ladder has a result. */
  asFound: ScoredRun | null;
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
  /** Set when a start found a crash: which rung did it. */
  reverted: TuneReverted | null;
  result: TuneResult | null;
  history: TuneHistoryEntry[];
  nvapi: TuneNvapi;
  run: TuneRun | null;
  /** GET /tune/flight has a last-crash file. */
  flightAvailable: boolean;
  stateFile: string;
  /** What stops Tune altogether (the state folder could not be restricted, the file does not parse, another user's collector owns it), or null. */
  problem: string | null;
  /** "About 16 minutes": what a full hunt takes on a typical card, shown before Start (src/analysis/tune.ts estimateMinutes refines it per kind). */
  estimateMinutes: number;
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
  /** At most this many rungs tried per ladder (the baseline rung not counted), then the ladder ends unconverged (a bounded smoke test); absent is unlimited. */
  maxCandidates?: number;
  /**
   * What the user's vendor tool shows (plan section 16): core in MHz, memory in the slider's
   * effective-rate units (src/analysis/tune.ts vendorForStart builds it from the settings). A
   * tune found on the card by a route our P0 write would replace is reproduced through our
   * route from this, climbed from and restored, never zeroed; without it such a card is
   * refused before anything is written ('foreign-tune'); a value the card does not bear out
   * is refused too ('vendor-mismatch').
   */
  vendor?: PstateDeltas;
  /**
   * "Never test above __ MHz" (plan section 16, the user's own caution for a night run): a rung
   * whose predicted top-of-curve SM clock (core) or memory clock would exceed the cap is not
   * written and the ladder ends with "stopped at your cap". Absent is no cap.
   */
  coreCapMhz?: number;
  memCapMhz?: number;
}

/** GET /tune/export: the value set to type into the vendor tool, in our units and in the sliders' units; `sliderTotal` is the whole tune to set when the hunt climbed on top of the user's vendor tune, null from stock. */
export interface TuneExport {
  certified: PstateDeltas;
  vendorSlider: PstateDeltas;
  sliderTotal: PstateDeltas | null;
  baselineHeld: HeldClocks | null;
  heldAtCertified: HeldClocks | null;
  firstFailure: TuneLadderStop | null;
  text: string;
  confidence: TuneConfidence;
  measuredAt: string;
  /** The vendor tool's own values the run climbed on top of (slider units), null from stock. */
  vendor: PstateDeltas | null;
  /** The official scored run of the certified pair: the benchmark and its telemetry for the .html sheet. */
  score: ScoredRun | null;
  /** The as-found card, scored the same way first. */
  asFound: ScoredRun | null;
  referencePoints: number;
  /** Every rung as tested, with its points: the ladder as a score climb. */
  rungs: TuneCandidate[];
  /** What the card held after the restore, beside `baselineHeld`; null when the run did not get to measure it. */
  holdsNow: HeldClocks | null;
}

export interface TuneHealth {
  state: TuneRollback;
  reverted: TuneReverted | null;
  runActive: boolean;
  /** Set while a run's baseline could not be put back: the rung may still be on the card. */
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

// ---- Timers (plan sections 8 and 17): GET /timers, the About hub's Timers tool and the audit's timer-resolution rule ----

/**
 * One outstanding timer-resolution request as powercfg's energy trace lists it; `own` marks
 * this app's own processes (Chromium raises the timer while it animates), so the audit never
 * names Strata Tune as the background app.
 */
export interface TimerRequester {
  pid: number;
  name: string;
  /** The image path with its drive letter when one maps, else the NT device path; null when the trace gave none. */
  path: string | null;
  periodMs: number | null;
  own: boolean;
}

/**
 * NtQueryTimerResolution in milliseconds, named by meaning: `coarsestMs` is NT's "minimum
 * resolution" (15.625 ms, the platform default), `finestMs` its "maximum" (0.5 ms). All three
 * are null only when the kernel call failed. `qpcSource` is inferred from the counter
 * frequency Windows fixed at boot (10 MHz TSC, 14.318 MHz HPET, 3.5795 MHz ACPI PM timer);
 * `qpcNote` says how far the inference goes. `requesters` is null unless `?trace=N` ran
 * powercfg's energy report; an empty list after a trace means nobody holds the timer raised.
 */
export interface Timers {
  currentMs: number | null;
  finestMs: number | null;
  coarsestMs: number | null;
  qpcFrequency: number;
  qpcSource: string;
  qpcNote: string;
  requesters: TimerRequester[] | null;
  requestersNote: string | null;
}
