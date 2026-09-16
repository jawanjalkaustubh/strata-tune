// Sibling presence for the shared Ollama daemon (lifecycle audit 2026-09-15,
// section 2.2). One file per running Strata app under
// %LOCALAPPDATA%\Strata\presence\<app>.json:
//
//   { "pid": 1234, "app": "tune", "models": ["qwen3.8:27b"], "since": "<ISO>" }
//
// Written (tmp + rename) whenever this process sends a load request for a
// model (every /api/chat, /api/generate, warm, caption), rewritten when it
// unloads one, deleted at graceful quit. A dead writer leaves a stale file;
// readers drop entries whose pid is not alive and unlink them.
//
// Ownership is the Set of models THIS process sent a load request for in THIS
// session, added at send time. Never derived from config names, from /api/ps
// or from gpu.lock. The presence file's `models` array is exactly that Set.
//
// Identical in Strata Photo, Code, Video and Tune; Tune has no Ollama use yet,
// so nothing here is called today.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type StrataApp = 'photo' | 'code' | 'video' | 'tune';

export interface Presence {
  pid: number;
  app: StrataApp;
  models: string[];
  since: string;
}

/** One keep_alive for every Ollama request (chat, generate, warm). A shorter one from any app expires the model for everyone. */
export const KEEP_ALIVE = '15m';

export const OLLAMA_URL = 'http://127.0.0.1:11434';

export const PRESENCE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Strata',
  'presence'
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Model names compare like Ollama reports them: case-insensitive, a bare "name" is its ":latest". Same rule in Photo, Code and Video. */
export function normalizeModelName(name: string): string {
  const n = (name || '').trim().toLowerCase();
  if (!n) return '';
  return n.includes(':') ? n : `${n}:latest`;
}

export function sameModel(a: string, b: string): boolean {
  return normalizeModelName(a) === normalizeModelName(b);
}

/** process.kill(pid, 0) throws for a dead pid; EPERM means it exists but we cannot signal it (an elevated sibling), so alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

function presencePath(app: StrataApp): string {
  return path.join(PRESENCE_DIR, `${app}.json`);
}

function parsePresence(raw: string): Presence | null {
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p.pid !== 'number' || typeof p.app !== 'string' || !Array.isArray(p.models)) return null;
    return {
      pid: p.pid,
      app: p.app as StrataApp,
      models: p.models.filter((m: unknown): m is string => typeof m === 'string'),
      since: typeof p.since === 'string' ? p.since : ''
    };
  } catch {
    return null;
  }
}

/**
 * Live sibling presences: every file in the directory whose pid is alive and
 * is not our own. Files of dead writers and unparsable files are unlinked.
 */
export function readSiblings(): Presence[] {
  let names: string[];
  try {
    names = fs.readdirSync(PRESENCE_DIR);
  } catch {
    return [];
  }
  const out: Presence[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(PRESENCE_DIR, name);
    let p: Presence | null = null;
    try {
      p = parsePresence(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!p || !pidAlive(p.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* another reader got there first */
      }
      continue;
    }
    if (p.pid === process.pid) continue;
    out.push(p);
  }
  return out;
}

/** Live siblings whose presence lists the model. */
export function siblingsHolding(model: string): Presence[] {
  return readSiblings().filter((s) => s.models.some((m) => sameModel(m, model)));
}

/**
 * The unload rule (quit, idle, before-load, Free RAM): keep_alive:0 for M iff
 * no live sibling presence lists M. At quit additionally only if M is in the
 * own Set or - with no sibling alive at all - M is one of the models this app
 * is configured to load (`configured`), the same rule Photo, Code and Video
 * apply. A model this app never loaded and no slot names (a user's own
 * `ollama run`) is never touched; the explicit "Evict" button is the only
 * evict-all and does not go through here.
 */
export function mayUnload(model: string, own: ReadonlySet<string>, atQuit: boolean, configured: Iterable<string> = []): boolean {
  const siblings = readSiblings();
  if (siblings.some((s) => s.models.some((m) => sameModel(m, model)))) return false;
  const owned = [...own].some((m) => sameModel(m, model));
  if (atQuit) return owned || (siblings.length === 0 && [...configured].some((m) => sameModel(m, model)));
  return owned;
}

/**
 * POST {model, keep_alive: 0} straight to the wire: no /api/version probe
 * first, 2 s bound, errors swallowed (Ollama down means nothing to unload).
 */
export async function unloadOllamaModel(model: string, base: string = OLLAMA_URL, timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * This process's presence file plus its ownership Set. One instance per app,
 * constructed at module load (a constructor touches no file); the first
 * `loaded()` creates the file.
 */
export class PresenceFile {
  private readonly models = new Set<string>();
  private readonly since = new Date().toISOString();
  private written = false;

  constructor(private readonly app: StrataApp) {}

  /** Models this process has sent a load request for in this session. */
  get own(): ReadonlySet<string> {
    return this.models;
  }

  owns(model: string): boolean {
    return [...this.models].some((m) => sameModel(m, model));
  }

  /** Call at SEND time of every load request (chat, generate, warm, caption), not at completion. */
  loaded(model: string): void {
    const m = model.trim();
    if (!m || this.owns(m)) return;
    this.models.add(m);
    this.write();
  }

  /** Call after this process posted keep_alive:0 for the model. */
  unloaded(model: string): void {
    let removed = false;
    for (const m of [...this.models]) if (sameModel(m, model)) removed = this.models.delete(m) || removed;
    if (removed) this.write();
  }

  /** Unload rule for this process; see `mayUnload`. */
  mayUnload(model: string, atQuit: boolean, configured: Iterable<string> = []): boolean {
    return mayUnload(model, this.models, atQuit, configured);
  }

  /** Graceful quit: the file goes away so siblings stop counting us. Sync so it lands before app.quit. */
  remove(): void {
    if (!this.written) return;
    this.written = false;
    try {
      fs.unlinkSync(presencePath(this.app));
    } catch {
      /* already gone */
    }
  }

  /** Atomic: tmp + rename, so a reader never sees a half-written file. */
  private write(): void {
    const body: Presence = { pid: process.pid, app: this.app, models: [...this.models], since: this.since };
    const file = presencePath(this.app);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(PRESENCE_DIR, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf-8');
      fs.renameSync(tmp, file);
      this.written = true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
  }
}

/**
 * Before loading anything big: is the VRAM held by a live sibling? Returns the
 * "GPU held by <app> (<model>)" text for the UI, or null when nothing is held.
 * The caller offers an explicit Evict; nothing evicts automatically.
 */
export async function heldBySibling(base: string = OLLAMA_URL): Promise<string | null> {
  const siblings = readSiblings();
  if (siblings.length === 0) return null;
  // /api/ps is ground truth for what is resident; when Ollama does not answer
  // the presence lists alone name the holder instead of reading "GPU free".
  let resident: string[] | null = null;
  try {
    const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(1500) });
    const j: any = r.ok ? await r.json() : null;
    if (Array.isArray(j?.models)) resident = j.models.map((m: any) => String(m?.name ?? m?.model ?? ''));
  } catch {
    resident = null;
  }
  for (const s of siblings) {
    const held = resident ? s.models.find((m) => resident!.some((r) => sameModel(r, m))) : s.models[0];
    if (held) return `GPU held by ${s.app} (${held})`;
  }
  return null;
}

/** Wait helper for Promise.race in a bounded shutdown. */
export { sleep };
