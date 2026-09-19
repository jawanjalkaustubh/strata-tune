/**
 * PresentMon capture host (master plan section 11; docs/dependencies.md for
 * every flag). Lives in Electron main rather than the collector because a
 * member of Performance Log Users needs no elevation for an ETW session, and
 * PresentMon stamps its own QPC so the correlation with the collector's
 * sensor window is unchanged (Appendix A).
 *
 * One child at a time, filtered to one pid so our own presents never enter
 * the stream. Stdout is the CSV: header first, then one row per present,
 * batched to the owner every 250 ms.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { parseHeader, parseLine } from '../src/analysis/frames';
import type { FrameRow } from '../src/analysis/session-types';

const IMAGE = 'PresentMon-2.5.1-x64.exe';
/** Never the default "PresentMon": --stop_existing_session would end a CapFrameX or RTSS capture of that name. */
const SESSION_NAME = 'StrataTune';
const BATCH_MS = 250;
/** --terminate_on_proc_exit only fires once the target has presented; a target that never did leaves PresentMon to us. */
const LINGER_MS = 5000;
const TARGET_POLL_MS = 1000;
const STOP_WAIT_MS = 3000;

export type PresentMonAvailability = { installed: true; exe: string } | { installed: false; message: string };

export interface PresentMonExit {
  code: number | null;
  /** null for a clean end (exit 0, the target exited, or our own stop); otherwise one plain sentence. */
  message: string | null;
}

export interface PresentMonTarget {
  pid: number;
  exe: string;
  /**
   * Filter by image name instead of pid. A Chromium-style app presents from a helper
   * process, not the one with the window, so a pid filter on the window's process would
   * see nothing; a game is one process and the pid is the precise choice (an elevated
   * game shows as <unknown> to an unelevated PresentMon, which a name cannot match).
   */
  byName: boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Signal 0 only queries; EPERM is a process that exists but is not ours (an elevated game). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Dev: the vendored exe next to its README. Packaged: resources/presentmon. */
export function presentMonExe(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'presentmon', IMAGE) : path.join(app.getAppPath(), 'tools', 'presentmon', IMAGE);
}

export function availability(): PresentMonAvailability {
  const exe = presentMonExe();
  if (fs.existsSync(exe)) return { installed: true, exe };
  return { installed: false, message: `PresentMon is not installed: run scripts\\setup-tools.ps1 to fetch it (expected at ${exe})` };
}

/**
 * Whether this account may open an ETW trace session without elevation, which is what
 * PresentMon needs: membership of Performance Log Users (well-known SID S-1-5-32-559),
 * counted in the token this process runs with. The dev box's account is a member and the
 * README assumed everyone's is; the first laptop's was not, and the first capture failed with
 * exit 6 after the bench had already started (2026-09-19). Checked once at start and again
 * after the app adds the account, so the Capture page can say so before Start.
 */
export interface TraceAccess {
  allowed: boolean;
  /** One sentence for the page when not allowed. */
  reason: string | null;
}

const PERFORMANCE_LOG_USERS_SID = 'S-1-5-32-559';
export const PERFORMANCE_LOG_USERS = 'Performance Log Users';

export function traceAccess(): Promise<TraceAccess> {
  return new Promise((resolve) => {
    execFile('whoami', ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        // The check itself failing is not a refusal: Start still tries, and PresentMon's exit says the rest.
        resolve({ allowed: true, reason: null });
        return;
      }
      const line = stdout.split(/\r?\n/).find((l) => l.includes(PERFORMANCE_LOG_USERS_SID));
      // A group listed "for deny only" is one the token carries but cannot use (a filtered admin token, for instance).
      const allowed = !!line && !/deny only/i.test(line);
      resolve({
        allowed,
        reason: allowed ? null : `Capturing frames needs your Windows account in the ${PERFORMANCE_LOG_USERS} group, which it is not in yet. Strata Tune can add it (Windows asks once); sign out and back in afterwards for it to take.`
      });
    });
  });
}

/**
 * Adds this account to Performance Log Users through one UAC prompt (net localgroup, run
 * elevated by the shell). Membership lands in the next logon's token, so the answer says to
 * sign out and back in; nothing else on the machine changes.
 */
