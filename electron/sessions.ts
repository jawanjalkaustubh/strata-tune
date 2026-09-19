/**
 * Session store (master plan section 6). One folder per capture under
 * %LOCALAPPDATA%\Strata Tune\sessions\<yyyy-mm-dd-hhmm>-<exe>.stsession, holding
 * session.json (metadata, static snapshot, QPC frequency) beside one gzipped
 * newline-JSON file per stream: frames (PresentMon rows), sensors (the
 * collector's 10 Hz rows) and gpu (GpuFacts from its 2 Hz ticks). Rows are
 * written as they arrive, so the writer holds nothing however long the capture;
 * a load reads the whole folder back into one CaptureSession for the analysis,
 * and that one does sit in memory. Deleting a session moves its folder to
 * .trash, and only "Empty trash" (behind a confirm) removes anything for good;
 * a capture that saw no frames is the one thing removed outright.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { HogsResult, SensorRow, StaticSnapshot } from '../src/collector-types';
import type { CaptureSession, FrameRow, GpuSample } from '../src/analysis/session-types';
import { benchSegments } from '../src/analysis/stutter';
import type { BenchSummary } from './bench-run';

const SESSION_EXT = '.stsession';
const TRASH = '.trash';
const FILES = { meta: 'session.json', frames: 'frames.ndjson.gz', sensors: 'sensors.ndjson.gz', gpu: 'gpu.ndjson.gz' } as const;

/** session.json. The stream files carry the rows; this carries everything about them. */
export interface SessionMeta {
  id: string;
  version: 1;
  startedAt: string;
  endedAt: string;
  game: CaptureSession['game'];
  /** 'manual', 'bench' (the built-in stutter bench), or Game Mode's words: 'process:<name>', 'fullscreen', 'hotkey'. */
  trigger: string;
  qpcFrequency: number;
  /** QPC of the first and last frame. */
  qpcStart: number;
  qpcEnd: number;
  frames: number;
  sensorRows: number;
  gpuRows: number;
  snapshot: StaticSnapshot | null;
  /** The collector's per-process sample at capture start (§11 case 6); absent in sessions written before it was taken. */
  hogs?: HogsResult | null;
  notes: string[];
  /** The report headline, written back once the renderer has analysed the session. */
  verdict: string | null;
  /** The bench's own --json line for a 'bench' session (plan section 11a); absent otherwise. */
  benchSummary?: BenchSummary | null;
}

/** What the list shows per session. */
export interface SessionListItem {
  id: string;
  exe: string;
  trigger: string;
  startedAt: string;
  durationS: number;
  frames: number;
  hasSensors: boolean;
  verdict: string | null;
}

export const sessionsDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Strata Tune', 'sessions');

const folderOf = (id: string) => path.join(sessionsDir(), id + SESSION_EXT);
const trashDir = () => path.join(sessionsDir(), TRASH);

/** Ids are folder names of our own making; anything else is refused before it reaches the filesystem. */
function checkId(id: string): string {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) throw new Error(`Not a session id: ${id}`);
  return id;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** yyyy-mm-dd-hhmm-<exe>, local time, the exe without its extension and anything a folder name cannot carry. */
export function sessionId(startedAt: Date, exe: string): string {
  const d = startedAt;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = exe.replace(/\.exe$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 48) || 'capture';
  let id = `${stamp}-${name}`;
  for (let n = 2; fs.existsSync(folderOf(id)); n++) id = `${stamp}-${name}-${n}`;
  return id;
}

/** A gzip stream of JSON lines; write() never blocks the caller, close() waits for the file to be complete. */
class NdjsonGz {
  private readonly gzip = zlib.createGzip();
  private readonly done: Promise<void>;
  rows = 0;

  constructor(file: string) {
    const out = fs.createWriteStream(file);
    this.done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      this.gzip.on('error', reject);
    });
    this.gzip.pipe(out);
  }

  write(rows: readonly unknown[]): void {
    if (rows.length === 0) return;
    this.rows += rows.length;
    this.gzip.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  close(): Promise<void> {
    this.gzip.end();
    return this.done;
  }
}

/** The three streams of one capture, open from construction until finish() or discard(). */
export class SessionWriter {
  readonly id: string;
  readonly dir: string;
  private readonly frames: NdjsonGz;
  private readonly sensors: NdjsonGz;
  private readonly gpu: NdjsonGz;

