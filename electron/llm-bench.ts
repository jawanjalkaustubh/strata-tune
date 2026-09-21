/**
 * The LLM benchmark runner (plan section 10, the cross-machine comparison; the pure half is
 * src/analysis/llm-bench.ts): evicts the model, reads the collector idle for two seconds,
 * then runs the fixed prompt through Ollama N times at temperature 0 with a fixed seed and
 * a fixed length, sampling the collector's power and memory readings while each generation
 * is in flight. Results live in llm-bench.json beside bench.json; Export writes them to a
 * file the other machine's Import reads, so a PC row and a Mac row sit in one table.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app, dialog, BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import type { CollectorClient } from './collector';
import { KEEP_ALIVE, ollamaError, ollamaJson, type BenchError } from './bench';
import type { GpuFacts, SensorMeta } from '../src/collector-types';
import {
  DEFAULT_RUNS, IDLE_SECONDS, NUM_CTX, PREDICT_TOKENS, SAMPLE_MS, SEED, promptForRun, parseBenchFile, summarise, validResult,
  type LlmBenchFile, type LlmBenchResult, type LlmMachine, type LlmModel, type LlmRun, type LlmSample
} from '../src/analysis/llm-bench';

export interface LlmBenchRequest {
  model: string;
  runs?: number;
  /** What the page knows of the machine (the collector snapshot or the picker); the host name and OS are added here. */
  machine: Omit<LlmMachine, 'hostname' | 'os'>;
}

/** Pushed on 'llm:progress' while a run goes: the phase and, inside the runs, which one. */
export interface LlmProgress {
  model: string;
  phase: 'evict' | 'idle' | 'load' | 'run' | 'done';
  run: number;
  runs: number;
}

/** A 27B model can take a minute to page in before the first token; the prompt then adds a thousand tokens of prefill. */
const GENERATE_TIMEOUT_MS = 10 * 60_000;

const filePath = () => path.join(app.getPath('userData'), 'llm-bench.json');

function readAll(): LlmBenchResult[] {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { results?: unknown[] };
    return (j.results ?? []).filter(validResult);
  } catch {
    return [];
  }
}

function writeAll(results: LlmBenchResult[]) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ results }, null, 2));
  } catch (e) {
    console.warn('[llm-bench] could not write llm-bench.json:', (e as Error).message);
  }
}

// ----------------------------------------------------------------- sampling

interface Ids {
  gpuW?: string;
  cpuW?: string;
  systemW?: string;
  gpuMemMiB?: string;
}

/**
 * The sensor ids the run reads, by the names both collectors publish: the GPU's board or core
 * power ("Board power" from NVML, "GPU Core" on Apple, "GPU Package" on AMD), the CPU package,
 * the SMC's whole-system figure (Apple only; a PC has no such sensor) and the GPU memory in
 * use. A PC with a processor's own graphics beside the card lists both GPUs: the one whose
 * hardware name is the card being benchmarked wins, then a discrete NVIDIA one, then the first.
 */
export function resolveIds(meta: SensorMeta[], gpuName = ''): Ids {
  const want = gpuName.toLowerCase();
  const gpuRank = (m: SensorMeta) => {
    const name = m.hardwareName.toLowerCase();
    if (want && (name === want || want.includes(name) || name.includes(want))) return 0;
    if (m.hardwareType === 'GpuNvidia') return 1;
    return 2;
  };
  const find = (type: string, name: RegExp, hardware?: RegExp) => {
    const hits = meta.filter((m) => m.sensorType === type && name.test(m.name) && (!hardware || hardware.test(m.hardwareType)));
    if (hardware && /gpu/i.test(hardware.source)) hits.sort((a, b) => gpuRank(a) - gpuRank(b));
    return hits[0]?.id;
  };
  return {
    gpuW: find('Power', /^(GPU (Core|Package|SoC)|Board power)$/i, /gpu/i),
    cpuW: find('Power', /^(CPU )?Package$/i, /cpu/i),
    systemW: find('Power', /^System Total$/i),
    gpuMemMiB: find('SmallData', /^(GPU Memory Used|VRAM used)$/i, /gpu/i)
  };
}

class Sampler {
  private ids: Ids = {};
  private timer: NodeJS.Timeout | null = null;
  samples: LlmSample[] = [];
  constructor(private readonly collector: CollectorClient | null, private readonly gpuName: string) {}

