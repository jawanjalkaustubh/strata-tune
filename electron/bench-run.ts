/**
 * The built-in stutter bench as a capture (master plan section 11a). This file owns the
 * child: where strata-tune-bench.exe is, whether the GPU is free enough to run it
 * (section 20), how big its window should be, and what its exit code and --json summary
 * mean. The capture itself (PresentMon on the bench's pid, the session, the report) is the
 * ordinary path in electron/capture.ts with the trigger 'bench'.
 */
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, type Display } from 'electron';
import benchmarks from '../src/data/benchmarks.json';
import { pidAlive } from './presence';

export const BENCH_EXE: string = benchmarks.builtIn.exe;
export const BENCH_SECONDS: number = benchmarks.builtIn.seconds;

/** One segment of the bench's own summary line (collector/StrataTune.Bench/README.md). */
export interface BenchSegment {
  name: string;
  start: number;
  end: number;
  frames: number;
  avgFps: number;
  maxFrameMs: number;
  avgGpuMs: number;
}

/** The bench's --json line, stored in session.json as benchSummary. */
export interface BenchSummary {
  script: string;
  device: string;
  luid: number;
  pid: number;
  width: number;
  height: number;
  vsync: boolean;
  fpsCap: number;
  vramTargetPercent: number;
  completed: boolean;
  frames: number;
  seconds: number;
  segments: BenchSegment[];
  pipelineStates: number;
  texturesUploaded: number;
  uploadedMiB: number;
  heavyIterations: number;
}

export interface BenchExit {
  code: number | null;
  summary: BenchSummary | null;
  /** null for a completed run or one the user ended; otherwise one plain sentence. */
  message: string | null;
}

export interface BenchChild {
  pid: number;
  path: string;
  done: Promise<BenchExit>;
  /** Asks the bench to end early (its window closes, the summary still prints); forced after a bound. */
  close(): Promise<void>;
}

/** The largest client area the bench is asked for: the chart reads the same on every card at 1080p or under. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
/** Where the bench puts its window (Window.cs) and roughly what its caption and borders add at 100 % scale. */
const WINDOW_OFFSET = 64;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 40;
const CLOSE_WAIT_MS = 3000;
const TASKLIST_TIMEOUT_MS = 5000;
const OLLAMA_PS = 'http://127.0.0.1:11434/api/ps';
const OLLAMA_TIMEOUT_MS = 1500;
/** Other GPU work the bench must not share the card with; a second bench included. */
const GPU_IMAGES = ['strata-tune-worker.exe', BENCH_EXE];

/** The family's gpu.lock, exactly where GpuLock.cs and strata-video's gpu-lock.ts keep it. */
export const lockFile = () => path.join(process.env.STRATA_AI_DEV || 'C:\\AI_dev', 'Claude', '.strata', 'gpu.lock');

/** Dev: the Release build in the solution tree. Packaged: resources/collector beside the collector and the worker. */
export function benchExe(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'collector', BENCH_EXE);
  return path.join(app.getAppPath(), 'collector', 'StrataTune.Bench', 'bin', 'x64', 'Release', 'net10.0', 'win-x64', BENCH_EXE);
}

/**
 * The primary display's pixels, capped at 1080p, then shrunk to fit its work area: the
 * bench window is captioned and sits at (64, 64), so a client area the size of the screen
 * would hang off it. Sizes are physical pixels because the bench is per-monitor DPI aware.
 */
export function benchSize(display: Pick<Display, 'size' | 'workAreaSize' | 'scaleFactor'>): { width: number; height: number } {
  const scale = display.scaleFactor || 1;
  let width = Math.min(MAX_WIDTH, Math.round(display.size.width * scale));
  let height = Math.min(MAX_HEIGHT, Math.round(display.size.height * scale));
  const fitW = Math.round(display.workAreaSize.width * scale) - WINDOW_OFFSET - Math.round(FRAME_WIDTH * scale);
  const fitH = Math.round(display.workAreaSize.height * scale) - WINDOW_OFFSET - Math.round(FRAME_HEIGHT * scale);
  const shrink = Math.min(1, fitW / width, fitH / height);
  if (shrink < 1) {
    width = Math.floor((width * shrink) / 2) * 2;
    height = Math.floor((height * shrink) / 2) * 2;
  }
  return { width: Math.max(64, width), height: Math.max(64, height) };
}

