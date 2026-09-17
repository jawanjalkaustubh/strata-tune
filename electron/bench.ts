/**
 * Measured inputs for the AI stats card (master plan section 10): the worker's
 * bandwidth and matmul kernels, and a timed Ollama generation. The worker
 * needs no elevation, so it is spawned from here rather than through the
 * collector; the result is cached per GPU and driver in bench.json because a
 * card's bandwidth does not change until the driver does.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, type IpcMain } from 'electron';
import type { CollectorClient } from './collector';

/** One --bench --json line from the worker plus what the cache needs to decide reuse. */
export interface GpuBench {
  device: string;
  luid: string;
  bandwidthGBs: number;
  bandwidthMedianGBs: number | null;
  bufferBytes: number | null;
  matmulN: number | null;
  matmulTflopsFp32: number;
  /** The worker's matmulTflopsFp16storage: half storage with float arithmetic, not tensor-core FP16. */
  matmulTflopsFp16: number | null;
  elapsedMs: number | null;
  /** The GPU driver the caller knew at measure time (from the collector snapshot); null standalone. */
  driver: string | null;
  measuredAt: string;
  /**
   * The highest SM and memory clocks the collector saw while the sweep ran (plan section 10):
   * the ceiling the measurement is judged against is the one in force when it was taken, not
   * the card's record. Null without the collector; absent in bench.json files from before it.
   */
  heldSmMhz?: number | null;
  heldMemMhz?: number | null;
}

export interface BenchGpuRequest {
  driver: string | null;
  /** false: answer from bench.json only (null when nothing usable is cached). */
  run: boolean;
}

export interface OllamaBench {
  model: string;
  tokPerSec: number;
  promptTokPerSec: number;
  loadMs: number;
  totalMs: number;
}

export interface OllamaInstalled {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  family: string;
  contextLength: number | null;
}

export interface OllamaList {
  installed: OllamaInstalled[];
  loaded: { name: string; sizeVramBytes: number }[];
  /** Where Ollama keeps its blobs, so the page can pick the model drive's free space. */
  modelsDir: string;
}

export interface BenchError {
  error: string;
  /** Nothing answers on :11434: the page shows the plan's install line instead of an error. */
  code?: 'ollama-absent';
}

const OLLAMA = 'http://127.0.0.1:11434';
/** Family-wide: Strata Code, Photo and Video share the daemon, so a model is never evicted sooner. */
const KEEP_ALIVE = '15m';
const BENCH_TIMEOUT_MS = 90_000;
/** A 70B model can take a minute to page in before the first token. */
const GENERATE_TIMEOUT_MS = 5 * 60_000;
const PREDICT_TOKENS = 256;

// About sixty tokens. The same text every time so runs compare.
const PROMPT =
  'Continue the following paragraph in plain prose for about two hundred and fifty words, with no headings, lists or questions, ' +
  'and do not stop early. The city woke slowly that morning: fog lifted off the river as the first trams rattled across the ' +
  'iron bridge, the bakeries along the quay lit their ovens, and';

const benchPath = () => path.join(app.getPath('userData'), 'bench.json');

/** Dev: the Release build in the solution tree. Packaged: resources/collector next to the app (same rule as the collector client). */
function workerExe(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'collector', 'strata-tune-worker.exe');
  const dir = path.join(app.getAppPath(), 'collector', 'StrataTune.Worker', 'bin', 'x64', 'Release', 'net10.0', 'win-x64');
  const names = ['strata-tune-worker.exe', 'StrataTune.Worker.exe'];
  return names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p)) ?? path.join(dir, names[0]);
}

function readCache(): GpuBench | null {
  try {
    const b = JSON.parse(fs.readFileSync(benchPath(), 'utf-8')) as Partial<GpuBench>;
    return typeof b.device === 'string' && typeof b.bandwidthGBs === 'number' && typeof b.measuredAt === 'string' ? (b as GpuBench) : null;
  } catch {
    return null;
  }
}

function writeCache(b: GpuBench) {
  try {
    fs.mkdirSync(path.dirname(benchPath()), { recursive: true });
    fs.writeFileSync(benchPath(), JSON.stringify(b, null, 2));
  } catch (e) {
    console.warn('[bench] could not write bench.json:', (e as Error).message);
  }
}

/** A measurement is reused until the driver changes; an unknown driver (standalone page) cannot invalidate it. */
function usable(cached: GpuBench | null, driver: string | null): GpuBench | null {
  if (!cached) return null;
  return driver === null || cached.driver === null || cached.driver === driver ? cached : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The worker prints its device line first and the JSON line last; only the JSON counts. */
function parseBenchLine(stdout: string, driver: string | null): GpuBench | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const bandwidthGBs = num(j.bandwidthGBs);
      const fp32 = num(j.matmulTflopsFp32);
      if (bandwidthGBs === null || fp32 === null) continue;
      return {
        device: String(j.device ?? 'unknown device'),
        luid: String(j.luid ?? ''),
        bandwidthGBs,
        bandwidthMedianGBs: num(j.bandwidthMedianGBs),
        bufferBytes: num(j.bufferBytes),
        matmulN: num(j.matmulN),
        matmulTflopsFp32: fp32,
        matmulTflopsFp16: num(j.matmulTflopsFp16storage),
        elapsedMs: num(j.elapsedMs),
        driver,
        measuredAt: new Date().toISOString()
      };
    } catch {
      /* a brace-led log line, not the result */
    }
  }
  return null;
}

