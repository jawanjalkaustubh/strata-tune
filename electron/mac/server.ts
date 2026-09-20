/**
 * The macOS collector: the same loopback HTTP + SSE contract as the elevated Windows service
 * (collector/README.md, src/collector-types.ts), served from inside the app's main process.
 * Nothing on a Mac needs elevation to read sensors, so there is no second process, no UAC and
 * no orphan to watch; the handshake file and the bearer token stay so CollectorClient is
 * unchanged. /tune/* answers honestly: the headroom hunt drives NVIDIA clocks and has no
 * Apple Silicon counterpart. No Electron import here so tests can run it under vitest.
 */
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { GpuFacts, Handshake, Health, LoadRunRequest, StaticSnapshot, Tick, Timers, TuneStatus } from '../../src/collector-types';
import { LoadRunner } from './loads';
import { sampleHogs } from './hogs';
import { MacSensors, QPC_FREQUENCY, parseBattery, qpcNow, type BatteryReading, type MacmonSample } from './sensors';
import { macSnapshot, type WorkerInfo } from './snapshot';

export const NOT_ON_APPLE_SILICON = 'The headroom hunt drives NVIDIA clock offsets through NVAPI. Apple Silicon GPUs have no user clock control, so there is nothing to hunt on this Mac.';

const TICK_MS = 500;
const KEEP_ALIVE_MS = 10_000;
const SNAPSHOT_CACHE_MS = 30_000;

export interface MacCollectorOptions {
  version: string;
  /** Where collector.json lands (tuneDataDir()). */
  dataDir: string;
  workerPath: string;
  macmonPath: string | null;
  /** Injected in tests; built from the options otherwise. */
  sensors?: MacSensors;
  snapshot?: () => Promise<StaticSnapshot>;
  logicalCpus?: number;
}

interface SocInfo {
  chip: string;
  maxClockMhz: number;
  gpuCores: number | null;
  gpuMaxClockMhz: number | null;
  /** macmon's cluster labels ("S"/"P" on the M5 Pro/Max, "P"/"E" before). */
  coreLabels: { high: string; low: string } | null;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf-8');
    req.on('data', (d: string) => (text += d));
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** `macmon pipe --soc-info -s 1`: the chip name and its clock table, once at start. */
function socInfo(macmon: string | null): Promise<SocInfo> {
  const fallback: SocInfo = { chip: os.cpus()[0]?.model || 'Apple Silicon', maxClockMhz: 0, gpuCores: null, gpuMaxClockMhz: null, coreLabels: null };
  if (!macmon) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(macmon, ['pipe', '--soc-info', '-s', '1', '-i', '200'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(fallback);
      try {
        const line = String(out).split('\n').find((l) => l.trim().startsWith('{')) ?? '{}';
        const j = JSON.parse(line) as { soc?: { chip_name?: string; pcpu_freqs?: number[]; ecpu_freqs?: number[]; gpu_freqs?: number[]; gpu_cores?: number; pcpu_label?: string; ecpu_label?: string } };
        const freqs = [...(j.soc?.pcpu_freqs ?? []), ...(j.soc?.ecpu_freqs ?? [])];
        const gpuFreqs = j.soc?.gpu_freqs ?? [];
        resolve({
          chip: j.soc?.chip_name || fallback.chip,
          maxClockMhz: freqs.length ? Math.max(...freqs) : 0,
          gpuCores: typeof j.soc?.gpu_cores === 'number' && j.soc.gpu_cores > 0 ? j.soc.gpu_cores : null,
          gpuMaxClockMhz: gpuFreqs.length ? Math.max(...gpuFreqs) : null,
          coreLabels: j.soc?.pcpu_label && j.soc?.ecpu_label ? { high: j.soc.pcpu_label, low: j.soc.ecpu_label } : null
        });
      } catch {
        resolve(fallback);
      }
    });
  });
}