/** The bench's exit codes (Program.cs) in plain words; null when there is nothing to say. */
export function benchExitMessage(code: number | null, stderrTail: string): string | null {
  switch (code) {
    case 0:
    case 2:
      return null;
    case 3:
      return 'The bench found no DX12 hardware GPU';
    case 10:
      return `The GPU was lost during the bench (the driver reset it)${stderrTail ? `: ${stderrTail}` : ''}`;
    case 11:
      return stderrTail || 'Another Strata app holds the GPU lock';
    default:
      return `The bench exited with code ${code ?? 'unknown'}${stderrTail ? `: ${stderrTail}` : ''}`;
  }
}

/** The one JSON line --json promises; the last brace-led line wins should anything else land on stdout. */
export function parseSummary(stdout: string): BenchSummary | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).reverse();
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as Partial<BenchSummary>;
      if (typeof j.frames === 'number' && Array.isArray(j.segments)) return j as BenchSummary;
    } catch {
      /* not the summary */
    }
  }
  return null;
}

const LABEL: Record<string, string> = { 'strata-code': 'Strata Code', 'strata-photo': 'Strata Photo', 'strata-video': 'Strata Video', 'strata-tune': 'Strata Tune', 'strata-tune-bench': 'Another bench run' };

/** Who holds gpu.lock as a sentence, or null when it is free; the same rule as GpuLock.HeldBy, minus the clearing, which the bench does itself. */
export function lockHolder(file = lockFile(), ownPid = process.pid): string | null {
  let entry: { holder?: string; pid?: number };
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const pid = Number(entry.pid);
  if (!pidAlive(pid) || pid === ownPid) return null;
  return `${LABEL[String(entry.holder)] ?? 'Another app'} is using the GPU (pid ${pid}); the bench needs the card to itself.`;
}

/** Which of `images` tasklist finds running, in the order given. */
function runningImages(images: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const names = new Set<string>();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line);
        if (m) names.add(m[1].toLowerCase());
      }
      resolve(images.filter((i) => names.has(i.toLowerCase())));
    });
  });
}

/** Models Ollama holds on the card; empty when it is not running or does not answer. */
async function ollamaResident(): Promise<string[]> {
  try {
    const res = await fetch(OLLAMA_PS, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: { name?: string }[] };
    return (j.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Section 20: a bench with anything else on the GPU is invalid, so it is refused up front
 * with the reason, rather than the bench's own exit 11 a second later. The sentence, or null.
 */
export async function preflight(): Promise<string | null> {
  const exe = benchExe();
  if (!fs.existsSync(exe)) return `The bench is not built: run dotnet build collector\\StrataTune.sln -c Release (expected at ${exe})`;
  const running = await runningImages(GPU_IMAGES);
  if (running.length > 0) return `${running[0]} is running; wait for it to finish before starting the bench`;
  const holder = lockHolder();
  if (holder) return holder;
  const resident = await ollamaResident();
  if (resident.length > 0) return `Ollama has ${resident.join(', ')} in video memory; the bench would measure it too. Wait for it to unload or stop Ollama first.`;
  return null;
}

/** WM_CLOSE to the bench's window: it ends the run as Esc does, exit 2, summary printed. */
function closeWindow(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='SilentlyContinue'; (Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`],
      { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS },
      () => resolve()
    );
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the full script at the given size; `done` settles when the process ends, with its summary and its code read. */
export function spawnBench(size: { width: number; height: number }): BenchChild {
  const exe = benchExe();
  const args = ['--script', 'full', '--json', '--width', String(size.width), '--height', String(size.height)];
  // Not windowsHide: that flag puts SW_HIDE in the child's STARTUPINFO and its first ShowWindow obeys it, so the bench
  // window would present unseen. detached (DETACHED_PROCESS) is what keeps a packaged app, which has no console, from
  // opening one for the bench; the pipes and the exit still arrive, and dispose() closes it when the app quits.
  const child = spawn(exe, args, { detached: true, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.pid) throw new Error(`Could not start ${exe}`);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf-8');
  child.stderr!.setEncoding('utf-8');
  child.stdout!.on('data', (d: string) => (stdout += d));
  child.stderr!.on('data', (d: string) => (stderr = (stderr + d).slice(-600)));
  const done = new Promise<BenchExit>((resolve) => {
    child.on('error', (e) => resolve({ code: null, summary: null, message: `Could not run the bench: ${e.message}` }));
    child.on('close', (code) => {
      const tail = stderr.trim().split(/\r?\n/).pop() ?? '';
      resolve({ code, summary: parseSummary(stdout), message: benchExitMessage(code, tail) });
    });
  });
  let ended = false;
  void done.then(() => (ended = true));
  return {
    pid: child.pid,
    path: exe,
    done,
    async close() {
      if (ended) return;
      await closeWindow(child.pid!);
      await Promise.race([done, delay(CLOSE_WAIT_MS)]);
      if (!ended) child.kill();
    }
  };
}
