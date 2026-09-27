/**
 * The LLM benchmark runner (plan section 10c, the cross-machine comparison; the pure half is
 * src/analysis/llm-bench.ts): evicts the model, reads the collector idle for two seconds,
 * loads the model cold at the sweep's one context window with a warm-up generation that is
 * discarded, then runs the fixed prompt through Ollama at each context depth N times at
 * temperature 0 with a fixed seed and a fixed length, sampling the collector's power and memory
 * readings, each stamped, while each generation is in flight. Results live in llm-bench.json
 * beside bench.json; Export writes them to a file the other machine's Import reads, so a PC row
 * and a Mac row sit in one table.
 *
 * The same file runs llama-benchy (eugr/llama-benchy, the community table) through `uvx`
 * against Ollama's OpenAI endpoint and keeps its JSON beside the card's own rows.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import { app, dialog, BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import type { CollectorClient } from './collector';
import { KEEP_ALIVE, OLLAMA, ollamaError, ollamaJson, type BenchError } from './bench';
import { keepAwakeOnMac } from './keepAwake';
import { powerModeOf } from './mac/snapshot';
import type { GpuFacts, SensorMeta, Tick } from '../src/collector-types';
import {
  DEFAULT_RUNS, DEPTHS, IDLE_SECONDS, PREDICT_TOKENS, SAMPLE_MS, SEED, promptForRun, parseBenchFile, parseBenchyJson, summarise, supersede, sweepPlan, validBenchy, validResult,
  type BenchyResult, type LlmBenchFile, type LlmBenchResult, type LlmMachine, type LlmModel, type LlmRun, type LlmSample
} from '../src/analysis/llm-bench';

export interface LlmBenchRequest {
  model: string;
  runs?: number;
  /** What the page knows of the machine (the collector snapshot or the picker); the host name and OS are added here. */
  machine: Omit<LlmMachine, 'hostname' | 'os'>;
}

/** Pushed on 'llm:progress' while a run goes: the phase and, inside the runs, which one at which depth. 'load' is the cold load with its discarded warm-up. */
export interface LlmProgress {
  model: string;
  phase: 'evict' | 'idle' | 'load' | 'run' | 'done';
  run: number;
  runs: number;
  depth: number;
}

/** Everything on disk: the card's own rows and llama-benchy's. */
export interface LlmStore {
  results: LlmBenchResult[];
  benchy: BenchyResult[];
}

/** Pushed on 'llm:benchyProgress': llama-benchy's last line of output while it runs. */
export interface BenchyProgress {
  model: string;
  line: string;
}

/** Whether llama-benchy can run here: the `uvx` launcher found, or the install line to show. */
export interface BenchyStatus {
  uvx: string | null;
  installHint: string;
}

/** A 27B model can take a minute to page in before the first token; a 16k-deep prompt then adds a long prefill. */
const GENERATE_TIMEOUT_MS = 15 * 60_000;
/** llama-benchy's whole sweep, three depths and warmups on a large model, plus its first-run package download. */
const BENCHY_TIMEOUT_MS = 40 * 60_000;
const BENCHY_PP = 1024;
const BENCHY_TG = 256;

const filePath = () => path.join(app.getPath('userData'), 'llm-bench.json');

function readAll(): LlmStore {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { results?: unknown[]; benchy?: unknown[] };
    return { results: (j.results ?? []).filter(validResult), benchy: (j.benchy ?? []).filter(validBenchy) };
  } catch {
    return { results: [], benchy: [] };
  }
}

