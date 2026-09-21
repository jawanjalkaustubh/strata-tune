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
  /** Off in tests: no ioreg polling, no macmon; samples arrive through feed(). */
  pollers?: boolean;
  tickMs?: number;
}

const MACMON_INTERVAL_MS = 500;
const IOREG_POLL_MS = 2000;
const MACMON_RESTART_MS = 5000;

/**
 * The live source. `tick` is emitted at 2 Hz with a SensorRow; `meta()` is the list for
 * /sensors/meta and grows as sources answer (Health.warming until macmon's first sample, or
 * at once when macmon is absent).
 */
export class MacSensors extends EventEmitter {
  private sample: MacmonSample | null = null;
  private gpuMem: GpuMemory | null = null;
  private battery: BatteryReading | null = null;
  private built: Built = { meta: [], values: {} };
  private latestRow: SensorRow = { qpc: qpcNow(), values: {} };
  readonly ring = new Ring();
  private child: ChildProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** macmon is running and has answered at least once. */
  up = false;
  /** The first macmon sample has not arrived (false at once when macmon is absent). */
  warming: boolean;
  lastError: string | null = null;

  private readonly facts: ChipFacts;

  constructor(private readonly opts: MacSensorsOptions) {
    super();
    this.facts = chipFacts(opts.chip, opts.facts);
    this.warming = opts.macmon !== null;
    if (opts.gpuTotalMiB !== null) this.gpuMem = { usedMiB: 0, totalMiB: opts.gpuTotalMiB };
  }

  start() {
    this.stopped = false;
    if (this.opts.pollers !== false) {
      this.spawnMacmon();
      this.pollIoreg();
      this.timers.push(setInterval(() => this.pollIoreg(), IOREG_POLL_MS));
    }
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs ?? MACMON_INTERVAL_MS));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.child?.kill();
    this.child = null;
  }

  /** A macmon sample from the stream (or a test). */
  feed(sample: MacmonSample) {
    this.sample = sample;
    this.up = true;
    this.warming = false;
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

  private tick() {
    this.built = sensorsOf(this.facts, this.sample, this.gpuMem, this.battery);
    this.latestRow = { qpc: qpcNow(), values: this.built.values };
    this.ring.push(this.latestRow);
    this.emit('tick', this.latestRow);
  }

  private spawnMacmon() {
    if (this.stopped || !this.opts.macmon) return;
    let buffer = '';
    const child = spawn(this.opts.macmon, ['pipe', '-i', String(MACMON_INTERVAL_MS)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.feed(JSON.parse(line) as MacmonSample);
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
      if (!this.stopped) this.timers.push(setTimeout(() => this.spawnMacmon(), MACMON_RESTART_MS));
    };
    child.on('error', (e) => gone(e.message));
    child.on('exit', (code) => gone(`exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
  }

  private pollIoreg() {
    execFile('ioreg', ['-r', '-c', 'AppleSmartBattery', '-d', '1'], { timeout: 4000 }, (err, out) => {
      if (!err) this.battery = parseBattery(String(out));
    });
    if (this.gpuMem) {
      execFile('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], { timeout: 4000, maxBuffer: 4 * MIB }, (err, out) => {
        const used = err ? null : parseGpuMemoryUsed(String(out));
        if (used !== null) this.feedGpuMemoryUsed(used);
      });
    }
  }
}
