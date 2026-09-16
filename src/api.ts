import type { SupportLinks } from './support';
import type { GpuFacts, HogsResult, LoadKind, LoadRun, SensorMeta, SensorRow, SensorWindow, StaticSnapshot, Tick } from './collector-types';
import type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaList } from '../electron/bench';
import type { CaptureFrames, CaptureState, ProcessInfo, SessionListItem } from '../electron/capture';
import type { CaptureSession } from './analysis/session-types';
import type { Report } from './report/report-types';
import type { HistoryEntry } from './analysis/history';

export type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaInstalled, OllamaList } from '../electron/bench';
export type { CaptureFrames, CaptureState, CaptureStatus, ProcessInfo, SessionListItem } from '../electron/capture';

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
  processes(): Promise<ProcessInfo[]>;
  start(pid: number): Promise<CaptureState>;
  stop(): Promise<CaptureState>;
  arm(on: boolean): Promise<CaptureState>;
  onState(cb: (state: CaptureState) => void): () => void;
  onFrames(cb: (frames: CaptureFrames) => void): () => void;
}

/** Saved sessions (electron/sessions.ts). delete moves to .trash; exportHtml fills the built report template and asks where to save it. */
export interface SessionsApi {
  list(): Promise<SessionListItem[]>;
  load(id: string): Promise<CaptureSession>;
  delete(id: string): Promise<void>;
  setVerdict(id: string, verdict: string): Promise<void>;
  reveal(id: string): Promise<void>;
  exportHtml(data: Report): Promise<string | null>;
}

/** Fix verification (electron/history.ts, plan section 15): add appends and answers the whole list. */
export interface HistoryApi {
  list(): Promise<HistoryEntry[]>;
  add(entry: HistoryEntry): Promise<HistoryEntry[]>;
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