function writeAll(store: LlmStore) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(store, null, 2));
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
  private offTick: (() => void) | null = null;
  /**
   * macOS: every row the collector ticks (one per macmon line, 2 Hz while the run holds its
   * sensor lease) rather than a 250 ms poll, which read each half-second row twice or once.
   */
  private readonly fromTicks = process.platform === 'darwin';
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

  private fromValues(values: Record<string, number>, t: number): LlmSample {
    const v = (id?: string) => (id !== undefined && Number.isFinite(values[id]) ? values[id] : null);
    return { t, gpuW: v(this.ids.gpuW), cpuW: v(this.ids.cpuW), systemW: v(this.ids.systemW), gpuMemMiB: v(this.ids.gpuMemMiB) };
  }

  /** One reading now, stamped `t`: the sensor rows first, NVML's own facts (a PC's board power and VRAM) where a row is missing. */
  private async read(t: number): Promise<LlmSample | null> {
    if (!this.connected) return null;
    let sample: LlmSample = { t, gpuW: null, cpuW: null, systemW: null, gpuMemMiB: null };
    try {
      const row = await this.collector!.sensorsLatest();
      sample = this.fromValues(row.values, t);
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

  /** Readings into `into`, each stamped with the milliseconds since `origin` (when the request was sent). */
  start(into: LlmSample[], origin = Date.now()) {
    this.stop();
    if (!this.connected) return;
    if (this.fromTicks) {
      const c = this.collector!;
      const onTick = (tick: Tick) => into.push(this.fromValues(tick.sensors, Date.now() - origin));
      c.on('tick', onTick);
      this.offTick = () => c.off('tick', onTick);
      return;
    }
    this.timer = setInterval(() => {
      this.read(Date.now() - origin).then((s) => s && into.push(s));
    }, SAMPLE_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offTick?.();
    this.offTick = null;
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
  /** GGUF metadata; "<arch>.context_length" is the model's trained window. */
  model_info?: Record<string, unknown>;
}

/** The model's trained context window from /api/show, null when the metadata does not say. */
export function contextLengthOf(show: Show): number | null {
  for (const [key, value] of Object.entries(show.model_info ?? {})) if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value;
  return null;
}

interface Tags {
  models?: { name: string; size: number }[];
}

interface Ps {
  models?: { name: string; size_vram?: number; context_length?: number }[];
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
const hostname = () => os.hostname().replace(/\.local$/, '');
const machineOf = (m: LlmBenchRequest['machine']): LlmMachine => ({ ...m, hostname: hostname(), os: osName() });

const output = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : String(out))));

/** `pmset -g batt`: "Now drawing from 'AC Power'" or "'Battery Power'"; null when it says neither. */
export function powerSourceOf(pmsetBatt: string): 'ac' | 'battery' | null {
  const m = /drawing from '([^']+)'/.exec(pmsetBatt);
  return !m ? null : /battery/i.test(m[1]) ? 'battery' : /ac/i.test(m[1]) ? 'ac' : null;
}

/** `pmset -g`: Low Power Mode is lowpowermode 1 on most Macs and powermode 1 where a High Power mode exists (the 14" and 16" Max). */
export function lowPowerModeOf(pmset: string): boolean | null {
  const m = /\blowpowermode\s+(\d)/.exec(pmset) ?? /\bpowermode\s+(\d)/.exec(pmset);
  return m ? m[1] === '1' : null;
}

/** An Ollama setting as the daemon sees it: this process's environment, else launchd's (the Ollama app reads `launchctl setenv`). */
async function ollamaEnv(name: string): Promise<string | null> {
  const own = process.env[name]?.trim();
  if (own) return own;
  return (await output('launchctl', ['getenv', name])).trim() || null;
}

/**
 * macOS: the settings that move the figures without changing the hardware, into the machine
 * record. Windows keeps its record as it was.
 */
async function machineExtras(): Promise<Partial<LlmMachine>> {
  if (process.platform !== 'darwin') return {};
  const [version, flashAttention, kvCacheType, batt, pmset] = await Promise.all([
    ollamaJson<{ version?: string }>('/api/version').then((v) => v.version ?? null, () => null),
    ollamaEnv('OLLAMA_FLASH_ATTENTION'),
    ollamaEnv('OLLAMA_KV_CACHE_TYPE'),
    output('pmset', ['-g', 'batt']),
    output('pmset', ['-g'])
  ]);
  const mode = powerModeOf(pmset).name;
  return { ollamaVersion: version, flashAttention, kvCacheType, powerSource: powerSourceOf(batt), lowPowerMode: lowPowerModeOf(pmset), powerMode: mode === 'Unknown' ? null : mode };
}

