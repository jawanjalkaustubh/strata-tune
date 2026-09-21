/**
 * Client for the elevated collector (master plan section 5). The UI cannot
 * read an elevated child's stdout, so the rendezvous is a file: the collector
 * writes collector.json { port, token, pid, startedAt } under this user's
 * %LOCALAPPDATA%\Strata Tune once it listens (the path is passed to it, so an
 * over-the-shoulder elevation under another account still lands here), and
 * every call carries that token. The collector exits on its own when our pid
 * disappears; nothing here ever kills it.
 */
import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { CollectorState, CollectorStatus } from '../src/api';
import { tuneDataDir } from './presence';
import { macWorkerPath, macmonPath } from './mac/paths';
import { MacCollector } from './mac/server';
import type { GpuFacts, Handshake, Health, HogsResult, LoadKind, LoadRun, LoadRunRequest, SensorMeta, SensorRow, SensorWindow, StaticSnapshot, Tick } from '../src/collector-types';

/** Every route in one place, so a rename on the server side is a one-line change. */
const ROUTES = {
  health: '/health',
  snapshot: '/snapshot',
  sensorsMeta: '/sensors/meta',
  sensorsLatest: '/sensors/latest',
  sensorsWindow: (seconds: number) => `/sensors/window?seconds=${seconds}`,
  gpu: '/gpu',
  hogs: (seconds: number, excludePid: number) => `/procs/hogs?seconds=${seconds}&excludePid=${excludePid}`,
  load: '/load',
  loadRun: (id: string) => `/load/${encodeURIComponent(id)}`,
  loadCancel: (id: string) => `/load/${encodeURIComponent(id)}/cancel`,
  stream: '/stream',
  shutdown: '/shutdown'
};

/**
 * The collector writes the handshake before it opens a single sensor (phase1-polish item 8:
 * under a second on this box), so this budget is for a machine where even that fails to
 * happen, not for a slow sensor tree; the tree warms behind Health.warming.
 */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** How long a UAC prompt may stay unanswered before the start is given up. */
const UAC_TIMEOUT_MS = 10 * 60_000;
/** Polled from the moment the launcher is spawned, so the first tick follows the handshake by at most this. */
const HANDSHAKE_POLL_MS = 100;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
/** Stream reconnects that fail in a row before the collector is taken as gone and Retry is offered. */
const MAX_STREAM_FAILURES = 6;
const COLLECTOR_IMAGE = 'strata-tune-collector.exe';
/** Win32 ERROR_CANCELLED: the UAC prompt was declined, in any language. */
const ERROR_CANCELLED = 1223;

const dataDir = () => tuneDataDir();
const handshakePath = () => path.join(dataDir(), 'collector.json');
const logPath = () => path.join(dataDir(), 'logs', 'collector.log');
const orphanLogPath = () => path.join(dataDir(), 'orphan.log');

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Signal 0 only queries; EPERM means the process exists but is not ours (it is elevated). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The image name behind a pid, from tasklist (it lists elevated processes without elevation); null when the pid is gone. */
function imageName(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /^"([^"]+)"/.exec(String(stdout).trim());
      resolve(m ? m[1] : null);
    });
  });
}

function readHandshake(): Handshake | null {
  try {
    const h = JSON.parse(fs.readFileSync(handshakePath(), 'utf-8')) as Partial<Handshake>;
    if (typeof h.port === 'number' && typeof h.token === 'string' && typeof h.pid === 'number') return h as Handshake;
  } catch {
    /* absent, or half-written by the collector this instant */
  }
  return null;
}

function unlinkHandshake() {
  try {
    fs.unlinkSync(handshakePath());
  } catch {
    /* nothing stale to remove */
  }
}

/** PowerShell single-quoted literal. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Launch {
  exit: number | null;
  stderr: string;
}

/**
 * ShellExecute("runas") from Node goes through PowerShell's Start-Process. The
 * exe path is quoted by Start-Process itself; -ArgumentList is joined into one
 * raw command line without quoting, so an argument that may contain spaces
 * (the paths under "Strata Tune") must carry its own double quotes. The
 * collector is a console exe, so without -WindowStyle Hidden a console window
 * would open beside the app. A declined prompt makes Start-Process throw a
 * Win32Exception whose code, not its localised message, says so.
 */
