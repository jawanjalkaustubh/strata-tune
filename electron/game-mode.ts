// Copied unchanged from Strata Video (master plan section 20). The section and
// phase numbers below refer to that app's plan, not this one's. Not imported yet.
// Game Mode (master plan section 9). Hotkey first, process allowlist second,
// exclusive-fullscreen detection third. Never relies on detection alone,
// because most modern games run borderless-windowed and never trip the
// fullscreen check.
//
// v1 interrupts and re-queues the running job. Checkpoint/resume is Phase 7.

import { globalShortcut } from 'electron';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';

export const GAME_MODE_HOTKEY = 'CommandOrControl+Shift+G';

// Common launchers and engines. Users extend this in settings later.
const DEFAULT_ALLOWLIST = [
  'cyberpunk2077', 'witcher3', 'eldenring', 'helldivers2', 'cs2', 'dota2', 'valorant', 'overwatch',
  'fortniteclient-win64-shipping', 'rocketleague', 'gta5', 'rdr2', 'baldursgate3', 'bg3', 'starfield',
  'hogwartslegacy', 'monsterhunterwilds', 'blackmythwukong', 'palworld-win64-shipping'
];

// Cheap probes. The process list comes from tasklist (a few ms); the fullscreen
// query only runs when no allowlisted game is found, and uses PowerShell's
// built-in P/Invoke cache so nothing is compiled per call.
const FULLSCREEN_PRELUDE = `if(-not ('Q' -as [type])){Add-Type -Name Q -Namespace W -MemberDefinition '[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);' | Out-Null};$s=0;[void][W.Q]::SHQueryUserNotificationState([ref]$s);$s`;

export interface GameModeState {
  active: boolean;
  /** 'hotkey' | 'process:<name>' | 'fullscreen' | null */
  trigger: string | null;
}

export class GameMode extends EventEmitter {
  private state: GameModeState = { active: false, trigger: null };
  private timer: NodeJS.Timeout | null = null;
  private allowlist = new Set(DEFAULT_ALLOWLIST);
  private manual = false;
  private clearSince: number | null = null;
  private busyProvider: () => boolean = () => false;

  get active() {
    return this.state.active;
  }

  /** Tell Game Mode whether a GPU job is running, so it polls faster while one is. */
  setBusyProvider(fn: () => boolean) {
    this.busyProvider = fn;
  }

  setAllowlist(names: string[]) {
    this.allowlist = new Set(names.map((n) => n.toLowerCase().replace(/\.exe$/, '')));
  }

  start() {
    try {
      globalShortcut.register(GAME_MODE_HOTKEY, () => this.toggleManual());
    } catch {
      /* hotkey may be taken; detection still works */
    }
    this.schedule();
  }

  stop() {
    try {
      globalShortcut.unregister(GAME_MODE_HOTKEY);
    } catch {
      /* ignore */
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  toggleManual() {
    this.manual = !this.manual;
    if (this.manual) this.enter('hotkey');
    else this.exit();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    const interval = this.busyProvider() ? 10_000 : 30_000;
    this.timer = setTimeout(() => this.poll().finally(() => this.schedule()), interval);
  }

  /** Names of running processes, lower-cased, without .exe. */
  private listProcesses(): Promise<string[]> {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        const names: string[] = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line);
          if (m) names.push(m[1].toLowerCase().replace(/\.exe$/, ''));
        }
        resolve(names);
      });
    });
  }

  /** QUNS_RUNNING_D3D_FULL_SCREEN. Only called when the process list found nothing. */
  private fullscreenApp(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', FULLSCREEN_PRELUDE], { encoding: 'utf-8', windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(parseInt(String(stdout).trim().split('\n').pop() || '0', 10) === 3);
      });
    });
  }

  private async probe(): Promise<{ fullscreen: boolean; game: string | null }> {
    const procs = await this.listProcesses();
    const game = procs.find((p) => this.allowlist.has(p)) || null;
    if (game) return { fullscreen: false, game };
    return { fullscreen: await this.fullscreenApp(), game: null };
  }

  private async poll() {
    if (process.platform !== 'win32' || this.manual) return;
    const { fullscreen, game } = await this.probe();
    const detected = game ? `process:${game}` : fullscreen ? 'fullscreen' : null;
    if (detected) {
      this.clearSince = null;
      if (!this.state.active) this.enter(detected);
    } else if (this.state.active) {
      // Require 30 s clear before resuming so alt-tabbing does not thrash.
      if (this.clearSince === null) this.clearSince = Date.now();
      else if (Date.now() - this.clearSince > 30_000) this.exit();
    }
  }

  private enter(trigger: string) {
    if (this.state.active) return;
    this.state = { active: true, trigger };
    this.emit('enter', this.state);
  }

  private exit() {
    if (!this.state.active) return;
    this.state = { active: false, trigger: null };
    this.clearSince = null;
    this.emit('exit', this.state);
  }
}