async function run(req: LlmBenchRequest, collector: CollectorClient | null, progress: (p: LlmProgress) => void): Promise<LlmBenchResult | BenchError> {
  const runs = Math.max(1, Math.min(9, Math.round(req.runs ?? DEFAULT_RUNS)));
  const controller = new AbortController();
  current = controller;
  const signal = controller.signal;
  const sampler = new Sampler(collector, req.machine.gpuName);
  // macOS: the sensors at 2 Hz for the whole run (nothing on Windows).
  const lease = collector?.lease('llm benchmark') ?? null;
  const report = (phase: LlmProgress['phase'], runIndex = 0, depth = 0) => progress({ model: req.model, phase, run: runIndex, runs, depth });
  try {
    // The model's own description and size, so the row says what was timed (a 27B at Q4 is not a 27B at Q8).
    const [show, tags, extras] = await Promise.all([ollamaJson<Show>('/api/show', { model: req.model }), ollamaJson<Tags>('/api/tags'), machineExtras()]);
    const tag = (tags.models ?? []).find((m) => m.name === req.model);
    const model: LlmModel = {
      name: req.model,
      parameterSize: show.details?.parameter_size ?? '',
      quantization: show.details?.quantization_level ?? '',
      family: show.details?.family ?? '',
      sizeBytes: tag?.size ?? 0
    };
    // One window for every request, so Ollama loads the model once; a depth that does not fit it is skipped.
    const plan = sweepPlan(contextLengthOf(show));
    // Evict so the first request is a cold load: the figure Ollama's verbose output calls load duration.
    report('evict');
    await ollamaJson('/api/generate', { model: req.model, keep_alive: 0 }, 10_000, signal);
    // The sensor list and the idle baseline from rows at the leased rate, not the last 5 s sample.
    await lease?.fresh;
    await sampler.prepare();
    report('idle');
    const idle: LlmSample[] = [];
    sampler.start(idle);
    await sleep(IDLE_SECONDS * 1000, signal).finally(() => sampler.stop());
    const generate = async (prompt: string, into: LlmSample[]): Promise<{ g: Generate; wallMs: number }> => {
      const sent = Date.now();
      sampler.start(into, sent);
      try {
        const g = await ollamaJson<Generate>(
          '/api/generate',
          { model: req.model, prompt, stream: false, keep_alive: KEEP_ALIVE, options: { num_predict: PREDICT_TOKENS, num_ctx: plan.numCtx, temperature: 0, seed: SEED } },
          GENERATE_TIMEOUT_MS,
          signal
        );
        return { g, wallMs: Date.now() - sent };
      } finally {
        sampler.stop();
      }
    };
    // The cold load and one warm-up generation in the same request: the load is timed, the
    // generation (weights paging in, kernels built on first use) is discarded.
    report('load');
    const warm = await generate(promptForRun(0, runs, 0), []);
    if (!warm.g.eval_count || !warm.g.eval_duration) return { error: `${req.model} generated nothing to time in the warm-up` };
    const busy: LlmSample[] = [];
    const results: LlmRun[] = [];
    for (const depth of plan.depths) {
      for (let i = 1; i <= runs; i++) {
        report('run', i, depth);
        const samples: LlmSample[] = [];
        const { g, wallMs } = await generate(promptForRun(i, runs, depth), samples);
        if (!g.eval_count || !g.eval_duration) return { error: `${req.model} generated nothing to time at depth ${depth}` };
        busy.push(...samples);
        results.push({
          depth,
          promptEvalCount: g.prompt_eval_count ?? 0,
          promptEvalMs: (g.prompt_eval_duration ?? 0) / 1e6,
          evalCount: g.eval_count,
          evalMs: g.eval_duration / 1e6,
          loadMs: (g.load_duration ?? 0) / 1e6,
          totalMs: (g.total_duration ?? 0) / 1e6,
          wallMs,
          samples
        });
      }
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
      machine: { ...machineOf(req.machine), ...extras },
      model,
      runs: results,
      idle,
      busy,
      residentBytes,
      numCtx: plan.numCtx,
      loadMs: (warm.g.load_duration ?? 0) / 1e6,
      warmupRuns: 1
    });
    const store = readAll();
    writeAll({ ...store, results: supersede(store.results, result, (r) => r.model.name) });
    return result;
  } catch (e) {
    return ollamaError(e);
  } finally {
    sampler.stop();
    lease?.release();
    if (current === controller) current = null;
  }
}

function cancel() {
  current?.abort();
  current = null;
}

// ------------------------------------------------------------- llama-benchy

/** Where uv's installer and Homebrew put `uvx`, checked after PATH: the app is launched from a Dock icon that has no shell profile. */
function uvxCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, '.local', 'bin', 'uvx.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'uv', 'uvx.exe'),
      path.join(home, '.cargo', 'bin', 'uvx.exe')
    ];
  }
  return ['/opt/homebrew/bin/uvx', '/usr/local/bin/uvx', path.join(home, '.local', 'bin', 'uvx'), path.join(home, '.cargo', 'bin', 'uvx')];
}