  get connected() {
    return this.collector?.state.status === 'connected';
  }

  async prepare() {
    if (!this.connected) return;
    try {
      this.ids = resolveIds(await this.collector!.sensorsMeta(), this.gpuName);
    } catch {
      this.ids = {};
    }
  }

  /** One reading now: the sensor rows first, NVML's own facts (a PC's board power and VRAM) where a row is missing. */
  private async read(): Promise<LlmSample | null> {
    if (!this.connected) return null;
    const sample: LlmSample = { gpuW: null, cpuW: null, systemW: null, gpuMemMiB: null };
    try {
      const row = await this.collector!.sensorsLatest();
      const v = (id?: string) => (id !== undefined && Number.isFinite(row.values[id]) ? row.values[id] : null);
      sample.gpuW = v(this.ids.gpuW);
      sample.cpuW = v(this.ids.cpuW);
      sample.systemW = v(this.ids.systemW);
      sample.gpuMemMiB = v(this.ids.gpuMemMiB);
    } catch {
      /* the collector went away for a tick */
    }
    if (sample.gpuW === null || sample.gpuMemMiB === null) {
      try {
        const g: GpuFacts | undefined = (await this.collector!.gpu())[0];
        if (g) {
          if (sample.gpuW === null && g.powerMw > 0) sample.gpuW = g.powerMw / 1000;
          if (sample.gpuMemMiB === null && g.vram.usedMiB > 0) sample.gpuMemMiB = g.vram.usedMiB;
        }
      } catch {
        /* no /gpu (the macOS collector answers an empty list) */
      }
    }
    return sample;
  }

  start(into: LlmSample[]) {
    this.stop();
    if (!this.connected) return;
    this.timer = setInterval(() => {
      this.read().then((s) => s && into.push(s));
    }, SAMPLE_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// --------------------------------------------------------------------- run

interface Generate {
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
}

interface Show {
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

interface Tags {
  models?: { name: string; size: number }[];
}

interface Ps {
  models?: { name: string; size_vram?: number }[];
}

let current: AbortController | null = null;
let inFlight: Promise<LlmBenchResult | BenchError> | null = null;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))), { once: true });
  });

const osName = (): LlmMachine['os'] => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux');

async function run(req: LlmBenchRequest, collector: CollectorClient | null, progress: (p: LlmProgress) => void): Promise<LlmBenchResult | BenchError> {
  const runs = Math.max(1, Math.min(9, Math.round(req.runs ?? DEFAULT_RUNS)));
  const controller = new AbortController();
  current = controller;
  const signal = controller.signal;
  const sampler = new Sampler(collector, req.machine.gpuName);
  const report = (phase: LlmProgress['phase'], runIndex = 0) => progress({ model: req.model, phase, run: runIndex, runs });
  try {
    // The model's own description and size, so the row says what was timed (a 27B at Q4 is not a 27B at Q8).
    const [show, tags] = await Promise.all([ollamaJson<Show>('/api/show', { model: req.model }), ollamaJson<Tags>('/api/tags')]);
    const tag = (tags.models ?? []).find((m) => m.name === req.model);
    const model: LlmModel = {
      name: req.model,
      parameterSize: show.details?.parameter_size ?? '',
      quantization: show.details?.quantization_level ?? '',
      family: show.details?.family ?? '',
      sizeBytes: tag?.size ?? 0
    };
    // Evict so run 1 is a cold load: the figure Ollama's verbose output calls load duration.
    report('evict');
    await ollamaJson('/api/generate', { model: req.model, keep_alive: 0 }, 10_000, signal);
    await sampler.prepare();
    report('idle');
    const idle: LlmSample[] = [];
    sampler.start(idle);
    await sleep(IDLE_SECONDS * 1000, signal).finally(() => sampler.stop());
    const busy: LlmSample[] = [];
    const results: LlmRun[] = [];
    for (let i = 1; i <= runs; i++) {
      report(i === 1 ? 'load' : 'run', i);
      sampler.start(busy);
      let g: Generate;
      try {
        g = await ollamaJson<Generate>(
          '/api/generate',
          {
            model: req.model,
            prompt: promptForRun(i, runs),
            stream: false,
            keep_alive: KEEP_ALIVE,
            options: { num_predict: PREDICT_TOKENS, num_ctx: NUM_CTX, temperature: 0, seed: SEED }
          },
          GENERATE_TIMEOUT_MS,
          signal
        );
      } finally {
        sampler.stop();
      }
      if (!g.eval_count || !g.eval_duration) return { error: `${req.model} generated nothing to time` };
      results.push({
        promptEvalCount: g.prompt_eval_count ?? 0,
        promptEvalMs: (g.prompt_eval_duration ?? 0) / 1e6,
        evalCount: g.eval_count,
        evalMs: g.eval_duration / 1e6,
        loadMs: (g.load_duration ?? 0) / 1e6,
        totalMs: (g.total_duration ?? 0) / 1e6
      });
    }
    let residentBytes: number | null = null;
    try {
      const ps = await ollamaJson<Ps>('/api/ps');
      residentBytes = (ps.models ?? []).find((m) => m.name === req.model)?.size_vram ?? null;
    } catch {
      /* the figure is a nicety */
    }
    report('done');
    const result = summarise({
      id: randomUUID(),
      measuredAt: new Date().toISOString(),
      machine: { ...req.machine, hostname: os.hostname().replace(/\.local$/, ''), os: osName() },
      model,
      runs: results,
      idle,
      busy,
      residentBytes
    });
    writeAll([...readAll(), result]);
    return result;
  } catch (e) {
    return ollamaError(e);
  } finally {
    sampler.stop();
    if (current === controller) current = null;
  }
}