function runWorker(exe: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(exe, ['--bench', '--json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BENCH_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

let inFlight: Promise<GpuBench | BenchError> | null = null;

/** A second Measure while one runs joins it: two kernels on the card at once would measure each other. */
function benchGpu(driver: string | null, collector: CollectorClient | null): Promise<GpuBench | BenchError> {
  if (!inFlight) inFlight = doBenchGpu(driver, collector).finally(() => (inFlight = null));
  return inFlight;
}

/** The sweep reaches P0 within its first pass; 4 Hz sees it many times over in a 3 s run. */
const HELD_POLL_MS = 250;

/** Polls the collector's /gpu while `until` runs and answers the highest clocks seen; null without a connected collector or a reading. */
async function heldDuring<T>(collector: CollectorClient | null, until: Promise<T>): Promise<{ smMhz: number; memMhz: number } | null> {
  if (collector?.state.status !== 'connected') return null;
  let held: { smMhz: number; memMhz: number } | null = null;
  const timer = setInterval(() => {
    collector
      .gpu()
      .then((g) => {
        const c = g[0]?.clocks;
        if (c) held = { smMhz: Math.max(held?.smMhz ?? 0, c.smMhz), memMhz: Math.max(held?.memMhz ?? 0, c.memMhz) };
      })
      .catch(() => {
        /* the collector went away mid-run; the bench line stands without its clocks */
      });
  }, HELD_POLL_MS);
  await until.finally(() => clearInterval(timer));
  return held;
}

async function doBenchGpu(driver: string | null, collector: CollectorClient | null): Promise<GpuBench | BenchError> {
  const exe = workerExe();
  if (!fs.existsSync(exe)) return { error: `Worker not built: ${exe}. Run dotnet build collector\\StrataTune.sln -c Release.` };
  const running = runWorker(exe);
  const held = await heldDuring(collector, running);
  const run = await running;
  if (run.timedOut) return { error: `The GPU benchmark did not finish within ${BENCH_TIMEOUT_MS / 1000} s` };
  const firstErr = run.stderr.trim().split(/\r?\n/)[0] || '';
  if (run.code === 3) return { error: 'No hardware GPU: the worker was given the software rasteriser (WARP)' };
  if (run.code === 10) return { error: 'The GPU was lost during the benchmark (TDR); the driver reset it' };
  if (run.code !== 0) return { error: `The worker exited with code ${run.code}${firstErr ? `: ${firstErr}` : ''}` };
  const parsed = parseBenchLine(run.stdout, driver);
  if (!parsed) return { error: 'The worker finished but printed no bench result line' };
  const result: GpuBench = { ...parsed, heldSmMhz: held?.smMhz ?? null, heldMemMhz: held?.memMhz ?? null };
  writeCache(result);
  return result;
}

// ------------------------------------------------------------------ Ollama

function ollamaError(e: unknown): BenchError {
  const cause = (e as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNREFUSED') return { error: 'Ollama is not running', code: 'ollama-absent' };
  if (e instanceof Error && e.name === 'TimeoutError') return { error: 'Ollama did not answer in time' };
  return { error: e instanceof Error ? e.message : String(e) };
}

async function ollamaJson<T>(route: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`${OLLAMA}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim();
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain text body */
    }
    throw new Error(`Ollama answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

async function benchOllama(model: string): Promise<OllamaBench | BenchError> {
  interface Generate {
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    load_duration?: number;
    total_duration?: number;
  }
  try {
    const g = await ollamaJson<Generate>(
      '/api/generate',
      { model, prompt: PROMPT, stream: false, options: { num_predict: PREDICT_TOKENS }, keep_alive: KEEP_ALIVE },
      GENERATE_TIMEOUT_MS
    );
    if (!g.eval_count || !g.eval_duration) return { error: `${model} generated nothing to time` };
    const perSec = (count: number | undefined, ns: number | undefined) => (count && ns ? count / (ns / 1e9) : 0);
    return {
      model,
      tokPerSec: perSec(g.eval_count, g.eval_duration),
      promptTokPerSec: perSec(g.prompt_eval_count, g.prompt_eval_duration),
      loadMs: (g.load_duration ?? 0) / 1e6,
      totalMs: (g.total_duration ?? 0) / 1e6
    };
  } catch (e) {
    return ollamaError(e);
  }
}

async function ollamaList(): Promise<OllamaList | BenchError> {
  interface Tags {
    models?: { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string; family?: string; context_length?: number } }[];
  }
  interface Ps {
    models?: { name: string; size_vram?: number }[];
  }
  try {
    const [tags, ps] = await Promise.all([ollamaJson<Tags>('/api/tags'), ollamaJson<Ps>('/api/ps')]);
    return {
      installed: (tags.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        parameterSize: m.details?.parameter_size ?? '',
        quantization: m.details?.quantization_level ?? '',
        family: m.details?.family ?? '',
        contextLength: num(m.details?.context_length)
      })),
      loaded: (ps.models ?? []).map((m) => ({ name: m.name, sizeVramBytes: m.size_vram ?? 0 })),
      modelsDir: process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models')
    };
  } catch (e) {
    return ollamaError(e);
  }
}

// --------------------------------------------------------------------- IPC

/** `collector` is read per run: the client is created after this registration and may not be connected. */
export function registerAdvisorIpc(ipcMain: IpcMain, collector: () => CollectorClient | null) {
  ipcMain.handle('bench:gpu', (_e, req: BenchGpuRequest) => (req.run ? benchGpu(req.driver, collector()) : usable(readCache(), req.driver)));
  ipcMain.handle('bench:ollama', (_e, model: string) => benchOllama(model));
  ipcMain.handle('ollama:list', () => ollamaList());
}