function launchElevated(exe: string, args: string[]): Launch {
  const command =
    `try { Start-Process -FilePath ${psq(exe)} -ArgumentList @(${args.map(psq).join(',')}) -Verb RunAs -WindowStyle Hidden -ErrorAction Stop } ` +
    'catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; ' +
    '$code = if ($e -is [System.ComponentModel.Win32Exception]) { $e.NativeErrorCode } else { -1 }; ' +
    '[Console]::Error.WriteLine("launch failed code=$code " + $e.Message); exit 1 }';
  const launch: Launch = { exit: null, stderr: '' };
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (d: string) => (launch.stderr += d));
  child.on('error', (e) => {
    launch.stderr += e.message;
    launch.exit = -1;
  });
  child.on('exit', (code) => (launch.exit = code ?? -1));
  return launch;
}

type Probe = 'ok' | 'refused' | 'failed';

export class CollectorClient extends EventEmitter {
  state: CollectorState = { status: 'idle', message: 'Collector not started' };
  private handshake: Handshake | null = null;
  private stream: http.ClientRequest | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private streamFailures = 0;
  private starting: Promise<CollectorState> | null = null;
  /** macOS: the collector runs inside this process (electron/mac/server.ts); nothing to elevate or spawn. */
  private mac: MacCollector | null = null;

  private set(status: CollectorStatus, message: string) {
    this.state = { status, message };
    this.emit('status', this.state);
  }

