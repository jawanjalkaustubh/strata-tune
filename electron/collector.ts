/**
 * Client for the elevated collector (master plan section 5). The UI cannot
 * read an elevated child's stdout, so the rendezvous is a file: the collector
 * writes %LOCALAPPDATA%\Strata Tune\collector.json { port, token, pid } once it
 * listens, and every call here carries that token. The collector exits on its
 * own when our pid disappears; nothing here ever kills it.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { CollectorState, CollectorStatus } from '../src/api';
import type { GpuFacts, Handshake, Health, HogsResult, LoadKind, LoadRun, LoadRunRequest, SensorMeta, SensorRow, StaticSnapshot, Tick } from '../src/collector-types';

/** Every route in one place, so a rename on the server side is a one-line change. */
const ROUTES = {
  health: '/health',
  snapshot: '/snapshot',
  sensorsMeta: '/sensors/meta',
  sensorsLatest: '/sensors/latest',
  gpu: '/gpu',
  hogs: (seconds: number, excludePid: number) => `/procs/hogs?seconds=${seconds}&excludePid=${excludePid}`,
  load: '/load',
  loadRun: (id: string) => `/load/${encodeURIComponent(id)}`,
  stream: '/stream',
  shutdown: '/shutdown'
};

const HANDSHAKE_TIMEOUT_MS = 20_000;
/** How long a UAC prompt may stay unanswered before the start is given up. */
const UAC_TIMEOUT_MS = 10 * 60_000;
const HANDSHAKE_POLL_MS = 250;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;

const dataDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Strata Tune');
const handshakePath = () => path.join(dataDir(), 'collector.json');
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

