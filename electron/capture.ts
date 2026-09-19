/**
 * Capture controller (master plan section 11): idle → armed (Game Mode watching)
 * → capturing → saving → done. A capture is PresentMon on one pid (electron/
 * presentmon.ts) with the collector's sensor rows and GPU facts written beside
 * the frames as they arrive (electron/sessions.ts). It starts by button with a
 * picked process or with the built-in bench (electron/bench-run.ts, a child of
 * ours whose exit ends the capture), or by Game Mode when a capture is armed: the
 * allowlist names the exe, the fullscreen probe and the hotkey take whatever
 * window is in front. It ends by button, when the game exits, or with the app.
 */
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { app, BrowserWindow, dialog, screen, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { BENCH_EXE, BENCH_SECONDS, benchSize, preflight, spawnBench, type BenchChild, type BenchExit } from './bench-run';
import type { CollectorClient } from './collector';
import { DEFAULT_ALLOWLIST, type GameMode, type GameModeState } from './game-mode';
import { curate, type ProcessInfo, type ProcessPick } from './picker';
import { availability, grantTraceAccess, PresentMonHost, traceAccess, type PresentMonAvailability, type PresentMonExit, type TraceAccess } from './presentmon';
import { hold, release } from './keepAwake';
import * as sessions from './sessions';
import type { CaptureSession, FrameRow, GpuSample } from '../src/analysis/session-types';
import type { HogsResult, SensorRow, StaticSnapshot, Tick } from '../src/collector-types';
import { exportReportFile, reportFileNameOf } from '../src/report/export';
import type { Report, ReportFile } from '../src/report/report-types';
import type { ScoreSheet } from '../src/report/score-types';

export type { PresentMonAvailability, TraceAccess } from './presentmon';
export type { SessionListItem } from './sessions';
export type { ProcessInfo, ProcessPick, PickGroup } from './picker';
export type { BenchSummary } from './bench-run';

export type CaptureStatus = 'idle' | 'armed' | 'capturing' | 'saving' | 'done' | 'error';

export interface CaptureTarget {
  pid: number;
  exe: string;
  /** 'manual', 'bench', or Game Mode's words. */
  trigger: string;
}

export interface CaptureState {
  status: CaptureStatus;
  /** Game Mode is watching for a game; a capture starts on its own when one appears. */
  armed: boolean;
  presentMon: PresentMonAvailability;
  /** Whether this account may open PresentMon's trace session (Performance Log Users); null until the check answers. */
  trace: TraceAccess | null;
  target: CaptureTarget | null;
  startedAt: string | null;
  frames: number;
  /** The last thing worth saying: the error, or where the capture was saved. */
  message: string;
  lastSessionId: string | null;
  /** How the last saved session started, so a finished bench opens its report on its own. */
  lastTrigger: string | null;
}

/** 2 Hz while capturing: the count and the last two seconds of frame times, oldest first, for the live sparkline. */
export interface CaptureFrames {
  count: number;
  recentMs: number[];
}

const FRAMES_PUSH_MS = 500;
const RECENT_WINDOW_MS = 2000;
/** The collector keeps ten minutes at full rate; slices well inside that keep the file complete for any length of capture. */
const SENSOR_SLICE_MS = 60_000;
const SENSOR_SLICE_S = 90;
const SAVE_TIMEOUT_MS = 20_000;
/** The static snapshot is a WMI walk; a slow one must not hold the save. */
const SNAPSHOT_WAIT_MS = 5000;
/** The collector's per-process sample at capture start, the classifier's only input for a background hog (§11 case 6). */
const HOGS_SAMPLE_S = 5;
/** PresentMon ends itself when the bench exits; the bench's own exit is waited for this long past that for its summary line. */
const BENCH_EXIT_WAIT_MS = 5000;
/** A bench that exits before presenting (lock held, no adapter) never trips PresentMon's proc-exit rule; it is stopped after this. */
const BENCH_GRACE_MS = 1500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ processes

function powershell(script: string, timeoutMs = 8000): Promise<string> {
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; ${script}`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    );
  });
}

interface PsProcess {
  Id: number;
  ProcessName: string;
  Path: string | null;
  MainWindowTitle: string | null;
}

/** ConvertTo-Json drops the array around a single object. */
function psList(json: string): PsProcess[] {
  const t = json.trim();
  if (!t) return [];
  const v = JSON.parse(t) as PsProcess | PsProcess[];
  return Array.isArray(v) ? v : [v];
}

const toInfo = (p: PsProcess): ProcessInfo => ({ pid: p.Id, exe: `${p.ProcessName}.exe`, path: p.Path || null, title: p.MainWindowTitle || '' });

const ALLOWLIST: ReadonlySet<string> = new Set(DEFAULT_ALLOWLIST);

/** Everything with a main window, our own window excluded, sorted into the picker's groups (electron/picker.ts). */
export async function listProcesses(): Promise<ProcessPick[]> {
  const out = await powershell(`Get-Process | Where-Object { $_.MainWindowTitle -and $_.Id -ne ${process.pid} } | Select-Object Id, ProcessName, Path, MainWindowTitle | ConvertTo-Json -Compress`);
  return curate(psList(out).map(toInfo), ALLOWLIST);
}

async function processInfo(pid: number): Promise<ProcessInfo | null> {
  const out = await powershell(`Get-Process -Id ${pid} | Select-Object Id, ProcessName, Path, MainWindowTitle | ConvertTo-Json -Compress`);
  const p = psList(out)[0];
  return p ? toInfo(p) : null;
}

/** A PowerShell single-quoted literal: nothing inside it expands, and a quote doubles. The name comes from the allowlist, a user setting. */
const psLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Every pid of that image name, lowest first: the game itself comes before helpers a launcher spawned after it. */
async function pidsByName(exe: string): Promise<number[]> {
  const out = await powershell(`Get-Process -Name ${psLiteral(exe.replace(/\.exe$/i, ''))} | Select-Object Id, ProcessName, Path, MainWindowTitle | ConvertTo-Json -Compress`);
  return psList(out)
    .map((p) => p.Id)
    .sort((a, b) => a - b);
}

const FOREGROUND = `Add-Type -Name F -Namespace W -MemberDefinition '[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'; $p=0; [void][W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(), [ref]$p); $p`;

/** The process behind the foreground window: what the fullscreen probe and the hotkey mean by "the game". */
async function foregroundPid(): Promise<number | null> {
  const pid = parseInt((await powershell(FOREGROUND)).trim().split('\n').pop() || '0', 10);
  return pid > 0 && pid !== process.pid ? pid : null;
}

/** Stopwatch.Frequency is QueryPerformanceFrequency: the clock PresentMon and the collector both stamp with. */
async function qpcFrequency(): Promise<number> {
  const f = parseInt((await powershell('[System.Diagnostics.Stopwatch]::Frequency')).trim(), 10);
  return f > 0 ? f : 10_000_000;
}

// ----------------------------------------------------------- controller

/** What one capture holds open between start and finish. */
interface Run {
  target: CaptureTarget;
  path: string | null;
  startedAt: Date;
  writer: sessions.SessionWriter;
  frames: number;
  qpcFirst: number | null;
  qpcLast: number | null;
  recent: { ms: number; sum: number }[];
  notes: string[];
  snapshot: Promise<StaticSnapshot | null>;
  hogs: Promise<HogsResult | null>;
  /** Highest sensor qpc written so far; the next slice starts after it. */
  sensorQpc: number;
  sensorTimer: NodeJS.Timeout | null;
  pushTimer: NodeJS.Timeout | null;
  onTick: ((t: Tick) => void) | null;
  /** The built-in bench when this run is one: its exit is the capture's end and its summary goes in session.json. */
  bench: BenchChild | null;
}

export class CaptureController extends EventEmitter {
  state: CaptureState;
  private run: Run | null = null;
  /** Both ways in spend time in PowerShell before they hold a run; a second start in that gap must not race the first. */
  private starting = false;
  private readonly presentMon = new PresentMonHost();
  private qpcFrequencyOnce: Promise<number> | null = null;

  constructor(
    private readonly collector: () => CollectorClient | null,
    private readonly gameMode: GameMode
  ) {
    super();
    this.state = { status: 'idle', armed: false, presentMon: availability(), trace: null, target: null, startedAt: null, frames: 0, message: '', lastSessionId: null, lastTrigger: null };
    void this.checkTrace();
    this.presentMon.on('frame', (rows: FrameRow[]) => this.frames(rows));
    this.presentMon.on('exit', (exit: PresentMonExit) => void this.finish(exit));
    // The fullscreen probe (a PowerShell spawn) runs only while armed; the faster poll too, so a game is caught within 10 s.
    gameMode.setCaptureArmedProvider(() => this.state.armed);
    gameMode.setBusyProvider(() => this.state.armed);
    gameMode.on('enter', (s: GameModeState) => void this.onGame(s.trigger ?? 'fullscreen'));
    // The hotkey toggles: a second press ends the capture it started.
    gameMode.on('exit', () => {
      if (this.run?.target.trigger === 'hotkey') void this.stop();
    });
  }

  private set(patch: Partial<CaptureState>): void {
    this.state = { ...this.state, ...patch };
    // Plan 17c: the machine stays awake while a capture runs or saves, and never past that (the display is not held).
    if (this.state.status === 'capturing' || this.state.status === 'saving') hold('capture');
    else release('capture');
    this.emit('state', this.state);
  }

  private get busy(): boolean {
    return this.starting || this.run !== null;
  }

  /** The Performance Log Users check, at start and after the app adds the account. */
  private async checkTrace(): Promise<TraceAccess> {
    const trace = await traceAccess();
    this.set({ trace });
    return trace;
  }

  /** Adds the account to Performance Log Users (one UAC prompt) and re-checks; the message says what happened and that a sign-out is needed. */
  async grantTrace(): Promise<{ ok: boolean; message: string }> {
    const r = await grantTraceAccess();
    await this.checkTrace();
    return r;
  }

  arm(on: boolean): CaptureState {
    if (on) this.gameMode.start();
    else this.gameMode.stop();
    this.set({ armed: on, status: this.busy ? this.state.status : on ? 'armed' : 'idle', message: on ? 'Watching for a game' : '' });
    return this.state;
  }

  /** Game Mode's way in: the gate is taken before the pid lookup, so a hotkey pressed twice or a manual Start in that gap is refused, not raced. */
  private async onGame(trigger: string): Promise<void> {
    if (this.busy || !this.state.armed) return;
    this.starting = true;
    try {
      const name = trigger.startsWith('process:') ? trigger.slice('process:'.length) : null;
      const pid = name ? ((await pidsByName(name))[0] ?? null) : await foregroundPid();
      if (pid === null) {
        this.set({ message: `Game Mode saw ${trigger} but found no process to capture` });
        return;
      }
      await this.launch(pid, trigger);
    } catch (e) {
      // launch() can only throw before it holds a run, so a live capture's status is never overwritten.
      if (!this.run) this.set({ status: 'error', message: (e as Error).message });
    } finally {
      this.starting = false;
    }
  }

  async start(pid: number, trigger = 'manual'): Promise<CaptureState> {
    if (this.busy) throw new Error('A capture is already running');
    this.starting = true;
    try {
      return await this.launch(pid, trigger);
    } finally {
      this.starting = false;
    }
  }

  /**
   * The built-in stutter bench (plan section 11a): refused while the GPU is not free
   * (section 20), then spawned sized for the primary display and captured like a game
   * whose exit ends the capture. The report opens on its own once the session is saved.
   */
  async startBench(): Promise<CaptureState> {
    if (this.busy) throw new Error('A capture is already running');
    this.starting = true;
    try {
      const refusal = await preflight();
      if (refusal) throw new Error(refusal);
      const bench = spawnBench(benchSize(screen.getPrimaryDisplay()));
      try {
        return await this.begin({ pid: bench.pid, exe: BENCH_EXE, path: bench.path, title: 'Strata Tune bench' }, 'bench', [], bench);
      } catch (e) {
        await bench.close();
        throw e;
      }
    } finally {
      this.starting = false;
    }
  }

  private async launch(pid: number, trigger: string): Promise<CaptureState> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pick a process first');
    if (pid === process.pid) throw new Error("Strata Tune's own window is never captured");
    const info = await processInfo(pid);
    if (!info) throw new Error(`Process ${pid} is gone`);
    // Several processes under one name is a multi-process app: the window's pid is not the presenting one.
    const siblings = (await pidsByName(info.exe)).filter((p) => p !== pid);
    return this.begin(info, trigger, siblings);
  }

  private async begin(info: ProcessInfo, trigger: string, siblings: number[], bench: BenchChild | null = null): Promise<CaptureState> {
    const { pid } = info;
    this.qpcFrequencyOnce ??= qpcFrequency();

    const target: CaptureTarget = { pid, exe: info.exe, trigger };
    const startedAt = new Date();
    const run: Run = {
      target,
      path: info.path,
      startedAt,
      writer: new sessions.SessionWriter(startedAt, info.exe),
      frames: 0,
      qpcFirst: null,
      qpcLast: null,
      recent: [],
      notes: [],
      snapshot: Promise.resolve(null),
      hogs: Promise.resolve(null),
      sensorQpc: 0,
      sensorTimer: null,
      pushTimer: null,
      onTick: null,
      bench
    };
    if (siblings.length > 0) run.notes.push(`captured by image name: ${siblings.length + 1} processes share ${info.exe}`);
    // The run is held only once PresentMon is up: a failed start leaves nothing to orphan.
    try {
      this.presentMon.start({ pid, exe: info.exe, byName: siblings.length > 0 });
    } catch (e) {
      await run.writer.discard();
      throw e;
    }
    this.run = run;
    this.attachCollector(run);
    run.pushTimer = setInterval(() => this.pushFrames(run), FRAMES_PUSH_MS);
    if (bench) {
      // PresentMon's proc-exit rule needs a present to have happened; a bench that never got that far is ended from here.
      void bench.done.then(() => delay(BENCH_GRACE_MS)).then(() => {
        if (this.run === run && this.presentMon.running) void this.presentMon.stop();
      });
    }
    const message = bench ? `Running the stutter bench (${BENCH_SECONDS} s); the report opens when it ends` : `Capturing ${info.exe} (pid ${pid})`;
    this.set({ status: 'capturing', target, startedAt: startedAt.toISOString(), frames: 0, message, lastSessionId: null, lastTrigger: null });
    return this.state;
  }

  /** Ends the capture; the save runs from PresentMon's exit, so the state is 'saving' when this resolves. A bench is asked to close, and PresentMon follows it. */
  async stop(): Promise<CaptureState> {
    const run = this.run;
    if (run && this.presentMon.running) {
      run.notes.push('stopped by the user');
      if (run.bench) await run.bench.close();
      else await this.presentMon.stop();
    }
    return this.state;
  }

  /** App quit: end the capture and give the save a bounded moment; the ETW cleanup is fired and not awaited. */
  async dispose(): Promise<void> {
    if (!this.run) return;
    this.run.notes.push('stopped with the app');
    const saved = new Promise<void>((resolve) => this.once('saved', resolve));
    if (this.run.bench) await this.run.bench.close();
    await this.presentMon.abandon();
    await Promise.race([saved, delay(SAVE_TIMEOUT_MS)]);
  }

  // --------------------------------------------------------- streams

  private frames(rows: FrameRow[]): void {
    const run = this.run;
    if (!run || rows.length === 0) return;
    run.writer.writeFrames(rows);
    run.frames += rows.length;
    run.qpcFirst ??= rows[0].timeInQpc;
    run.qpcLast = rows[rows.length - 1].timeInQpc;
    for (const r of rows) {
      const last = run.recent[run.recent.length - 1];
      run.recent.push({ ms: r.msBetweenPresents, sum: (last?.sum ?? 0) + r.msBetweenPresents });
    }
    // Keep the last two seconds of frame time by the frames' own clock.
    const total = run.recent[run.recent.length - 1].sum;
    let drop = 0;
    while (drop < run.recent.length - 1 && total - run.recent[drop].sum > RECENT_WINDOW_MS) drop++;
    if (drop > 0) run.recent.splice(0, drop);
  }

  private pushFrames(run: Run): void {
    const frames: CaptureFrames = { count: run.frames, recentMs: run.recent.map((r) => r.ms) };
    this.state = { ...this.state, frames: run.frames };
    this.emit('frames', frames);
  }

  /** The collector is optional: without it the session has frames only (sensorWindow null). */
  private attachCollector(run: Run): void {
    const c = this.collector();
    if (!c || c.state.status !== 'connected') return;
    run.snapshot = c.snapshot().catch(() => null);
    run.hogs = c.hogs(HOGS_SAMPLE_S).catch(() => null);
    run.onTick = (t: Tick) => {
      const facts = t.gpu[0];
      if (facts) run.writer.writeGpu({ qpc: t.qpc, facts } satisfies GpuSample);
    };
    c.on('tick', run.onTick);
    c.sensorsLatest()
      .then((row) => {
        run.sensorQpc = row.qpc;
      })
      .catch(() => undefined);
    run.sensorTimer = setInterval(() => void this.sensorSlice(run, SENSOR_SLICE_S), SENSOR_SLICE_MS);
  }

  /** Appends the collector's rows newer than the last slice; the window is read, never subscribed, so the Monitor's 2 Hz stream is untouched. */
  private async sensorSlice(run: Run, seconds: number): Promise<void> {
    const c = this.collector();
    if (!c || c.state.status !== 'connected') return;
    try {
      const w = await c.sensorsWindow(seconds);
      const rows: SensorRow[] = w.rows.filter((r) => r.qpc > run.sensorQpc);
      if (rows.length === 0) return;
      run.writer.writeSensors(rows);
      run.sensorQpc = rows[rows.length - 1].qpc;
    } catch (e) {
      run.notes.push(`sensor slice failed: ${(e as Error).message}`);
    }
  }

  private detachCollector(run: Run): void {
    if (run.sensorTimer) clearInterval(run.sensorTimer);
    run.sensorTimer = null;
    const c = this.collector();
    if (run.onTick && c) c.off('tick', run.onTick);
    run.onTick = null;
  }

  // ------------------------------------------------------------ finish

  private async finish(presentMonExit: PresentMonExit): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (run.pushTimer) clearInterval(run.pushTimer);
    run.pushTimer = null;
    this.pushFrames(run);
    this.set({ status: 'saving', message: `Saving ${run.frames} frames…` });
    let exit = presentMonExit;
    // A note is a remark the report shows: the plain sentence a bad exit carries (presentmon.ts exitMessage), never a raw exit code, and nothing for a clean run.
    if (exit.message) run.notes.push(exit.message);
    // PresentMon gone with a complaint while the bench still plays (the trace session refused,
    // exit 6, on the first laptop): nothing it draws from here on is captured, so it is closed
    // rather than left running its 90 s script on the user's screen for nothing.
    if (run.bench && exit.message && run.frames === 0) await run.bench.close();
    // The bench's own exit says how the run went: its summary is the session's, and its message outranks PresentMon's.
    const bench: BenchExit | null = run.bench ? await Promise.race([run.bench.done, delay(BENCH_EXIT_WAIT_MS).then(() => null)]) : null;
    if (bench) {
      if (bench.message) {
        run.notes.push(bench.message);
        exit = { ...exit, message: bench.message };
      } else if (bench.summary?.completed === false) run.notes.push('The bench was ended early, so its script did not play to the end');
    }

    // The last slice covers everything since the previous one, plus a margin for the collector's own lag.
    const elapsedS = Math.ceil((Date.now() - run.startedAt.getTime()) / 1000);
    await this.sensorSlice(run, Math.min(elapsedS + 5, SENSOR_SLICE_S));
    this.detachCollector(run);

    const after: CaptureStatus = this.state.armed ? 'armed' : 'idle';
    try {
      if (run.frames === 0 || run.qpcFirst === null || run.qpcLast === null) {
        await run.writer.discard();
        this.run = null;
        this.set({ status: exit.message ? 'error' : after, target: null, message: exit.message ?? `${run.target.exe} presented no frames while PresentMon watched; nothing saved` });
        return;
      }
      const meta = await run.writer.finish({
        startedAt: run.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        game: { pid: run.target.pid, exe: run.target.exe, path: run.path },
        trigger: run.target.trigger,
        qpcFrequency: await (this.qpcFrequencyOnce ?? qpcFrequency()),
        qpcStart: run.qpcFirst,
        qpcEnd: run.qpcLast,
        snapshot: await Promise.race([run.snapshot, delay(SNAPSHOT_WAIT_MS).then(() => null)]),
        hogs: await Promise.race([run.hogs, delay(SNAPSHOT_WAIT_MS).then(() => null)]),
        notes: run.notes,
        verdict: null,
        ...(bench ? { benchSummary: bench.summary } : {})
      });
      this.run = null;
      this.set({ status: 'done', target: null, lastSessionId: meta.id, lastTrigger: run.target.trigger, message: exit.message ? `${exit.message}; saved ${meta.frames} frames as ${meta.id}` : `Saved ${meta.frames} frames as ${meta.id}` });
    } catch (e) {
      this.run = null;
      this.set({ status: 'error', target: null, message: `Could not save the session: ${(e as Error).message}` });
    } finally {
      this.emit('saved');
    }
  }
}

// --------------------------------------------------------------- IPC

/** The renderer's whole capture surface; `send` pushes state and frames to the window. */
export function registerCaptureIpc(ipc: IpcMain, controller: CaptureController, send: (channel: string, payload: unknown) => void): void {
  ipc.handle('capture:state', () => controller.state);
  ipc.handle('capture:processes', () => listProcesses());
  ipc.handle('capture:start', (_e, pid: number) => controller.start(pid, 'manual'));
  ipc.handle('capture:startBench', () => controller.startBench());
  ipc.handle('capture:stop', () => controller.stop());
  ipc.handle('capture:arm', (_e, on: boolean) => controller.arm(!!on));
  ipc.handle('capture:grantTrace', () => controller.grantTrace());
  ipc.handle('sessions:list', () => sessions.list());
  ipc.handle('sessions:load', (_e, id: string): CaptureSession => sessions.load(id));
  ipc.handle('sessions:delete', (_e, id: string) => sessions.remove(id));
  ipc.handle('sessions:verdict', (_e, id: string, verdict: string) => sessions.setVerdict(id, String(verdict).slice(0, 300)));
  ipc.handle('sessions:reveal', (_e, id: string) => shell.showItemInFolder(sessions.folder(id)));
  ipc.handle('sessions:trashCount', () => sessions.trashCount());
  ipc.handle('sessions:emptyTrash', (e: IpcMainInvokeEvent) => emptyTrash(e));
  ipc.handle('sessions:exportHtml', (e: IpcMainInvokeEvent, data: Report) => exportHtml(e, data));
  ipc.handle('sessions:exportSheet', (e: IpcMainInvokeEvent, sheet: ScoreSheet) => exportHtml(e, { kind: 'score', sheet }));
  controller.on('state', (s: CaptureState) => send('capture:state', s));
  controller.on('frames', (f: CaptureFrames) => send('capture:frames', f));
}

/** Permanent, so the question is asked here in a native dialog; resolves the count removed, or null when the user kept the trash. */
async function emptyTrash(e: IpcMainInvokeEvent): Promise<number | null> {
  const count = sessions.trashCount();
  if (count === 0) return 0;
  const win = BrowserWindow.fromWebContents(e.sender);
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Empty trash',
    message: `Delete ${count} trashed session${count === 1 ? '' : 's'} for good?`,
    detail: 'They are removed from disk; this cannot be undone.',
    buttons: ['Empty trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
  const r = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return r.response === 0 ? sessions.emptyTrash() : null;
}

/** The single-file renderer from npm run build:report, beside dist/ in dev and in the package alike. */
const reportTemplate = () => path.join(app.getAppPath(), 'dist-report', 'report-template.html');

/** Plan section 19: the built template with the report JSON in its slot (a stutter report or a score sheet), saved where the user says. Resolves the path, or null when cancelled. */
async function exportHtml(e: IpcMainInvokeEvent, data: ReportFile): Promise<string | null> {
  let template: string;
  try {
    template = fs.readFileSync(reportTemplate(), 'utf-8');
  } catch {
    throw new Error('The report template is not built: run npm run build:report');
  }
  const html = exportReportFile(data, template);
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: data.kind === 'score' ? 'Save comparison sheet' : 'Export report', defaultPath: path.join(app.getPath('downloads'), reportFileNameOf(data)), filters: [{ name: 'HTML report', extensions: ['html'] }] };
  const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, html, 'utf-8');
  return r.filePath;
}
