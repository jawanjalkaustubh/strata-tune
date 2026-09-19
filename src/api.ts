import type { SupportLinks } from './support';
import type { FlightLine, GpuFacts, HogsResult, LoadKind, LoadRun, SensorMeta, SensorRow, SensorWindow, StaticSnapshot, PstateDeltas, Tick, Timers, TuneExport, TuneRun, TuneRunKind, TuneStatus } from './collector-types';
import type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaList } from '../electron/bench';
import type { CaptureFrames, CaptureState, ProcessPick, SessionListItem } from '../electron/capture';
import type { CaptureSession } from './analysis/session-types';
import type { Report } from './report/report-types';
import type { ScoreSheet } from './report/score-types';
import type { HistoryEntry } from './analysis/history';
import type { AboutSystem, DirectXInfo, LegalTexts, SaveFileRequest } from '../electron/about';
import type { LegalStatus } from '../electron/legal';

export type { BenchError, BenchGpuRequest, GpuBench, OllamaBench, OllamaInstalled, OllamaList } from '../electron/bench';
export type { BenchSummary, CaptureFrames, CaptureState, CaptureStatus, PickGroup, ProcessInfo, ProcessPick, SessionListItem } from '../electron/capture';

/** Measurements for the AI stats card (electron/bench.ts); every call answers { error } rather than throwing. */
export interface AdvisorApi {
  /** run false answers from the bench.json cache (null when nothing usable); run true measures and caches. */
  benchGpu(req: BenchGpuRequest): Promise<GpuBench | BenchError | null>;
  benchOllama(model: string): Promise<OllamaBench | BenchError>;
  /** Stop (plan section 17c): kills the worker mid-sweep; the pending benchGpu answers { error, code: 'cancelled' }. */
  cancelBenchGpu(): Promise<void>;
  /** Stop: aborts the timed generation; the pending benchOllama answers { error, code: 'cancelled' }. */
  cancelBenchOllama(): Promise<void>;
  ollamaList(): Promise<OllamaList | BenchError>;
  ollamaUnload(): Promise<{ unloaded: string[] } | BenchError>;
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
  /** Stop (plan section 17c): cancels the load run in flight, so the pending load() resolves with state 'cancelled'; answers whether one was cancelled. */
  cancelLoad(): Promise<boolean>;
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
  /** The comparison sheet of a scored run (plan section 16) through the same template and save dialog. */
  exportSheet(sheet: ScoreSheet): Promise<string | null>;
  trashCount(): Promise<number>;
  emptyTrash(): Promise<number | null>;
}

/** Fix verification (electron/history.ts, plan section 15): add appends and answers the whole list. */
export interface HistoryApi {
  list(): Promise<HistoryEntry[]>;
  add(entry: HistoryEntry): Promise<HistoryEntry[]>;
}

/** The user's "never test above" clocks for a hunt (plan section 16), absent fields meaning no cap. */
export interface TuneCaps {
  coreCapMhz?: number;
  memCapMhz?: number;
}

/**
 * OC auto-tune (electron/tune.ts, plan section 16). Every write answers the whole
 * TuneStatus; a refusal rejects with the collector's reason. Run events are pushed
 * only between subscribe and unsubscribe.
 */
export interface TuneApi {
  state(): Promise<TuneStatus>;
  /** On records the warning's acknowledgement (`acknowledgedAt`); off takes anything of Tune's off the card first. */
  enable(enabled: boolean, acknowledgedAt?: string): Promise<TuneStatus>;
  /** `enabled` is this side's setting, checked beside the collector's file flag so neither can start a hunt alone; 'hunt' is memory then core, each from the card as found; `vendor` is what the user's vendor tool shows (core MHz, memory in the slider's units), needed when a tune of the tool's is on the card. */
  start(kind: TuneRunKind, enabled: boolean, vendor?: PstateDeltas, caps?: TuneCaps): Promise<TuneStatus>;
  stop(): Promise<TuneStatus>;
  /** Takes anything of Tune's off the card now, or acknowledges a crash revert. */
  revert(): Promise<TuneStatus>;
  /** Writes our 0 / 0 so the vendor tool's next Apply owns the card again. */
  release(): Promise<TuneStatus>;
  /** Writes the vendor values when the driver reads 0 / 0 (the keep-at-startup switch). */
  hold(vendor: PstateDeltas): Promise<TuneStatus>;
  /** Null until a hunt has a result. */
  export(): Promise<TuneExport | null>;
  /** The last 30 s before a hard hang; null when no crash has been found at a start. */
  flight(): Promise<FlightLine[] | null>;
  subscribe(): void;
  unsubscribe(): void;
  onRun(cb: (run: TuneRun) => void): () => void;
}

/** The About hub (electron/about.ts, plan section 17 'About'): reads only, plus a save dialog for the tools' files. */
export interface AboutApi {
  system(): Promise<AboutSystem>;
  /** Cached per Windows build; the first call runs dxdiag, about 20 s. */
  directx(): Promise<DirectXInfo>;
  /** LICENSE, DISCLAIMER.md and THIRD-PARTY-NOTICES.md verbatim from the bundled files (plan 27a). */
  legal(): Promise<LegalTexts>;
  /** GET /timers; with `traceSeconds` the collector runs powercfg's energy trace to name who holds the timer. */
  timers(traceSeconds?: number): Promise<Timers>;
  /** Asks where to save and writes the file; resolves the path, or null when cancelled. */
  saveFile(req: SaveFileRequest): Promise<string | null>;
  openLogs(): Promise<void>;
}

/** First launch (electron/legal.ts, plan 27a): the disclaimer's acceptance record; accept writes it for the current version and starts the collector that waited. */
export interface LegalApi {
  status(): Promise<LegalStatus>;
  accept(): Promise<LegalStatus>;
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
  about: AboutApi;
  legal: LegalApi;
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
