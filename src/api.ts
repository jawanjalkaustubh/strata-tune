import type { SupportLinks } from './support';
import type { FlightLine, GpuFacts, HogsResult, LoadKind, LoadRun, SensorMeta, SensorRow, SensorWindow, StaticSnapshot, Tick, TuneExport, TuneRun, TuneStatus } from './collector-types';
import type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaList } from '../electron/bench';
import type { CaptureFrames, CaptureState, ProcessPick, SessionListItem } from '../electron/capture';
import type { CaptureSession } from './analysis/session-types';
import type { Report } from './report/report-types';
import type { HistoryEntry } from './analysis/history';

export type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaInstalled, OllamaList } from '../electron/bench';
export type { BenchSummary, CaptureFrames, CaptureState, CaptureStatus, PickGroup, ProcessInfo, ProcessPick, SessionListItem } from '../electron/capture';

/** Measurements for the AI stats card (electron/bench.ts); every call answers { error } rather than throwing. */
export interface AdvisorApi {
  /** run false answers from the bench.json cache (null when nothing usable); run true measures and caches. */
  benchGpu(req: BenchGpuRequest): Promise<GpuBench | BenchError | null>;
  benchOllama(model: string): Promise<OllamaBench | BenchError>;
  ollamaList(): Promise<OllamaList | BenchError>;
}

/** The main process's view of the elevated collector (electron/collector.ts). */
export type CollectorStatus = 'idle' | 'starting' | 'elevating' | 'connected' | 'declined' | 'error' | 'stopped';

export interface CollectorState {
  status: CollectorStatus;
  message: string;
}

export interface CollectorApi {
  status(): Promise<CollectorState>;
  /** Also the retry after a declined UAC prompt. */
  start(): Promise<CollectorState>;
  snapshot(): Promise<StaticSnapshot>;
  sensorsMeta(): Promise<SensorMeta[]>;
  sensorsLatest(): Promise<SensorRow>;
  /** Full-rate rows for up to ten minutes, 1 Hz summaries beyond (Phase 2's min/max/mean view). */
  sensorsWindow(seconds: number): Promise<SensorWindow>;
  gpu(): Promise<GpuFacts[]>;
  hogs(seconds: number): Promise<HogsResult>;
  /** Resolves once the run is done or failed; the main process polls the collector. */
  load(kind: LoadKind, seconds: number): Promise<LoadRun>;
  subscribe(): void;
  unsubscribe(): void;
  onTick(cb: (tick: Tick) => void): () => void;
  onStatus(cb: (state: CollectorState) => void): () => void;
}

/** Frame capture (electron/capture.ts): PresentMon on one pid, Game Mode when armed; state and live frames are pushed. */
export interface CaptureApi {
  state(): Promise<CaptureState>;
  /** Windowed processes in the picker's groups (electron/picker.ts); the built-in bench is not among them. */
  processes(): Promise<ProcessPick[]>;
  start(pid: number): Promise<CaptureState>;
  /** The built-in stutter bench (electron/bench-run.ts): rejects with the reason when the GPU is not free. */
  startBench(): Promise<CaptureState>;
  stop(): Promise<CaptureState>;
  arm(on: boolean): Promise<CaptureState>;
  onState(cb: (state: CaptureState) => void): () => void;
  onFrames(cb: (frames: CaptureFrames) => void): () => void;
}

/** Saved sessions (electron/sessions.ts). delete moves to .trash; emptyTrash asks first and answers the count removed, or null when kept; exportHtml fills the built report template and asks where to save it. */
export interface SessionsApi {
  list(): Promise<SessionListItem[]>;
  load(id: string): Promise<CaptureSession>;
  delete(id: string): Promise<void>;
  setVerdict(id: string, verdict: string): Promise<void>;
  reveal(id: string): Promise<void>;
  exportHtml(data: Report): Promise<string | null>;
  trashCount(): Promise<number>;
  emptyTrash(): Promise<number | null>;
}

/** Fix verification (electron/history.ts, plan section 15): add appends and answers the whole list. */
export interface HistoryApi {
  list(): Promise<HistoryEntry[]>;
  add(entry: HistoryEntry): Promise<HistoryEntry[]>;
}

/**
 * OC auto-tune (electron/tune.ts, plan section 16). Every write answers the whole
 * TuneStatus; a refusal rejects with the collector's reason. Run events are pushed
 * only between subscribe and unsubscribe.
 */
export interface TuneApi {
  state(): Promise<TuneStatus>;
  /** On registers the revert-at-logon task and records the warning's acknowledgement (`acknowledgedAt`); off takes anything of Tune's off the card and removes it. */
  enable(enabled: boolean, acknowledgedAt?: string): Promise<TuneStatus>;
  /** `enabled` is this side's setting, checked beside the collector's file flag so neither can start a hunt alone. */
  start(kind: 'core' | 'memory', enabled: boolean): Promise<TuneStatus>;
  validate(): Promise<TuneStatus>;
  stop(): Promise<TuneStatus>;
  /** A validated result goes on the card as VALIDATING; a clean shutdown and a start promote it. */
  keep(): Promise<TuneStatus>;
  revert(): Promise<TuneStatus>;
  /** Null until a hunt has a result. */
  export(): Promise<TuneExport | null>;
  /** The last 30 s before a hard hang; null when no crash has been found at a start. */
  flight(): Promise<FlightLine[] | null>;
  subscribe(): void;
  unsubscribe(): void;
  onRun(cb: (run: TuneRun) => void): () => void;
}

/** What electron/preload.cjs exposes as window.strata. Keep the two in step. */
export interface StrataApi {
  version(): Promise<string>;
  support(): Promise<Partial<SupportLinks>>;

  minimize(): void;
  maximize(): void;
  close(): void;

  collector: CollectorApi;
  advisor: AdvisorApi;
  capture: CaptureApi;
  sessions: SessionsApi;
  history: HistoryApi;
  tune: TuneApi;
}

declare global {
  interface Window {
    strata?: StrataApi;
  }
}

/** Present only inside Electron. In a plain browser the UI renders but window controls are no-ops. */
export const api: StrataApi | undefined = window.strata;

export const inElectron = !!api;

/** ipcRenderer.invoke wraps a handler's throw as "Error invoking remote method 'x': Error: msg"; show only msg. */
export function ipcErrorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