function workerInfo(worker: string): Promise<WorkerInfo | null> {
  if (!fs.existsSync(worker)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(worker, ['--info', '--json'], { timeout: 15_000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const line = String(out).split('\n').find((l) => l.trim().startsWith('{')) ?? '';
        const j = JSON.parse(line) as Partial<WorkerInfo>;
        resolve(typeof j.device === 'string' && typeof j.recommendedMaxWorkingSetBytes === 'number' ? (j as WorkerInfo) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** IORegistry's gpu-core-count on the AGX accelerator, the fallback when macmon is absent. */
function gpuCoresFromIoreg(): Promise<number | null> {
  return new Promise((resolve) =>
    execFile('ioreg', ['-rc', 'AGXAccelerator', '-d', '1'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      const m = err ? null : /"gpu-core-count" = (\d+)/.exec(String(out));
      resolve(m ? Number(m[1]) : null);
    })
  );
}

function batteryNow(): Promise<BatteryReading | null> {
  return new Promise((resolve) => execFile('ioreg', ['-r', '-c', 'AppleSmartBattery', '-d', '1'], { timeout: 4000 }, (err, out) => resolve(err ? null : parseBattery(String(out)))));
}

export class MacCollector {
  handshake: Handshake | null = null;
  private server: http.Server | null = null;
  private sensors: MacSensors | null = null;
  private loads: LoadRunner | null = null;
  private clients = new Set<http.ServerResponse>();
  private keepAlive: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date();
  private soc: SocInfo = { chip: 'Apple Silicon', maxClockMhz: 0, gpuCores: null, gpuMaxClockMhz: null, coreLabels: null };
  private info: WorkerInfo | null = null;
  private snapshotCache: { at: number; value: Promise<StaticSnapshot> } | null = null;

  constructor(private readonly opts: MacCollectorOptions) {}

  /** macmon is streaming; false means only the IOKit rows (battery, GPU memory) exist. */
  get sensorsUp(): boolean {
    return !!this.sensors?.up;
  }

  get macmonInstalled(): boolean {
    return this.opts.macmonPath !== null;
  }

  async start(): Promise<Handshake> {
    if (this.handshake) return this.handshake;
    const [soc, info, ioregCores] = await Promise.all([socInfo(this.opts.macmonPath), workerInfo(this.opts.workerPath), gpuCoresFromIoreg()]);
    this.soc = { ...soc, gpuCores: soc.gpuCores ?? ioregCores };
    this.info = info;
    this.sensors =
      this.opts.sensors ??
      new MacSensors({
        macmon: this.opts.macmonPath,
        chip: info?.device ?? soc.chip,
        facts: { gpuName: this.gpuName(), coreLabels: this.soc.coreLabels ?? undefined, gpuCores: this.soc.gpuCores },
        gpuTotalMiB: info ? info.recommendedMaxWorkingSetBytes / 1024 ** 2 : null
      });
    this.loads = new LoadRunner(this.opts.workerPath, this.sensors);
    this.sensors.on('tick', (row: { qpc: number; values: Record<string, number> }) => this.broadcast(row));
    this.sensors.start();
    this.server = http.createServer((req, res) => void this.handle(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve((this.server!.address() as AddressInfo).port));
    });
    this.handshake = { port, token: randomBytes(32).toString('hex'), pid: process.pid, startedAt: this.startedAt.toISOString() };
    this.writeHandshake(this.handshake);
    this.keepAlive = setInterval(() => {
      for (const c of this.clients) c.write(': keep-alive\n\n');
    }, KEEP_ALIVE_MS);
    return this.handshake;
  }

  async stop(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.loads?.stopAll();
    this.sensors?.stop();
    for (const c of this.clients) c.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (this.handshake) fs.unlinkSync(path.join(this.opts.dataDir, 'collector.json'));
    } catch {
      /* already gone */
    }
    this.handshake = null;
  }

  /** "Apple M5 Max (40-core GPU)": the adapter name in the snapshot and the GPU node's name in the sensor rows; two M5 Max parts share a chip name. */
  private gpuName(): string {
    const chip = this.info?.device ?? this.soc.chip;
    return this.soc.gpuCores ? `${chip} (${this.soc.gpuCores}-core GPU)` : chip;
  }

  /** Tests feed macmon samples straight in. */
  feed(sample: MacmonSample) {
    this.sensors?.feed(sample);
  }

  private writeHandshake(h: Handshake) {
    const file = path.join(this.opts.dataDir, 'collector.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private health(): Health {
    return {
      ok: true,
      pid: process.pid,
      version: this.opts.version,
      elevated: false,
      pawnIo: { installed: false, version: null },
      nvml: { available: false, driver: null },
      lhm: { available: this.sensorsUp },
      pdh: { available: false },
      qpcFrequency: QPC_FREQUENCY,
      startedAt: this.startedAt.toISOString(),
      uptime: (Date.now() - this.startedAt.getTime()) / 1000,
      warming: !!this.sensors?.warming,
      tune: null
    };
  }

  private tuneStatus(): TuneStatus {
    return {
      enabled: false,
      state: 'IDLE',
      baseline: null,
      candidate: null,
      appliedAt: null,
      reverted: null,
      result: null,
      history: [],
      nvapi: { available: false, reason: NOT_ON_APPLE_SILICON, deltas: null, range: null },
      run: null,
      flightAvailable: false,
      stateFile: '',
      problem: null,
      estimateMinutes: 0
    };
  }

  private timers(): Timers {
    return {
      currentMs: null,
      finestMs: null,
      coarsestMs: null,
      qpcFrequency: QPC_FREQUENCY,
      qpcSource: 'mach_absolute_time',
      qpcNote: 'The collector stamps samples in microseconds from the Mach monotonic clock; there is no boot-time source choice on macOS.',
      requesters: null,
      requestersNote: 'macOS has no system-wide timer-resolution setting for a program to hold raised, so there is nothing to trace.'
    };
  }

  private snapshot(): Promise<StaticSnapshot> {
    if (this.opts.snapshot) return this.opts.snapshot();
    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_CACHE_MS) return this.snapshotCache.value;
    const value = macSnapshot({ workerInfo: () => Promise.resolve(this.info), battery: batteryNow, maxClockMhz: () => this.soc.maxClockMhz, gpu: () => ({ name: this.gpuName(), cores: this.soc.gpuCores, maxClockMhz: this.soc.gpuMaxClockMhz }) });
    this.snapshotCache = { at: now, value };
    value.catch(() => (this.snapshotCache = null));
    return value;
  }

  private broadcast(row: { qpc: number; values: Record<string, number> }) {
    if (this.clients.size === 0) return;
    const tick: Tick = { qpc: row.qpc, sensors: row.values, gpu: [], warming: !!this.sensors?.warming };
    const frame = `event: tick\ndata: ${JSON.stringify(tick)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const h = this.handshake;
    if (!h) return json(res, 503, { error: 'collector stopping' });
    if (req.headers.authorization !== `Bearer ${h.token}`) return json(res, 401, { error: 'unauthorised' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && p === '/health') return json(res, 200, this.health());
      if (method === 'GET' && p === '/snapshot') return json(res, 200, await this.snapshot());
      if (method === 'GET' && p === '/sensors/meta') return json(res, 200, this.sensors?.meta() ?? []);
      if (method === 'GET' && p === '/sensors/latest') return json(res, 200, this.sensors?.latest() ?? { qpc: qpcNow(), values: {} });
      if (method === 'GET' && p === '/sensors/window') {
        const seconds = Math.max(1, Math.min(4 * 3600, Number(url.searchParams.get('seconds')) || 60));
        return json(res, 200, this.sensors?.ring.window(seconds) ?? { seconds, qpcNow: qpcNow(), rows: [], summaries: [] });
      }
      if (method === 'GET' && p === '/gpu') return json(res, 200, [] as GpuFacts[]);
      if (method === 'GET' && (p === '/procs/hogs' || p === '/hogs')) {
        const seconds = Math.max(1, Math.min(60, Number(url.searchParams.get('seconds')) || 5));
        const exclude = [process.pid, Number(url.searchParams.get('excludePid')) || 0].filter((x) => x > 0);
        return json(res, 200, await sampleHogs(seconds, exclude, this.opts.logicalCpus ?? os.cpus().length));
      }
      if (method === 'POST' && p === '/load') {
        const r = this.loads!.start((await readBody(req)) as Partial<LoadRunRequest>);
        return 'status' in r ? json(res, r.status, { error: r.error }) : json(res, 200, r);
      }
      const cancel = /^\/load\/([^/]+)\/cancel$/.exec(p);
      if (method === 'POST' && cancel) {
        const r = this.loads!.cancel(decodeURIComponent(cancel[1]));
        if (r === null) return json(res, 404, { error: 'no such load run' });
        if (r === false) return json(res, 409, { error: `load run ${cancel[1]} is not running` });
        return json(res, 200, r);
      }
      const get = /^\/load\/([^/]+)$/.exec(p);
      if (method === 'GET' && get) {
        const r = this.loads!.get(decodeURIComponent(get[1]));
        return r ? json(res, 200, r) : json(res, 404, { error: 'no such load run' });
      }
      if (method === 'GET' && p === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      if (method === 'GET' && p === '/timers') return json(res, 200, this.timers());
      if (method === 'GET' && p === '/tune/state') return json(res, 200, this.tuneStatus());
      if (p === '/tune/export' || p === '/tune/flight') return json(res, 404, { error: 'no hunt has run on this Mac' });
      if (method === 'POST' && p.startsWith('/tune/')) return json(res, 403, { error: NOT_ON_APPLE_SILICON });
      if (method === 'POST' && p === '/shutdown') {
        res.writeHead(202);
        res.end();
        setImmediate(() => void this.stop());
        return;
      }
      json(res, 404, { error: 'no route' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  }
}
