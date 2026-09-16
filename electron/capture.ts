/**
 * Capture controller (master plan section 11): idle → armed (Game Mode watching)
 * → capturing → saving → done. A capture is PresentMon on one pid (electron/
 * presentmon.ts) with the collector's sensor rows and GPU facts written beside
 * the frames as they arrive (electron/sessions.ts). It starts by button with a
 * picked process, or by Game Mode when a capture is armed: the allowlist names
 * the exe, the fullscreen probe and the hotkey take whatever window is in front.
 * It ends by button, when the game exits, or with the app.
 */
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { app, BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { CollectorClient } from './collector';
import type { GameMode, GameModeState } from './game-mode';
import { availability, PresentMonHost, type PresentMonAvailability, type PresentMonExit } from './presentmon';
import * as sessions from './sessions';
import type { CaptureSession, FrameRow, GpuSample } from '../src/analysis/session-types';
import type { HogsResult, SensorRow, StaticSnapshot, Tick } from '../src/collector-types';
import { exportReport, reportFileName } from '../src/report/export';
import type { Report } from '../src/report/report-types';

export type { PresentMonAvailability } from './presentmon';
export type { SessionListItem } from './sessions';

export type CaptureStatus = 'idle' | 'armed' | 'capturing' | 'saving' | 'done' | 'error';

export interface CaptureTarget {
  pid: number;
  exe: string;
  trigger: string;
}

export interface CaptureState {
  status: CaptureStatus;
  /** Game Mode is watching for a game; a capture starts on its own when one appears. */
  armed: boolean;
  presentMon: PresentMonAvailability;
  target: CaptureTarget | null;
  startedAt: string | null;
  frames: number;
  /** The last thing worth saying: the error, or where the capture was saved. */
  message: string;
  lastSessionId: string | null;
}

/** 2 Hz while capturing: the count and the last two seconds of frame times, oldest first, for the live sparkline. */
export interface CaptureFrames {
  count: number;
  recentMs: number[];
}

export interface ProcessInfo {
  pid: number;
  exe: string;
  path: string | null;
  title: string;
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

/** Everything with a main window, our own window excluded: the picker for a manual start. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const out = await powershell(`Get-Process | Where-Object { $_.MainWindowTitle -and $_.Id -ne ${process.pid} } | Select-Object Id, ProcessName, Path, MainWindowTitle | ConvertTo-Json -Compress`);
  return psList(out)
    .map(toInfo)
    .sort((a, b) => a.exe.localeCompare(b.exe) || a.pid - b.pid);
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
    this.state = { status: 'idle', armed: false, presentMon: availability(), target: null, startedAt: null, frames: 0, message: '', lastSessionId: null };
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
    this.emit('state', this.state);
  }

  private get busy(): boolean {
    return this.starting || this.run !== null;
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

  private launch(pid: number, trigger: string): Promise<CaptureState> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pick a process first');
    if (pid === process.pid) throw new Error("Strata Tune's own window is never captured");
    return this.begin(pid, trigger);
  }

  private async begin(pid: number, trigger: string): Promise<CaptureState> {
    const info = await processInfo(pid);
    if (!info) throw new Error(`Process ${pid} is gone`);
    this.qpcFrequencyOnce ??= qpcFrequency();
    // Several processes under one name is a multi-process app: the window's pid is not the presenting one.
    const siblings = (await pidsByName(info.exe)).filter((p) => p !== pid);

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
      onTick: null
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
    this.set({ status: 'capturing', target, startedAt: startedAt.toISOString(), frames: 0, message: `Capturing ${info.exe} (pid ${pid})`, lastSessionId: null });
    return this.state;
  }

  /** Ends the capture; the save runs from PresentMon's exit, so the state is 'saving' when this resolves. */
  async stop(): Promise<CaptureState> {
    if (this.run && this.presentMon.running) {
      this.run.notes.push('stopped by the user');
      await this.presentMon.stop();
    }
    return this.state;
  }

  /** App quit: end the capture and give the save a bounded moment; the ETW cleanup is fired and not awaited. */
  async dispose(): Promise<void> {
    if (!this.run) return;
    this.run.notes.push('stopped with the app');
    const saved = new Promise<void>((resolve) => this.once('saved', resolve));
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

  private async finish(exit: PresentMonExit): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (run.pushTimer) clearInterval(run.pushTimer);
    run.pushTimer = null;
    this.pushFrames(run);
    this.set({ status: 'saving', message: `Saving ${run.frames} frames…` });
    if (exit.message) run.notes.push(exit.message);
    if (exit.code !== null) run.notes.push(`PresentMon exit code ${exit.code}`);

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
        verdict: null
      });
      this.run = null;
      this.set({ status: 'done', target: null, lastSessionId: meta.id, message: exit.message ? `${exit.message}; saved ${meta.frames} frames as ${meta.id}` : `Saved ${meta.frames} frames as ${meta.id}` });
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
  ipc.handle('capture:stop', () => controller.stop());
  ipc.handle('capture:arm', (_e, on: boolean) => controller.arm(!!on));
  ipc.handle('sessions:list', () => sessions.list());
  ipc.handle('sessions:load', (_e, id: string): CaptureSession => sessions.load(id));
  ipc.handle('sessions:delete', (_e, id: string) => sessions.remove(id));
  ipc.handle('sessions:verdict', (_e, id: string, verdict: string) => sessions.setVerdict(id, String(verdict).slice(0, 300)));
  ipc.handle('sessions:reveal', (_e, id: string) => shell.showItemInFolder(sessions.folder(id)));
  ipc.handle('sessions:exportHtml', (e: IpcMainInvokeEvent, data: Report) => exportHtml(e, data));
  controller.on('state', (s: CaptureState) => send('capture:state', s));
  controller.on('frames', (f: CaptureFrames) => send('capture:frames', f));
}

/** The single-file renderer from npm run build:report, beside dist/ in dev and in the package alike. */
const reportTemplate = () => path.join(app.getAppPath(), 'dist-report', 'report-template.html');

/** Plan section 19: the built template with the report JSON in its slot, saved where the user says. Resolves the path, or null when cancelled. */
async function exportHtml(e: IpcMainInvokeEvent, data: Report): Promise<string | null> {
  let template: string;
  try {
    template = fs.readFileSync(reportTemplate(), 'utf-8');
  } catch {
    throw new Error('The report template is not built: run npm run build:report');
  }
  const html = exportReport(data.report, data.session, template);
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Export report', defaultPath: path.join(app.getPath('downloads'), reportFileName(data.session)), filters: [{ name: 'HTML report', extensions: ['html'] }] };
  const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, html, 'utf-8');
  return r.filePath;
}