function cancel() {
  current?.abort();
  current = null;
}

// ---------------------------------------------------------------- export/import

async function exportResults(e: IpcMainInvokeEvent, ids: string[]): Promise<string | null> {
  const all = readAll();
  const results = ids.length ? all.filter((r) => ids.includes(r.id)) : all;
  const file: LlmBenchFile = { strataLlmBench: 1, exportedAt: new Date().toISOString(), results };
  const win = BrowserWindow.fromWebContents(e.sender);
  const host = os.hostname().replace(/\.local$/, '').replace(/[^\w.-]+/g, '-');
  const options = {
    title: 'Export LLM benchmark',
    defaultPath: path.join(app.getPath('downloads'), `strata-llm-bench-${host}-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Strata Tune LLM benchmark', extensions: ['json'] }]
  };
  const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(file, null, 2), 'utf-8');
  return r.filePath;
}

async function importResults(e: IpcMainInvokeEvent): Promise<{ results: LlmBenchResult[]; added: number } | BenchError> {
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = {
    title: 'Import LLM benchmark',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Strata Tune LLM benchmark', extensions: ['json'] }],
    properties: ['openFile' as const]
  };
  const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  if (r.canceled || r.filePaths.length === 0) return { results: readAll(), added: 0 };
  let text: string;
  try {
    text = fs.readFileSync(r.filePaths[0], 'utf-8');
  } catch (err) {
    return { error: `Could not read the file: ${(err as Error).message}` };
  }
  const parsed = parseBenchFile(text);
  if ('error' in parsed) return parsed;
  const have = readAll();
  const known = new Set(have.map((x) => x.id));
  const fresh = parsed.results.filter((x) => !known.has(x.id));
  const merged = [...have, ...fresh];
  writeAll(merged);
  return { results: merged, added: fresh.length };
}

// --------------------------------------------------------------------- IPC

export function registerLlmBenchIpc(ipcMain: IpcMain, collector: () => CollectorClient | null, send: (channel: string, payload: LlmProgress) => void) {
  ipcMain.handle('llm:list', () => readAll());
  ipcMain.handle('llm:run', (_e, req: LlmBenchRequest) => {
    // A second Run while one goes joins it: two generations on the card at once would time each other.
    if (!inFlight) inFlight = run(req, collector(), (p) => send('llm:progress', p)).finally(() => (inFlight = null));
    return inFlight;
  });
  ipcMain.handle('llm:cancel', () => cancel());
  ipcMain.handle('llm:delete', (_e, id: string) => {
    const kept = readAll().filter((r) => r.id !== id);
    writeAll(kept);
    return kept;
  });
  ipcMain.handle('llm:export', (e, ids: string[]) => exportResults(e, ids ?? []));
  ipcMain.handle('llm:import', (e) => importResults(e));
}