  /**
   * Packaged: resources/collector. Dev: the newer of the Release build in the solution tree
   * (the worker is copied beside it at build) and the published bundle in resources/collector
   * (scripts/build-collector.ps1). Smart App Control on the dev box started refusing to load
   * the freshly built loose collector DLL on 2026-09-16 while it passes the single-file
   * bundle, so a fresh publish is a way through; a stale one never shadows a newer build.
   */
  private collectorExe(): string {
    const published = path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'collector', COLLECTOR_IMAGE);
    if (app.isPackaged) return published;
    const built = path.join(app.getAppPath(), 'collector', 'StrataTune.Collector', 'bin', 'x64', 'Release', 'net10.0', 'win-x64', COLLECTOR_IMAGE);
    const mtime = (p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return -1;
      }
    };
    return mtime(published) > mtime(built) ? published : built;
  }

  /** Idempotent: a second call while one is in flight joins it; a connected client returns at once. */
  start(): Promise<CollectorState> {
    if (this.state.status === 'connected') return Promise.resolve(this.state);
    if (!this.starting) this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<CollectorState> {
    if (process.platform === 'darwin') return this.startMac();
    if (process.platform !== 'win32') {
      // The collector is a .NET service on LibreHardwareMonitor, NVML, NVAPI, WMI and PresentMon; the
      // macOS twin lives in electron/mac. Elsewhere the shell runs without sensors.
      this.set('error', 'The sensor collector exists for Windows and macOS only. On this platform Strata Tune runs without live sensors: the AI Models page and saved reports work.');
      return this.state;
    }
    this.reportOrphans();
    this.set('starting', 'Looking for a running collector…');
    const existing = readHandshake();
    if (existing && pidAlive(existing.pid)) {
      // A live collector is never doubled and its handshake never deleted: the
      // file is the only copy of its token, and a second elevated process is a
      // second UAC prompt. But the file survives a crash, End Task or a reboot,
      // and low pids are reused, so "alive" is trusted only once the pid's
      // image name says it really is a collector.
      let probe: Probe = 'failed';
      for (let attempt = 0; attempt < 3; attempt++) {
        probe = await this.probe(existing);
        if (probe === 'ok') {
          this.adopt(existing, 'Connected (reusing a running collector)');
          return this.state;
        }
        await delay(1000);
      }
      const image = await imageName(existing.pid);
      if (image && image.toLowerCase() === COLLECTOR_IMAGE) {
        const why = probe === 'refused' ? `nothing is listening on port ${existing.port}, so it is probably shutting down` : `it does not answer on port ${existing.port}`;
        this.set('error', `A collector (pid ${existing.pid}) is running but ${why}. Retry in a moment, or end ${COLLECTOR_IMAGE} in Task Manager.`);
        return this.state;
      }
      console.warn(`[collector] stale handshake: pid ${existing.pid} is ${image ?? 'gone'}, not a collector; removing it`);
    }
    unlinkHandshake();

    const collector = this.collectorExe();
    if (!fs.existsSync(collector)) {
      this.set('error', `Collector not built: ${collector}. Run dotnet build collector\\StrataTune.sln -c Release.`);
      return this.state;
    }
    this.set('elevating', 'Waiting for permission (UAC)…');
    // Our start time goes with the pid so a prompt answered after this app has gone,
    // and its pid handed to something else, cannot bind a collector to a stranger.
    const startedMs = Math.round(performance.timeOrigin);
    const launch = launchElevated(collector, [
      '--serve', '--parent-pid', String(process.pid), '--parent-start', String(startedMs),
      '--handshake', `"${handshakePath()}"`, '--log', `"${logPath()}"`
    ]);

    // PowerShell returns only once the prompt is answered, so the handshake budget
    // starts then: a prompt the user has not reached yet is not a slow collector.
    let deadline = Date.now() + UAC_TIMEOUT_MS;
    let accepted = false;
    for (;;) {
      const h = readHandshake();
      if (h && pidAlive(h.pid) && (await this.probe(h)) === 'ok') {
        this.adopt(h, 'Connected');
        return this.state;
      }
      if (launch.exit !== null && launch.exit !== 0) {
        if (new RegExp(`code=${ERROR_CANCELLED}\\b|cancell?ed by the user`, 'i').test(launch.stderr)) this.set('declined', 'Permission declined');
        else this.set('error', `Could not launch the collector: ${launch.stderr.trim() || `exit ${launch.exit}`}`);
        return this.state;
      }
      if (launch.exit === 0 && !accepted) {
        accepted = true;
        deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
        this.set('starting', 'Permission granted, collector starting…');
      }
      if (Date.now() >= deadline) break;
      await delay(HANDSHAKE_POLL_MS);
    }
    this.set(
      'error',
      accepted
        ? `The collector did not answer within ${HANDSHAKE_TIMEOUT_MS / 1000} s of the UAC prompt. Run it with --probe to see whether PawnIO and elevation are in order.`
        : 'The UAC prompt was not answered.'
    );
    return this.state;
  }

  /**
   * macOS (docs/MACOS.md): the collector is electron/mac/server.ts inside this process, reading
   * macmon and IOKit; the same handshake, token and routes as the Windows service, so
   * everything below this point is shared. Without macmon only the battery and GPU memory
   * rows exist, and the status says what to install.
   */
  private async startMac(): Promise<CollectorState> {
    this.set('starting', 'Starting the macOS collector…');
    try {
      if (!this.mac) {
        this.mac = new MacCollector({
          version: app.getVersion(),
          dataDir: dataDir(),
          workerPath: macWorkerPath(app.getAppPath(), app.isPackaged, process.resourcesPath),
          macmonPath: macmonPath()
        });
      }
      const h = await this.mac.start();
      this.adopt(h, this.mac.macmonInstalled ? 'Connected' : 'Connected · install macmon (brew install macmon) for CPU, GPU, fan and power sensors');
    } catch (e) {
      this.set('error', `The macOS collector could not start: ${(e as Error).message}`);
    }
    return this.state;
  }

  /** 'refused' is nothing listening on the port (ECONNREFUSED); 'failed' is a timeout, a bad status or another pid answering. */
  private async probe(h: Handshake): Promise<Probe> {
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}${ROUTES.health}`, { headers: { Authorization: `Bearer ${h.token}` }, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return 'failed';
      const health = (await res.json()) as Health;
      return health.ok === true && health.pid === h.pid ? 'ok' : 'failed';
    } catch (e) {
      const cause = (e as { cause?: NodeJS.ErrnoException }).cause;
      return cause?.code === 'ECONNREFUSED' ? 'refused' : 'failed';
    }
  }

  private adopt(h: Handshake, message: string) {
    this.handshake = h;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.streamFailures = 0;
    this.set('connected', message);
    this.openStream();
  }

  // ------------------------------------------------------------- HTTP

  private requireHandshake(): Handshake {
    if (!this.handshake || this.state.status !== 'connected') throw new Error(`Collector is ${this.state.status}: ${this.state.message}`);
    return this.handshake;
  }

  private async request<T>(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number): Promise<T> {
    const h = this.requireHandshake();
    const headers: Record<string, string> = { Authorization: `Bearer ${h.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${h.port}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status} ${(await res.text().catch(() => '')).trim()}`.trim());
    return (await res.json()) as T;
  }

  get<T>(route: string, timeoutMs = 10_000): Promise<T> {
    return this.request<T>('GET', route, undefined, timeoutMs);
  }

  /** A route that answers text rather than JSON (the flight recorder's NDJSON, electron/tune.ts). */
  async text(route: string, timeoutMs = 10_000): Promise<string> {
    const h = this.requireHandshake();
    const res = await fetch(`http://127.0.0.1:${h.port}${route}`, { headers: { Authorization: `Bearer ${h.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`GET ${route} answered ${res.status} ${body.trim()}`.trim());
    return body;
  }

  post<T>(route: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    return this.request<T>('POST', route, body, timeoutMs);
  }

  /** WMI on a cold box can take a while; the snapshot is read once per audit. */
  snapshot(): Promise<StaticSnapshot> {
    return this.get<StaticSnapshot>(ROUTES.snapshot, 60_000);
  }

  sensorsMeta(): Promise<SensorMeta[]> {
    return this.get<SensorMeta[]>(ROUTES.sensorsMeta);
  }

  sensorsLatest(): Promise<SensorRow> {
    return this.get<SensorRow>(ROUTES.sensorsLatest);
  }

  /** Up to ten minutes at full rate, summaries beyond; the payload is thinned server-side to about 2.5 MB. */
  sensorsWindow(seconds: number): Promise<SensorWindow> {
    return this.get<SensorWindow>(ROUTES.sensorsWindow(seconds), 30_000);
  }

  gpu(): Promise<GpuFacts[]> {
    return this.get<GpuFacts[]>(ROUTES.gpu);
  }

  /** The collector samples for `seconds` before answering; our own pid never counts as a hog. */
  hogs(seconds: number): Promise<HogsResult> {
    return this.get<HogsResult>(ROUTES.hogs(seconds, process.pid), seconds * 1000 + 15_000);
  }

  /** The run being polled by load(), so a Stop from the renderer knows which one to cancel. */
  private activeLoad: string | null = null;

  /** Starts a worker run and polls it to completion so the renderer sees one call, one result; a cancelled run resolves as such, never throws. */
  async load(kind: LoadKind, seconds: number): Promise<LoadRun> {
    const request: LoadRunRequest = { kind, seconds };
    let run = await this.post<LoadRun>(ROUTES.load, request);
    this.activeLoad = run.id;
    try {
      const deadline = Date.now() + seconds * 1000 + 30_000;
      while (run.state === 'running' && Date.now() < deadline) {
        await delay(500);
        run = await this.get<LoadRun>(ROUTES.loadRun(run.id));
      }
    } finally {
      this.activeLoad = null;
    }
    if (run.state === 'running') throw new Error(`Load run ${run.id} did not finish within ${seconds + 30} s`);
    return run;
  }

  /**
   * Stop (plan section 17c): cancels the run load() is polling, if any. The collector kills
   * the worker or bench and answers once it is gone, so load() resolves as cancelled on its
   * next poll. Answers whether a run was cancelled; a run that ended on its own meanwhile
   * (409) counts as none.
   */
  async cancelLoad(): Promise<boolean> {
    const id = this.activeLoad;
    if (!id) return false;
    try {
      await this.post<LoadRun>(ROUTES.loadCancel(id), undefined);
      return true;
    } catch (e) {
      if (/answered 409/.test((e as Error).message)) return false;
      throw e;
    }
  }

  // -------------------------------------------------------------- SSE

  private openStream() {
    if (this.stream || this.state.status !== 'connected' || !this.handshake) return;
    const h = this.handshake;
    const req = http.request(
      { host: '127.0.0.1', port: h.port, path: ROUTES.stream, method: 'GET', headers: { Authorization: `Bearer ${h.token}`, Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.streamClosed(`stream answered ${res.statusCode}`);
          return;
        }
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.streamFailures = 0;
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let m: RegExpExecArray | null;
          while ((m = /\r?\n\r?\n/.exec(buffer))) {
            this.handleEvent(buffer.slice(0, m.index));
            buffer = buffer.slice(m.index + m[0].length);
          }
        });
        res.on('end', () => this.streamClosed('stream ended'));
        res.on('error', (e) => this.streamClosed(e.message, (e as NodeJS.ErrnoException).code));
      }
    );
    req.on('error', (e) => this.streamClosed(e.message, (e as NodeJS.ErrnoException).code));
    req.end();
    this.stream = req;
  }

  private handleEvent(block: string) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return;
    // Tune state changes (electron/tune.ts) ride the same stream; the payload is read by the renderer's adapter.
    if (event === 'tune') {
      try {
        this.emit('tune', JSON.parse(data.join('\n')) as unknown);
      } catch (e) {
        console.warn('[collector] unreadable tune event:', (e as Error).message);
      }
      return;
    }
    if (event !== 'tick') return;
    try {
      this.emit('tick', JSON.parse(data.join('\n')) as Tick);
    } catch (e) {
      console.warn('[collector] unreadable tick:', (e as Error).message);
    }
  }

  /**
   * Reconnects with backoff while the collector is believed up. A dead pid, a
   * port nobody listens on, or a run of failures means it is gone (or its pid
   * has been reused): the status drops to stopped so the pill offers Retry
   * instead of reporting Connected over a stream that never comes back.
   */
  private streamClosed(reason: string, code?: string) {
    this.stream = null;
    if (this.state.status !== 'connected' || !this.handshake) return;
    this.streamFailures += 1;
    if (!pidAlive(this.handshake.pid) || code === 'ECONNREFUSED' || this.streamFailures >= MAX_STREAM_FAILURES) {
      this.set('stopped', 'The collector exited');
      return;
    }
    console.warn(`[collector] ${reason}; reconnecting in ${this.reconnectDelay} ms`);
    setTimeout(() => this.openStream(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  // ----------------------------------------------------------- lifetime

  /**
   * Graceful stop, called from before-quit (lifecycle audit 2026-09-15, item
   * 32): POST /shutdown with the token, straight to the wire, bounded. The
   * collector's own SYNCHRONIZE watchdog on our pid is the primary mechanism
   * (an elevated child cannot be reached by taskkill, process.kill or a Job
   * Object from medium IL); this only makes its exit earlier and cleaner.
   * Resolves true on a 202, false otherwise; never throws, quitting wins.
   */
  async shutdown(timeoutMs = 2000): Promise<boolean> {
    const h = this.handshake;
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    if (!h) return false;
    this.set('stopped', 'Quitting');
    if (!pidAlive(h.pid)) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}${ROUTES.shutdown}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${h.token}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.status === 202;
    } catch {
      return false;
    }
  }

  /**
   * Called on will-quit. There is nothing to kill: the collector exits when our
   * pid disappears (plan section 5). That cannot be observed from inside this
   * process, so a detached watcher waits for our exit, gives the collector 5 s,
   * and appends to orphan.log only if it is still alive. The next start prints
   * that log; an orphaned elevated process is a bug we want to see.
   */
  armOrphanCheck() {
    const pid = this.handshake?.pid;
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    if (!pid) return;
    this.set('stopped', 'Quitting');
    if (process.platform !== 'win32') {
      // In-process on macOS: there is no second process to orphan; stop it with the app.
      void this.mac?.stop();
      return;
    }
    const script = [
      `$parent=${process.pid}; $c=${pid}`,
      'while (Get-Process -Id $parent -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }',
      '$deadline=(Get-Date).AddSeconds(5)',
      'while ((Get-Date) -lt $deadline) { if (-not (Get-Process -Id $c -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 250 }',
      `Add-Content -Path ${psq(orphanLogPath())} -Value ("{0} collector pid {1} still alive 5 s after Strata Tune pid {2} exited" -f (Get-Date -Format o), $c, $parent)`
    ].join('; ');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
  }

  private reportOrphans() {
    try {
      const lines = fs.readFileSync(orphanLogPath(), 'utf-8').trim().split(/\r?\n/);
      console.warn(`[collector] ${lines.length} orphan record(s) in ${orphanLogPath()}; last: ${lines[lines.length - 1]}`);
    } catch {
      /* no orphan log: the previous run exited cleanly */
    }
  }
}
