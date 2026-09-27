/**
 * The macOS sensor source: macmon's JSON stream (per-core clocks and load, CPU/GPU/ANE/memory/
 * system power, GPU clock and load, fans, memory, temperatures; sudo-less on Apple Silicon)
 * plus two IOKit reads through ioreg (the GPU's memory in use, the battery). Everything is
 * shaped into LibreHardwareMonitor's names so the Monitor's layouts (src/components/monitor)
 * light up unchanged: the panels match by hardware type and sensor name, never by id.
 *
 * Time base: microseconds from process.hrtime (Health.qpcFrequency = 1e6).
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { SensorMeta, SensorRow, SensorSummaryRow, SensorType, SensorWindow } from '../../src/collector-types';

export const QPC_FREQUENCY = 1_000_000;
export const qpcNow = (): number => Number(process.hrtime.bigint() / 1000n);

export const CPU_HW = '/apple/cpu/0';
export const GPU_HW = '/apple/gpu/0';
export const ANE_HW = '/apple/ane/0';
export const SMC_HW = '/apple/smc/0';
export const MEM_HW = '/apple/memory';
export const BAT_HW = '/apple/battery/0';

/** Ids the load runner reads by name (the panels never do). */
export const IDS = {
  cpuPackageW: `${CPU_HW}/power/package`,
  cpuTempC: `${CPU_HW}/temperature/package`,
  cpuAvgEffectiveMhz: `${CPU_HW}/clock/average-effective`,
  cpuMaxCoreMhz: `${CPU_HW}/clock/max`,
  gpuClockMhz: `${GPU_HW}/clock/core`,
  gpuPowerW: `${GPU_HW}/power/core`,
  gpuTempC: `${GPU_HW}/temperature/core`,
  gpuLoad: `${GPU_HW}/load/core`,
  gpuMemUsedMiB: `${GPU_HW}/smalldata/memory-used`,
  gpuMemTotalMiB: `${GPU_HW}/smalldata/memory-total`,
  gpuCores: `${GPU_HW}/factor/cores`,
  anePowerW: `${ANE_HW}/power/ane`,
  aneCores: `${ANE_HW}/factor/cores`,
  memoryPowerW: `${SMC_HW}/power/memory`,
  memAvailableGiB: `${MEM_HW}/data/available`,
  systemW: `${SMC_HW}/power/system`
};

export interface MacmonCore {
  core_id: number;
  freq_mhz: number;
  active_ratio: number;
}

/** One line of `macmon pipe`; the fields read here (macmon 0.8). */
export interface MacmonSample {
  cpu_power: number;
  gpu_power: number;
  ane_power?: number;
  ram_power?: number;
  sys_power?: number;
  all_power?: number;
  pcpu_cores?: MacmonCore[];
  ecpu_cores?: MacmonCore[];
  gpu_freq_mhz?: number;
  gpu_active_ratio?: number;
  fans?: { name: string; rpm: number; max_rpm: number }[];
  memory?: { ram_total: number; ram_usage: number; swap_total: number; swap_usage: number };
  temp?: { cpu_temp_avg: number; gpu_temp_avg: number };
}

export interface GpuMemory {
  usedMiB: number;
  totalMiB: number;
}

/** The battery as IOKit's AppleSmartBattery reports it; watts are signed (charging positive). */
export interface BatteryReading {
  present: boolean;
  onAc: boolean;
  charging: boolean;
  percent: number;
  watts: number;
  voltageV: number;
  remainingMinutes: number | null;
  remainingMWh: number;
  fullMWh: number;
  designMWh: number;
  temperatureC: number | null;
}

interface Built {
  meta: SensorMeta[];
  values: Record<string, number>;
}

/** The chip's facts the rows carry beside the readings. */
export interface ChipFacts {
  /** The CPU node's name (the chip). */
  chip: string;
  /** The GPU node's name: the snapshot's adapter name, so the Monitor and the advisor find the same node. */
  gpuName: string;
  /** macmon's cluster labels: "P"/"E" on M1-M4, "S"/"P" (super, performance) on the M5 Pro/Max. */
  coreLabels: { high: string; low: string };
  gpuCores: number | null;
  neuralEngineCores: number | null;
}

/** Every M-series chip so far carries a 16-core Neural Engine (Apple's tech specs, M1 through M5). */
export const NEURAL_ENGINE_CORES = 16;