function readHandshake(): Handshake | null {
  try {
    const h = JSON.parse(fs.readFileSync(handshakePath(), 'utf-8')) as Partial<Handshake>;
    if (typeof h.port === 'number' && typeof h.token === 'string' && typeof h.pid === 'number') return h as Handshake;
  } catch {
    /* absent, or half-written by the collector this instant */
  }
  return null;
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
 * (the worker path under Program Files) must carry its own double quotes.
 * A declined UAC prompt makes Start-Process throw and PowerShell exit 1.
 */
function launchElevated(exe: string, args: string[]): Launch {
  const command = `Start-Process -FilePath ${psq(exe)} -ArgumentList @(${args.map(psq).join(',')}) -Verb RunAs`;
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

export class CollectorClient extends EventEmitter {
  state: CollectorState = { status: 'idle', message: 'Collector not started' };
  private handshake: Handshake | null = null;
  private stream: http.ClientRequest | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private starting: Promise<CollectorState> | null = null;

  private set(status: CollectorStatus, message: string) {
    this.state = { status, message };
    this.emit('status', this.state);
  }

  /** Dev: the Release build in the solution tree. Packaged: resources/collector next to the app. */
  private exePaths(): { collector: string; worker: string } {
    if (app.isPackaged) {
      const dir = path.join(process.resourcesPath, 'collector');
      return { collector: path.join(dir, 'strata-tune-collector.exe'), worker: path.join(dir, 'strata-tune-worker.exe') };
    }
    const bin = (project: string) => path.join(app.getAppPath(), 'collector', project, 'bin', 'x64', 'Release', 'net10.0', 'win-x64');
    const first = (dir: string, names: string[]) => names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p)) ?? path.join(dir, names[0]);
    return {
      collector: first(bin('StrataTune.Collector'), ['strata-tune-collector.exe', 'StrataTune.Collector.exe']),
      worker: first(bin('StrataTune.Worker'), ['strata-tune-worker.exe', 'StrataTune.Worker.exe'])
    };
  }

  /** Idempotent: a second call while one is in flight joins it; a connected client returns at once. */
  start(): Promise<CollectorState> {
    if (this.state.status === 'connected') return Promise.resolve(this.state);
    if (!this.starting) this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<CollectorState> {
    this.reportOrphans();
    this.set('starting', 'Looking for a running collector…');
    const existing = readHandshake();
    if (existing && pidAlive(existing.pid)) {
      // A live collector is never doubled and its handshake never deleted: the
      // file is the only copy of its token, and a second elevated process is a
      // second UAC prompt. A health miss gets retries, then an error naming it.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await this.healthOk(existing)) {
          this.adopt(existing, 'Connected (reusing a running collector)');
          return this.state;
        }
        await delay(1000);
      }
      this.set('error', `A collector (pid ${existing.pid}) is running but does not answer on port ${existing.port}. Close it, then Retry.`);
      return this.state;
    }
    try {
      fs.unlinkSync(handshakePath());
    } catch {
      /* nothing stale to remove */
    }

    const { collector, worker } = this.exePaths();
    if (!fs.existsSync(collector)) {
      this.set('error', `Collector not built: ${collector}. Run dotnet build collector\\StrataTune.sln -c Release.`);
      return this.state;
    }
    this.set('elevating', 'Waiting for permission (UAC)…');
    const launch = launchElevated(collector, ['--serve', '--parent-pid', String(process.pid), '--worker', `"${worker}"`]);

    // PowerShell returns only once the prompt is answered, so the 20 s budget
    // starts then: a prompt the user has not reached yet is not a slow collector.
    let deadline = Date.now() + UAC_TIMEOUT_MS;
    let accepted = false;
    for (;;) {
      const h = readHandshake();
      if (h && pidAlive(h.pid) && (await this.healthOk(h))) {
        this.adopt(h, 'Connected');
        return this.state;
      }
      if (launch.exit !== null && launch.exit !== 0) {
        if (/cancel/i.test(launch.stderr)) this.set('declined', 'Permission declined');
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
        ? 'The collector did not answer within 20 s of the UAC prompt. Run it with --probe to see whether PawnIO and elevation are in order.'
        : 'The UAC prompt was not answered.'
    );
    return this.state;
  }

  private async healthOk(h: Handshake): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}${ROUTES.health}`, { headers: { Authorization: `Bearer ${h.token}` }, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const health = (await res.json()) as Health;
      return health.ok === true && health.pid === h.pid;
    } catch {
      return false;
    }
  }

  private adopt(h: Handshake, message: string) {
    this.handshake = h;
    this.reconnectDelay = RECONNECT_MIN_MS;
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

  gpu(): Promise<GpuFacts[]> {
    return this.get<GpuFacts[]>(ROUTES.gpu);
  }

  /** The collector samples for `seconds` before answering; our own pid never counts as a hog. */
  hogs(seconds: number): Promise<HogsResult> {
    return this.get<HogsResult>(ROUTES.hogs(seconds, process.pid), seconds * 1000 + 15_000);
  }

  /** Starts a worker run and polls it to completion so the renderer sees one call, one result. */
  async load(kind: LoadKind, seconds: number): Promise<LoadRun> {
    const request: LoadRunRequest = { kind, seconds };
    let run = await this.post<LoadRun>(ROUTES.load, request);
    const deadline = Date.now() + seconds * 1000 + 30_000;
    while (run.state === 'running' && Date.now() < deadline) {
      await delay(500);
      run = await this.get<LoadRun>(ROUTES.loadRun(run.id));
    }
    if (run.state === 'running') throw new Error(`Load run ${run.id} did not finish within ${seconds + 30} s`);
    return run;
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
        res.on('error', (e) => this.streamClosed(e.message));
      }
    );
    req.on('error', (e) => this.streamClosed(e.message));
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
    if (event !== 'tick' || data.length === 0) return;
    try {
      this.emit('tick', JSON.parse(data.join('\n')) as Tick);
    } catch (e) {
      console.warn('[collector] unreadable tick:', (e as Error).message);
    }
  }

  /** Reconnects with backoff while we believe the collector is up; a dead pid ends the session instead. */
  private streamClosed(reason: string) {
    this.stream = null;
    if (this.state.status !== 'connected' || !this.handshake) return;
    if (!pidAlive(this.handshake.pid)) {
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