  constructor(startedAt: Date, exe: string) {
    this.id = sessionId(startedAt, exe);
    this.dir = folderOf(this.id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = new NdjsonGz(path.join(this.dir, FILES.frames));
    this.sensors = new NdjsonGz(path.join(this.dir, FILES.sensors));
    this.gpu = new NdjsonGz(path.join(this.dir, FILES.gpu));
  }

  writeFrames(rows: readonly FrameRow[]): void {
    this.frames.write(rows);
  }

  writeSensors(rows: readonly SensorRow[]): void {
    this.sensors.write(rows);
  }

  writeGpu(sample: GpuSample): void {
    this.gpu.write([sample]);
  }

  private closeAll(): Promise<void> {
    return Promise.all([this.frames.close(), this.sensors.close(), this.gpu.close()]).then(() => undefined);
  }

  /** Closes the streams and writes session.json last, so a folder without it is a capture that did not finish. */
  async finish(meta: Omit<SessionMeta, 'id' | 'version' | 'frames' | 'sensorRows' | 'gpuRows'>): Promise<SessionMeta> {
    await this.closeAll();
    const full: SessionMeta = { ...meta, id: this.id, version: 1, frames: this.frames.rows, sensorRows: this.sensors.rows, gpuRows: this.gpu.rows };
    fs.writeFileSync(path.join(this.dir, FILES.meta), JSON.stringify(full, null, 2));
    return full;
  }

  /** A capture that saw no frames leaves nothing behind. */
  async discard(): Promise<void> {
    await this.closeAll().catch(() => undefined);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function readMeta(dir: string): SessionMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, FILES.meta), 'utf-8')) as Partial<SessionMeta>;
    return typeof m.id === 'string' && typeof m.startedAt === 'string' && typeof m.game?.exe === 'string' ? (m as SessionMeta) : null;
  } catch {
    return null;
  }
}

function readNdjsonGz<T>(file: string): T[] {
  let text: string;
  try {
    text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      /* a line cut short by a crash mid-write; the rows before it are good */
    }
  }
  return rows;
}

const durationS = (m: SessionMeta) => Math.max(0, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000));

export function listItem(m: SessionMeta): SessionListItem {
  return { id: m.id, exe: m.game.exe, trigger: m.trigger, startedAt: m.startedAt, durationS: durationS(m), frames: m.frames, hasSensors: m.sensorRows > 0, verdict: m.verdict };
}

/** Newest first. A folder without a readable session.json is skipped, not shown broken. */
export function list(): SessionListItem[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionListItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(SESSION_EXT)) continue;
    const m = readMeta(path.join(sessionsDir(), e.name));
    if (m) out.push(listItem(m));
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function load(id: string): CaptureSession {
  const dir = folderOf(checkId(id));
  const meta = readMeta(dir);
  if (!meta) throw new Error(`Session ${id} has no readable session.json`);
  const sensorRows = readNdjsonGz<SensorRow>(path.join(dir, FILES.sensors));
  return {
    id: meta.id,
    startedAt: meta.startedAt,
    game: meta.game,
    qpcFrequency: meta.qpcFrequency,
    frames: readNdjsonGz<FrameRow>(path.join(dir, FILES.frames)),
    // The collector's window shape over the capture span; a capture without the collector has none.
    sensorWindow: sensorRows.length > 0 ? { seconds: durationS(meta), qpcNow: meta.qpcEnd, rows: sensorRows, summaries: [] } : null,
    snapshot: meta.snapshot,
    gpuTimeline: readNdjsonGz<GpuSample>(path.join(dir, FILES.gpu)),
    hogs: meta.hogs ?? null,
    notes: meta.notes,
    // The bench's own segment timings reach the classifier's bench check (plan section 11a); a game capture has none.
    benchSummary: meta.benchSummary ? { script: meta.benchSummary.script, segments: benchSegments(meta.benchSummary.segments) } : null
  };
}

export function folder(id: string): string {
  return folderOf(checkId(id));
}

/** The headline the renderer's analysis produced, kept with the session so the list can show it next time. */
export function setVerdict(id: string, verdict: string): void {
  const dir = folderOf(checkId(id));
  const meta = readMeta(dir);
  if (!meta) return;
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify({ ...meta, verdict }, null, 2));
}

/** Moves the folder into sessions/.trash; a same-named folder already there gets a suffix, nothing is overwritten. */
export function remove(id: string): void {
  const from = folderOf(checkId(id));
  const trash = trashDir();
  fs.mkdirSync(trash, { recursive: true });
  let to = path.join(trash, id + SESSION_EXT);
  for (let n = 2; fs.existsSync(to); n++) to = path.join(trash, `${id}-${n}${SESSION_EXT}`);
  fs.renameSync(from, to);
}

/** Session folders waiting in .trash. */
export function trashCount(): number {
  try {
    return fs.readdirSync(trashDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.endsWith(SESSION_EXT)).length;
  } catch {
    return 0;
  }
}

/** Removes every session folder in .trash for good; the count taken. Only session folders, nothing else that may have landed there. */
export function emptyTrash(): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(trashDir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(SESSION_EXT)) continue;
    fs.rmSync(path.join(trashDir(), e.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