const CLUSTER = /^[PES]$/;

export function chipFacts(chip: string, over: Partial<ChipFacts> = {}): ChipFacts {
  const labels = over.coreLabels && CLUSTER.test(over.coreLabels.high) && CLUSTER.test(over.coreLabels.low) && over.coreLabels.high !== over.coreLabels.low ? over.coreLabels : { high: 'P', low: 'E' };
  // null means "leave the row out" (a test, a chip without one); undefined takes the M-series count.
  return { chip, gpuName: over.gpuName ?? chip, coreLabels: labels, gpuCores: over.gpuCores ?? null, neuralEngineCores: over.neuralEngineCores === undefined ? NEURAL_ENGINE_CORES : over.neuralEngineCores };
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Sensor rows from one macmon sample plus the IOKit reads. The names are LibreHardwareMonitor's
 * (cpuLayout.ts: "P-Core #n" / "E-Core #n" for a hybrid, "Package", "CPU Package",
 * "Cores (Average Effective)"; gpuLayout.ts igpuLayout: "GPU Core" clock/load/power/temperature
 * and the "GPU Memory Used/Total" rows; fans on an EmbeddedController node; the battery rows
 * BatteryPanel.tsx lists). A source that has not answered yet contributes nothing rather than zeros.
 */
export function sensorsOf(facts: string | ChipFacts, s: MacmonSample | null, gpuMem: GpuMemory | null, battery: BatteryReading | null): Built {
  const f = typeof facts === 'string' ? chipFacts(facts) : facts;
  const chip = f.chip;
  const meta: SensorMeta[] = [];
  const values: Record<string, number> = {};
  const add = (hardware: string, hardwareName: string, hardwareType: string, sensorType: SensorType, name: string, unit: string, slug: string, value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const id = `${hardware}/${sensorType.toLowerCase()}/${slug}`;
    meta.push({ id, hardware, hardwareName, hardwareType, name, sensorType, unit });
    values[id] = value;
  };
  const cpu = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(CPU_HW, chip, 'Cpu', type, name, unit, slug, v);
  const gpu = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(GPU_HW, f.gpuName, 'GpuApple', type, name, unit, slug, v);
  const ane = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(ANE_HW, 'Neural Engine', 'NeuralEngine', type, name, unit, slug, v);
  const smc = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(SMC_HW, 'Apple SMC', 'EmbeddedController', type, name, unit, slug, v);
  const mem = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(MEM_HW, 'Unified memory', 'Memory', type, name, unit, slug, v);
  const bat = (type: SensorType, name: string, unit: string, slug: string, v: number | null | undefined) => add(BAT_HW, 'Battery', 'Battery', type, name, unit, slug, v);

  if (s) {
    const byId = (cores: MacmonCore[] | undefined) => [...(cores ?? [])].sort((a, b) => a.core_id - b.core_id);
    const p = byId(s.pcpu_cores);
    const e = byId(s.ecpu_cores);
    // Clocks first, then loads, in the tree order cpuLayout expects. Cores are numbered across both
    // clusters like the library numbers an Intel hybrid (P-Core #1-#8, E-Core #9-#16): the layout keys
    // a core by its number alone.
    const pn = (i: number) => i + 1;
    const en = (i: number) => p.length + i + 1;
    const hi = f.coreLabels.high;
    const lo = f.coreLabels.low;
    p.forEach((c, i) => cpu('Clock', `${hi}-Core #${pn(i)}`, 'MHz', `p${pn(i)}`, c.freq_mhz));
    e.forEach((c, i) => cpu('Clock', `${lo}-Core #${en(i)}`, 'MHz', `e${en(i)}`, c.freq_mhz));
    const all = [...p, ...e];
    if (all.length) {
      const active = all.filter((c) => c.freq_mhz > 0);
      cpu('Clock', 'Cores (Average)', 'MHz', 'average', active.length ? active.reduce((a, c) => a + c.freq_mhz, 0) / active.length : 0);
      cpu('Clock', 'Cores (Average Effective)', 'MHz', 'average-effective', all.reduce((a, c) => a + c.freq_mhz * c.active_ratio, 0) / all.length);
      cpu('Clock', 'Cores (Max)', 'MHz', 'max', Math.max(...all.map((c) => c.freq_mhz)));
    }
    p.forEach((c, i) => cpu('Load', `${hi}-Core #${pn(i)}`, '%', `p${pn(i)}`, c.active_ratio * 100));
    e.forEach((c, i) => cpu('Load', `${lo}-Core #${en(i)}`, '%', `e${en(i)}`, c.active_ratio * 100));
    if (all.length) cpu('Load', 'CPU Total', '%', 'total', (all.reduce((a, c) => a + c.active_ratio, 0) / all.length) * 100);
    cpu('Power', 'Package', 'W', 'package', s.cpu_power);
    cpu('Temperature', 'CPU Package', '°C', 'package', s.temp?.cpu_temp_avg);

    gpu('Clock', 'GPU Core', 'MHz', 'core', s.gpu_freq_mhz);
    gpu('Load', 'GPU Core', '%', 'core', s.gpu_active_ratio === undefined ? undefined : s.gpu_active_ratio * 100);
    gpu('Power', 'GPU Core', 'W', 'core', s.gpu_power);
    gpu('Temperature', 'GPU Core', '°C', 'core', s.temp?.gpu_temp_avg);
    ane('Power', 'Neural Engine', 'W', 'ane', s.ane_power);

    (s.fans ?? []).forEach((f, i) => {
      smc('Fan', `Fan #${i + 1}`, 'RPM', `fan${i + 1}`, f.rpm);
      if (f.max_rpm > 0) smc('Control', `Fan #${i + 1}`, '%', `fan${i + 1}`, (f.rpm / f.max_rpm) * 100);
    });
    smc('Power', 'System Total', 'W', 'system', s.sys_power);
    smc('Power', 'Memory', 'W', 'memory', s.ram_power);

    if (s.memory && s.memory.ram_total > 0) {
      mem('Data', 'Memory Used', 'GB', 'used', s.memory.ram_usage / GIB);
      mem('Data', 'Memory Available', 'GB', 'available', (s.memory.ram_total - s.memory.ram_usage) / GIB);
      mem('Load', 'Memory', '%', 'load', (s.memory.ram_usage / s.memory.ram_total) * 100);
      if (s.memory.swap_total > 0) mem('Data', 'Swap Used', 'GB', 'swap', s.memory.swap_usage / GIB);
    }
  }
  if (gpuMem) {
    gpu('SmallData', 'GPU Memory Used', 'MB', 'memory-used', gpuMem.usedMiB);
    gpu('SmallData', 'GPU Memory Total', 'MB', 'memory-total', gpuMem.totalMiB);
  }
  // Counts, not readings: the SoC diagram draws one cell per core (SocDiagram.tsx).
  gpu('Factor', 'GPU Cores', '', 'cores', f.gpuCores);
  ane('Factor', 'Cores', '', 'cores', f.neuralEngineCores);
  if (battery?.present) {
    bat('Level', 'Charge Level', '%', 'charge', battery.percent);
    bat('Voltage', 'Voltage', 'V', 'voltage', battery.voltageV);
    // The library lists the rate in force (BatteryPanel.tsx), so only one of the pair exists at a time.
    if (battery.watts >= 0) bat('Power', 'Charge Rate', 'W', 'charge-rate', battery.watts);
    else bat('Power', 'Discharge Rate', 'W', 'discharge-rate', -battery.watts);
    bat('Energy', 'Remaining Capacity', 'mWh', 'remaining', battery.remainingMWh);
    bat('Energy', 'Fully-Charged Capacity', 'mWh', 'full', battery.fullMWh);
    bat('Energy', 'Designed Capacity', 'mWh', 'designed', battery.designMWh);
    if (battery.designMWh > 0) bat('Level', 'Degradation Level', '%', 'degradation', Math.max(0, (1 - battery.fullMWh / battery.designMWh) * 100));
    if (battery.remainingMinutes !== null && !battery.charging) bat('TimeSpan', 'Remaining Time (Estimated)', 's', 'remaining', battery.remainingMinutes * 60);
    bat('Temperature', 'Temperature', '°C', 'temperature', battery.temperatureC);
  }
  return { meta, values };
}

/** ioreg prints a negative Amperage as its unsigned 64-bit pattern, too big for a double: read it as a BigInt. */
export function signed64(text: string): number {
  const v = BigInt(text);
  return Number(v > 2n ** 63n ? v - 2n ** 64n : v);
}

/** `ioreg -r -c AppleSmartBattery -d 1` as text: one "Key" = value per line. Null when the class is absent (a desktop Mac). */
export function parseBattery(text: string): BatteryReading | null {
  const raw = (key: string): string | null => new RegExp(`"${key}" = (\\d+)`).exec(text)?.[1] ?? null;
  const num = (key: string): number | null => {
    const v = raw(key);
    return v === null ? null : Number(v);
  };
  const bool = (key: string): boolean => new RegExp(`"${key}" = Yes`).test(text);
  const installed = bool('BatteryInstalled');
  const voltageMv = num('Voltage');
  if (!installed || voltageMv === null) return null;
  const amperageMa = signed64(raw('InstantAmperage') ?? raw('Amperage') ?? '0');
  const voltageV = voltageMv / 1000;
  const rawNow = num('AppleRawCurrentCapacity') ?? num('CurrentCapacity') ?? 0;
  const rawFull = num('AppleRawMaxCapacity') ?? num('MaxCapacity') ?? 0;
  const design = num('DesignCapacity') ?? 0;
  const remaining = num('TimeRemaining');
  const temp = num('Temperature');
  return {
    present: true,
    onAc: bool('ExternalConnected'),
    charging: bool('IsCharging'),
    percent: num('CurrentCapacity') ?? (rawFull > 0 ? (rawNow / rawFull) * 100 : 0),
    watts: (voltageV * amperageMa) / 1000,
    voltageV,
    remainingMinutes: remaining === null || remaining >= 65535 ? null : remaining,
    remainingMWh: rawNow * voltageV,
    fullMWh: rawFull * voltageV,
    designMWh: design * voltageV,
    temperatureC: temp === null ? null : temp / 100
  };
}

/** `ioreg -r -c IOAccelerator -d 1`: the driver's "In use system memory" is what Metal has resident, the closest thing to VRAM in use. */
export function parseGpuMemoryUsed(text: string): number | null {
  const m = /"In use system memory"=(\d+)/.exec(text);
  return m ? Number(m[1]) / MIB : null;
}

/** Ten minutes of rows at full rate, then 1 s min/max/mean folds for four hours (the Windows collector's ring, plan §6). */
export class Ring {
  readonly rows: SensorRow[] = [];
  readonly summaries: SensorSummaryRow[] = [];
  private fold: SensorRow[] = [];

  constructor(private readonly fullSeconds = 600, private readonly summarySeconds = 4 * 3600) {}

  push(row: SensorRow) {
    this.rows.push(row);
    const cutoff = row.qpc - this.fullSeconds * QPC_FREQUENCY;
    while (this.rows.length && this.rows[0].qpc < cutoff) this.rows.shift();
    // One summary per wall second: the fold closes when a row lands in the next second.
    const second = (q: number) => Math.floor(q / QPC_FREQUENCY);
    if (this.fold.length && second(this.fold[0].qpc) !== second(row.qpc)) {
      this.summaries.push(summarise(this.fold));
      this.fold = [];
      const scut = row.qpc - this.summarySeconds * QPC_FREQUENCY;
      while (this.summaries.length && this.summaries[0].qpcEnd < scut) this.summaries.shift();
    }
    this.fold.push(row);
  }

  window(seconds: number, now = qpcNow()): SensorWindow {
    const from = now - seconds * QPC_FREQUENCY;
    if (seconds <= this.fullSeconds) return { seconds, qpcNow: now, rows: this.rows.filter((r) => r.qpc >= from), summaries: [] };
    return { seconds, qpcNow: now, rows: [], summaries: this.summaries.filter((s) => s.qpcEnd >= from) };
  }
}

function summarise(rows: SensorRow[]): SensorSummaryRow {
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  const sum: Record<string, number> = {};
  const n: Record<string, number> = {};
  for (const r of rows) {
    for (const [id, v] of Object.entries(r.values)) {
      min[id] = id in min ? Math.min(min[id], v) : v;
      max[id] = id in max ? Math.max(max[id], v) : v;
      sum[id] = (sum[id] ?? 0) + v;
      n[id] = (n[id] ?? 0) + 1;
    }
  }
  const mean = Object.fromEntries(Object.keys(sum).map((id) => [id, sum[id] / n[id]]));
  return { qpcStart: rows[0].qpc, qpcEnd: rows[rows.length - 1].qpc, min, max, mean };
}

export interface MacSensorsOptions {
  /** Path to macmon, or null when it is not installed: the stream then carries only the IOKit rows. */
  macmon: string | null;
  chip: string;
  /** The GPU node's name, the cluster labels and the core counts (chipFacts); the chip name alone otherwise. */
  facts?: Partial<ChipFacts>;
  /** Metal's recommended working set, the "GPU Memory Total" row; null leaves the memory rows out. */
  gpuTotalMiB: number | null;
  /**
   * The chip's facts are still being read (the collector listens before macmon's soc info and the
   * worker's --info answer): Health.warming holds until setFacts() lands, so the Monitor's last
   * sensor-list fetch, the one at the end of warming, carries the final names.
   */
  factsPending?: boolean;
  /** Off in tests: no ioreg polling, no macmon; samples arrive through feed(). */
  pollers?: boolean;
  /** The fallback tick when there is no macmon to pace the rows: at the leased rate, and with no lease. */
  tickMs?: number;
  idleTickMs?: number;
  /** How long the leased rate outlives its last lease: a page switch releases one and takes another. */
  lingerMs?: number;
}

/** macmon's interval while anything reads the sensors (a lease) and while nothing does. */
export const LEASED_MS = 500;
export const IDLE_MS = 5000;
/**
 * The GPU's memory in use is a 45 KB ioreg dump: every 2 s while leased, every 10 s with none. The
 * AI Models page reads it once without a lease for its "VRAM busy now" hint: the idle read keeps that
 * figure within about 15 s (a 10 s poll, a 5 s idle row) rather than frozen at the last leased value.
 */
export const GPU_MEMORY_POLL_MS = 2000;
export const GPU_MEMORY_IDLE_POLL_MS = 10_000;
/** The battery changes slowly: read every 30 s whatever the rate. */
export const BATTERY_POLL_MS = 30_000;
const MACMON_RESTART_MS = 5000;
const LINGER_MS = 3000;
const FRESH_TIMEOUT_MS = 3000;

/** A reader of the sensors at the leased rate: the Monitor page, a load run, Measure, the LLM benchmark. */
export interface SensorLease {
  readonly reason: string;
  /** Idempotent: a second call is nothing. */
  release(): void;
}

/** What the source runs now; null is "not at all". Tests read it with pollers off. */
export interface SensorSchedule {
  macmonMs: number | null;
  gpuMemoryMs: number | null;
  batteryMs: number;
  fallbackTickMs: number | null;
}

/**
 * The live source. `tick` is emitted with a SensorRow each time macmon prints a line (a timer
 * paces the rows only when macmon is absent), so every row is a new reading and none is a
 * repeat of the last; `meta()` is the list for /sensors/meta and grows as sources answer
 * (Health.warming until macmon's first sample and the chip's facts).
 *
 * A system monitor must itself be cheap, so the rate follows the readers. While any lease is
 * held (acquire()), macmon samples every 500 ms and the GPU's memory is read every 2 s; with
 * none, macmon samples every 5 s and the GPU's memory is read every 10 s. The battery is read
 * every 30 s either way. macmon cannot change its interval while it runs, so a rate change restarts it.
 */
export class MacSensors extends EventEmitter {
  private sample: MacmonSample | null = null;
  private gpuMem: GpuMemory | null = null;
  private battery: BatteryReading | null = null;
  private built: Built = { meta: [], values: {} };
  private latestRow: SensorRow = { qpc: qpcNow(), values: {} };
  readonly ring = new Ring();
  private child: ChildProcess | null = null;
  private started = false;
  private stopped = false;
  private factsPending: boolean;
  private readonly leases = new Set<SensorLease>();
  private leased = false;
  private linger: NodeJS.Timeout | null = null;
  private restart: NodeJS.Timeout | null = null;
  private gpuMemTimer: NodeJS.Timeout | null = null;
  /** The interval gpuMemTimer runs at; null when it does not run. */
  private gpuMemMs: number | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  /** Bumped at every macmon start; `leasedGeneration` is the process started at the leased interval, `sampleGeneration` the one the last sample came from. */
  private generation = 0;
  private leasedGeneration = -1;
  private sampleGeneration = -3;
  private freshWaiters: (() => void)[] = [];
  /** macmon is running and has answered at least once. */
  up = false;
  lastError: string | null = null;

  private facts: ChipFacts;

  constructor(private readonly opts: MacSensorsOptions) {
    super();
    this.facts = chipFacts(opts.chip, opts.facts);
    this.factsPending = !!opts.factsPending;
    if (opts.gpuTotalMiB !== null) this.gpuMem = { usedMiB: 0, totalMiB: opts.gpuTotalMiB };
  }

  /** The first macmon sample has not arrived, or the chip's facts have not (without macmon, only the facts). */
  get warming(): boolean {
    return this.factsPending || (this.opts.macmon !== null && this.sample === null);
  }

  start() {
    this.started = true;
    this.stopped = false;
    if (this.opts.pollers !== false) {
      this.spawnMacmon();
      this.pollBattery();
      this.batteryTimer = setInterval(() => this.pollBattery(), BATTERY_POLL_MS);
    }
    this.armGpuMemory();
    this.armFallback();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.linger, this.restart]) if (t) clearTimeout(t);
    for (const t of [this.gpuMemTimer, this.batteryTimer, this.fallbackTimer]) if (t) clearInterval(t);
    this.linger = this.restart = this.gpuMemTimer = this.batteryTimer = this.fallbackTimer = null;
    this.gpuMemMs = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.resolveFresh();
  }

  /** The chip's facts once macmon's soc info and the worker's --info have answered; rows carry the final names from here on. */
  setFacts(chip: string, facts: Partial<ChipFacts>, gpuTotalMiB: number | null) {
    this.facts = chipFacts(chip, facts);
    this.gpuMem = gpuTotalMiB === null ? null : { usedMiB: this.gpuMem?.usedMiB ?? 0, totalMiB: gpuTotalMiB };
    this.factsPending = false;
    this.rebuild();
    this.armGpuMemory();
  }

  /** Holds the leased rate until release(); the first lease restarts macmon at 500 ms. */
  acquire(reason: string): SensorLease {
    const lease: SensorLease = {
      reason,
      release: () => {
        if (this.leases.delete(lease)) this.leasesChanged();
      }
    };
    this.leases.add(lease);
    this.leasesChanged();
    return lease;
  }

  get leaseReasons(): string[] {
    return [...this.leases].map((l) => l.reason);
  }

  get rate(): 'leased' | 'idle' {
    return this.leased ? 'leased' : 'idle';
  }

  get schedule(): SensorSchedule {
    return {
      macmonMs: this.opts.macmon === null ? null : this.leased ? LEASED_MS : IDLE_MS,
      gpuMemoryMs: this.gpuMem === null ? null : this.leased ? GPU_MEMORY_POLL_MS : GPU_MEMORY_IDLE_POLL_MS,
      batteryMs: BATTERY_POLL_MS,
      fallbackTickMs: this.opts.macmon !== null ? null : this.leased ? this.opts.tickMs ?? LEASED_MS : this.opts.idleTickMs ?? IDLE_MS
    };
  }

  /**
   * Resolves once a sample taken at the leased rate has arrived: at once when the last one
   * already is, or when there is no macmon to wait for; after the timeout otherwise (macmon slow
   * to restart). A load run takes its idle reference after this, never from a 5 s-old sample.
   */
  whenFresh(timeoutMs = FRESH_TIMEOUT_MS): Promise<void> {
    if (this.opts.macmon === null || this.stopped || (this.leased && this.sampleGeneration === this.leasedGeneration)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.freshWaiters = this.freshWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.freshWaiters.push(done);
    });
  }

  /** A macmon sample from the stream (or a test): a new row, emitted as a tick. */
  feed(sample: MacmonSample, generation = this.generation) {
    this.sample = sample;
    this.sampleGeneration = generation;
    this.up = true;
    this.tick();
    if (this.leased && generation === this.leasedGeneration) this.resolveFresh();
  }

  /**
   * A sample from outside the stream (macmon's --soc-info line at start), taken only while the
   * stream has given none: with no lease its first line comes 5 s after start. It never counts
   * as fresh for whenFresh().
   */
  seed(sample: MacmonSample) {
    if (this.sample === null) this.feed(sample, -2);
  }

  feedBattery(b: BatteryReading | null) {
    this.battery = b;
  }

  feedGpuMemoryUsed(usedMiB: number) {
    if (this.gpuMem) this.gpuMem = { ...this.gpuMem, usedMiB };
  }

  meta(): SensorMeta[] {
    return this.built.meta;
  }

  latest(): SensorRow {
    return this.latestRow;
  }

  value(id: string): number | null {
    const v = this.latestRow.values[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  private rebuild() {
    this.built = sensorsOf(this.facts, this.sample, this.gpuMem, this.battery);
    this.latestRow = { qpc: qpcNow(), values: this.built.values };
  }

  private tick() {
    this.rebuild();
    this.ring.push(this.latestRow);
    this.emit('tick', this.latestRow);
  }

  private resolveFresh() {
    for (const w of [...this.freshWaiters]) w();
  }

  private leasesChanged() {
    if (this.leases.size > 0) {
      if (this.linger) clearTimeout(this.linger);
      this.linger = null;
      if (!this.leased) this.setLeased(true);
      return;
    }
    if (!this.leased || this.linger) return;
    const ms = this.opts.lingerMs ?? LINGER_MS;
    if (ms <= 0) return this.setLeased(false);
    this.linger = setTimeout(() => {
      this.linger = null;
      if (this.leases.size === 0) this.setLeased(false);
    }, ms);
  }

  private setLeased(on: boolean) {
    this.leased = on;
    if (!this.started || this.stopped) return;
    this.restartMacmon();
    this.armGpuMemory();
    this.armFallback();
  }

  /** At the new interval. The old process's exit is ours, not a crash: it is forgotten before it is killed. */
  private restartMacmon() {
    if (this.opts.macmon === null) return;
    const old = this.child;
    this.child = null;
    old?.kill();
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    if (this.opts.pollers === false) this.nextGeneration();
    else this.spawnMacmon();
  }

  private nextGeneration(): number {
    this.generation += 1;
    if (this.leased) this.leasedGeneration = this.generation;
    return this.generation;
  }

  private armGpuMemory() {
    const ms = this.opts.pollers !== false && this.started && !this.stopped ? this.schedule.gpuMemoryMs : null;
    if (ms === this.gpuMemMs) return;
    if (this.gpuMemTimer) clearInterval(this.gpuMemTimer);
    this.gpuMemTimer = null;
    // A faster rate (the first arming, a lease) reads at once; the drop to the idle rate keeps the last reading.
    if (ms !== null && (this.gpuMemMs === null || ms < this.gpuMemMs)) this.pollGpuMemory();
    this.gpuMemMs = ms;
    if (ms !== null) this.gpuMemTimer = setInterval(() => this.pollGpuMemory(), ms);
  }

  /** Without macmon nothing prints a line to pace the rows (the battery and GPU memory still change): a timer does, at the same two rates. */
  private armFallback() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    const ms = this.started && !this.stopped ? this.schedule.fallbackTickMs : null;
    if (ms !== null) this.fallbackTimer = setInterval(() => this.tick(), ms);
  }

  private spawnMacmon() {
    if (this.stopped || !this.opts.macmon || this.opts.pollers === false) return;
    const generation = this.nextGeneration();
    let buffer = '';
    const child = spawn(this.opts.macmon, ['pipe', '-i', String(this.leased ? LEASED_MS : IDLE_MS)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      // A line from a process already replaced at another rate is dropped.
      if (this.child !== child) return;
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.feed(JSON.parse(line) as MacmonSample, generation);
        } catch {
          /* a partial or foreign line */
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-500)));
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.up = false;
      this.lastError = why;
      console.warn(`[mac-collector] macmon ${why}; restarting in ${MACMON_RESTART_MS / 1000} s`);
      if (!this.stopped) {
        this.restart = setTimeout(() => {
          this.restart = null;
          this.spawnMacmon();
        }, MACMON_RESTART_MS);
      }
    };
    child.on('error', (e) => gone(e.message));
    child.on('exit', (code) => gone(`exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
  }

  private pollBattery() {
    execFile('ioreg', ['-r', '-c', 'AppleSmartBattery', '-d', '1'], { timeout: 4000 }, (err, out) => {
      if (!err) this.battery = parseBattery(String(out));
    });
  }

  private pollGpuMemory() {
    if (!this.gpuMem) return;
    execFile('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], { timeout: 4000, maxBuffer: 4 * MIB }, (err, out) => {
      const used = err ? null : parseGpuMemoryUsed(String(out));
      if (used !== null) this.feedGpuMemoryUsed(used);
    });
  }
}