export function findUvx(): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['uvx'], { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0]
      .trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return uvxCandidates().find((p) => fs.existsSync(p)) ?? null;
}

export function benchyStatus(): BenchyStatus {
  return {
    uvx: findUvx(),
    installHint:
      process.platform === 'win32'
        ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : process.platform === 'darwin'
          ? 'brew install uv'
          : 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  };
}

/**
 * The HuggingFace tokenizer llama-benchy sizes its prompt with, by Ollama's model family.
 * Only the sizing depends on it (the server's own token count corrects the prompt after the
 * warmup), so an ungated relative of the family is enough, and an unknown family gets Qwen's.
 */
export function tokenizerFor(family: string, name: string): string {
  const f = `${family} ${name}`.toLowerCase();
  if (/gemma/.test(f)) return 'unsloth/gemma-3-1b-it';
  if (/llama/.test(f)) return 'unsloth/Llama-3.2-1B-Instruct';
  if (/mistral|mixtral|devstral|magistral/.test(f)) return 'unsloth/Mistral-7B-Instruct-v0.3';
  if (/phi/.test(f)) return 'microsoft/Phi-4-mini-instruct';
  if (/gpt-oss|gptoss/.test(f)) return 'openai/gpt-oss-20b';
  if (/deepseek/.test(f)) return 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B';
  return 'Qwen/Qwen2.5-7B-Instruct';
}

let benchyChild: ChildProcess | null = null;
let benchyInFlight: Promise<BenchyResult | BenchError> | null = null;