export function grantTraceAccess(): Promise<{ ok: boolean; message: string }> {
  const user = process.env.USERNAME ?? '';
  if (!user) return Promise.resolve({ ok: false, message: 'Could not read the account name from the environment.' });
  // PowerShell's Start-Process -Verb RunAs is the shell's own elevation; -Wait returns the exit code net.exe gave.
  const script = `$p = Start-Process -FilePath net.exe -ArgumentList 'localgroup','"${PERFORMANCE_LOG_USERS}"','"${user.replace(/"/g, '')}"','/add' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 120_000 }, (err) => {
      if (err) {
        const code = (err as { code?: number | string }).code;
        // 1223 is the UAC prompt declined; 2 is net.exe's "already a member" (NET HELPMSG 1378 spelled as exit 2).
        const message = code === 1223 || /canceled|cancelled/i.test(err.message) ? 'The prompt was declined; nothing changed.' : code === 2 ? `The account is already in ${PERFORMANCE_LOG_USERS}: sign out and back in for Windows to apply it.` : `Windows did not add the account (${err.message.trim().split('\n')[0]}). You can do it by hand: run "net localgroup \\"${PERFORMANCE_LOG_USERS}\\" ${user} /add" as administrator, then sign out and back in.`;
        resolve({ ok: code === 2, message });
        return;
      }
      resolve({ ok: true, message: `Added ${user} to ${PERFORMANCE_LOG_USERS}. Sign out and back in (or restart), then capture.` });
    });
  });
}

function exitMessage(code: number | null, stderrTail: string): string | null {
  switch (code) {
    case 0:
      return null;
    case 1:
      return 'PresentMon rejected its arguments';
    case 6:
      return 'ETW session refused: run once as administrator or join Performance Log Users';
    case 7:
      return 'PresentMon could not stop the trace session it found running';
    default:
      return `PresentMon exited with code ${code ?? 'unknown'}${stderrTail ? `: ${stderrTail}` : ''}`;
  }
}

export class PresentMonHost extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private header: string[] | null = null;
  private pending: FrameRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stderrTail = '';

  get running(): boolean {
    return this.child !== null;
  }

  /** Emits 'frame' (FrameRow[]) every 250 ms while rows arrive and 'exit' (PresentMonExit) once, after the last rows. */
  start(target: PresentMonTarget): void {
    if (this.child) throw new Error('PresentMon is already running');
    const a = availability();
    if (!a.installed) throw new Error(a.message);

    const filter = target.byName ? ['--process_name', target.exe] : ['--process_id', String(target.pid)];
    const args = [...filter, '--output_stdout', '--qpc_time', '--stop_existing_session', '--terminate_on_proc_exit', '--session_name', SESSION_NAME];
    const child = spawn(a.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.stopping = false;
    this.header = null;
    this.pending = [];
    this.stderrTail = '';

    // A pipe gets narrow text with CRLF (a console would get UTF-16); utf8 would mangle nothing today but is the wrong contract.
    let buffer = '';
    child.stdout!.setEncoding('latin1');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        this.line(line);
      }
    });
    // Diagnostics only (the <unknown>-process warning lands here on every unelevated run); kept for the error message.
    child.stderr!.setEncoding('latin1');
    child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-400);
    });
    // A spawn failure reports here and may never close; finish() ignores whichever comes second.
    child.on('error', (e) => {
      this.stderrTail = e.message;
      this.finish(null);
    });
    child.once('close', (code) => {
      if (buffer) this.line(buffer.replace(/\r$/, ''));
      this.finish(code);
    });
    this.armWatchdog(target.pid);
  }

  /** Ends the capture and closes the ETW session the kill leaves behind. */
  async stop(): Promise<void> {
    if (!this.child) return;
    await this.terminate();
    await terminateSession();
  }

  /** App quit: the same, without waiting for the cleanup (its own process, it outlives us). */
  async abandon(): Promise<void> {
    if (!this.child) return;
    await this.terminate();
    void terminateSession();
  }

  /** PresentMon cannot take a Ctrl+C from here, so it is terminated; resolves once its pipes close, or after a bound with the exit forced so the save always runs. */
  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    await Promise.race([closed, delay(STOP_WAIT_MS)]);
    if (this.child === child) this.finish(null);
  }

  /** Rows after a forced exit belong to no run and are dropped. */
  private line(line: string): void {
    if (!line || !this.child) return;
    if (!this.header) {
      this.header = parseHeader(line);
      return;
    }
    const row = parseLine(this.header, line);
    if (!row) return;
    this.pending.push(row);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    this.emit('frame', rows);
  }

  /** The target may die before it ever presents, and then --terminate_on_proc_exit never fires: kill PresentMon 5 s after the pid goes. */
  private armWatchdog(pid: number): void {
    let goneAt: number | null = null;
    this.watchdog = setInterval(() => {
      if (pidAlive(pid)) return;
      goneAt ??= Date.now();
      if (Date.now() - goneAt >= LINGER_MS && this.child && !this.stopping) {
        console.warn(`[presentmon] target pid ${pid} is gone and PresentMon lingers; terminating it`);
        this.stopping = true;
        this.child.kill();
        void terminateSession();
      }
    }, TARGET_POLL_MS);
  }

  private finish(code: number | null): void {
    if (!this.child) return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.flush();
    this.child = null;
    const exit: PresentMonExit = { code, message: this.stopping ? null : exitMessage(code, this.stderrTail.trim().split(/\r?\n/).pop() ?? '') };
    this.stopping = false;
    this.emit('exit', exit);
  }
}

/** Closes a StrataTune ETW session left behind by a terminated PresentMon; harmless when there is none. */
export function terminateSession(): Promise<void> {
  const a = availability();
  if (!a.installed) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(a.exe, ['--terminate_existing_session', '--session_name', SESSION_NAME], { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}