async function runBenchy(req: LlmBenchRequest, progress: (p: BenchyProgress) => void): Promise<BenchyResult | BenchError> {
  const uvx = findUvx();
  if (!uvx) return { error: `uvx not found; install uv first (${benchyStatus().installHint})` };
  const runs = Math.max(1, Math.min(9, Math.round(req.runs ?? DEFAULT_RUNS)));
  let family = '';
  let contextLength: number | null = null;
  try {
    const show = await ollamaJson<Show>('/api/show', { model: req.model });
    family = show.details?.family ?? '';
    // llama-benchy speaks Ollama's OpenAI endpoint, which takes no context option: the model runs at
    // Ollama's own window, so load it once and read that window, then skip any depth it would truncate.
    await ollamaJson('/api/generate', { model: req.model, prompt: 'hi', stream: false, keep_alive: KEEP_ALIVE, options: { num_predict: 1 } }, GENERATE_TIMEOUT_MS);
    const ps = await ollamaJson<Ps>('/api/ps');
    contextLength = (ps.models ?? []).find((m) => m.name === req.model)?.context_length ?? null;
  } catch (e) {
    return ollamaError(e);
  }
  const fits = (depth: number) => contextLength === null || depth + BENCHY_PP + BENCHY_TG + 256 <= contextLength;
  const depths = DEPTHS.filter(fits);
  const out = path.join(app.getPath('userData'), `llama-benchy-${Date.now()}.json`);
  const args = [
    'llama-benchy',
    '--base-url', `${OLLAMA}/v1`,
    '--model', req.model,
    '--tokenizer', tokenizerFor(family, req.model),
    '--pp', String(BENCHY_PP),
    '--tg', String(BENCHY_TG),
    '--depth', ...depths.map(String),
    '--runs', String(runs),
    '--latency-mode', 'generation',
    '--format', 'json',
    '--save-result', out
  ];
  progress({ model: req.model, line: `${path.basename(uvx)} ${args.join(' ')}` });
  const child = spawn(uvx, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' } });
  benchyChild = child;
  let stderr = '';
  let lastLine = '';
  const onData = (d: string) => {
    for (const raw of d.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      lastLine = line;
      progress({ model: req.model, line });
    }
  };
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', onData);
  child.stderr?.on('data', (d: string) => {
    stderr += d;
    onData(d);
  });
  const outcome = await new Promise<{ code: number | null; cancelled: boolean; timedOut: boolean }>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BENCHY_TIMEOUT_MS);
    const done = (code: number | null) => {
      clearTimeout(timer);
      const cancelled = benchyChild === null;
      if (benchyChild === child) benchyChild = null;
      resolve({ code, cancelled, timedOut });
    };
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
  if (outcome.cancelled) return { error: 'llama-benchy stopped', code: 'cancelled' };
  if (outcome.timedOut) return { error: `llama-benchy did not finish within ${BENCHY_TIMEOUT_MS / 60_000} minutes` };
  let text = '';
  try {
    text = fs.readFileSync(out, 'utf-8');
  } catch {
    const tail = (stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ') || lastLine).slice(0, 400);
    return { error: `llama-benchy exited with code ${outcome.code} and wrote no result${tail ? `: ${tail}` : ''}` };
  }
  fs.rm(out, { force: true }, () => {});
  const parsed = parseBenchyJson(text);
  if ('error' in parsed) return parsed;
  const result: BenchyResult = {
    id: randomUUID(),
    measuredAt: new Date().toISOString(),
    machine: machineOf(req.machine),
    model: req.model,
    version: parsed.version,
    latencyMode: parsed.latencyMode,
    latencyMs: parsed.latencyMs,
    contextLength,
    args: args.filter((a) => a !== out && a !== '--save-result').join(' '),
    rows: parsed.rows,
    imported: false
  };
  const store = readAll();
  writeAll({ ...store, benchy: supersede(store.benchy, result, (r) => r.model) });
  return result;
}

function cancelBenchy() {
  const child = benchyChild;
  if (!child) return;
  benchyChild = null;
  child.kill();
}

// ---------------------------------------------------------------- export/import

async function exportResults(e: IpcMainInvokeEvent): Promise<string | null> {
  const store = readAll();
  const file: LlmBenchFile = { strataLlmBench: 1, exportedAt: new Date().toISOString(), results: store.results, benchy: store.benchy };
  const win = BrowserWindow.fromWebContents(e.sender);
  const host = hostname().replace(/[^\w.-]+/g, '-');
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

async function importResults(e: IpcMainInvokeEvent): Promise<(LlmStore & { added: number }) | BenchError> {
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = {
    title: 'Import LLM benchmark',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Strata Tune LLM benchmark', extensions: ['json'] }],
    properties: ['openFile' as const]
  };
  const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  if (r.canceled || r.filePaths.length === 0) return { ...readAll(), added: 0 };
  let text: string;
  try {
    text = fs.readFileSync(r.filePaths[0], 'utf-8');
  } catch (err) {
    return { error: `Could not read the file: ${(err as Error).message}` };
  }
  const parsed = parseBenchFile(text);
  if ('error' in parsed) return parsed;
  const have = readAll();
  const known = new Set([...have.results.map((x) => x.id), ...have.benchy.map((x) => x.id)]);
  const freshResults = parsed.results.filter((x) => !known.has(x.id));
  const freshBenchy = parsed.benchy.filter((x) => !known.has(x.id));
  const merged: LlmStore = {
    results: freshResults.reduce((rows, r) => supersede(rows, r, (x) => x.model.name), have.results),
    benchy: freshBenchy.reduce((rows, r) => supersede(rows, r, (x) => x.model), have.benchy)
  };
  writeAll(merged);
  return { ...merged, added: freshResults.length + freshBenchy.length };
}

// --------------------------------------------------------------------- IPC

export function registerLlmBenchIpc(ipcMain: IpcMain, collector: () => CollectorClient | null, send: (channel: string, payload: LlmProgress | BenchyProgress) => void) {
  ipcMain.handle('llm:list', () => readAll());
  ipcMain.handle('llm:run', (_e, req: LlmBenchRequest) => {
    // A second Run while one goes joins it: two generations on the card at once would time each other.
    if (!inFlight) inFlight = keepAwakeOnMac('llm benchmark', () => run(req, collector(), (p) => send('llm:progress', p))).finally(() => (inFlight = null));
    return inFlight;
  });
  ipcMain.handle('llm:cancel', () => cancel());
  ipcMain.handle('llm:delete', (_e, id: string): LlmStore => {
    const store = readAll();
    const kept = { results: store.results.filter((r) => r.id !== id), benchy: store.benchy.filter((r) => r.id !== id) };
    writeAll(kept);
    return kept;
  });
  ipcMain.handle('llm:export', (e) => exportResults(e));
  ipcMain.handle('llm:import', (e) => importResults(e));
  ipcMain.handle('llm:benchyStatus', () => benchyStatus());
  ipcMain.handle('llm:benchy', (_e, req: LlmBenchRequest) => {
    if (!benchyInFlight) benchyInFlight = keepAwakeOnMac('llama-benchy', () => runBenchy(req, (p) => send('llm:benchyProgress', p))).finally(() => (benchyInFlight = null));
    return benchyInFlight;
  });
  ipcMain.handle('llm:benchyCancel', () => cancelBenchy());
}
