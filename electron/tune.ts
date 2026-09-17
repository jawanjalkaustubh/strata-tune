/**
 * Main-process client for the collector's /tune/* routes and its `tune` SSE
 * events (master plan section 16). A thin pass-through: every write to the
 * card is decided and rate-limited in the elevated collector, and every reply
 * is the whole TuneStatus, so the page never needs a second round trip. Run
 * events cross the IPC bridge only while the Tune page asks for them, like the
 * 2 Hz ticks.
 */
import { app, type IpcMain } from 'electron';
import type { CollectorClient } from './collector';
import type { FlightLine, TuneEnableRequest, TuneExport, TuneRun, TuneRunKind, TuneStartRequest, TuneStatus } from '../src/collector-types';

/** Every route in one place, so a rename on the collector side is a one-line change. */
const ROUTES = {
  state: '/tune/state',
  enable: '/tune/enable',
  start: '/tune/start',
  validate: '/tune/validate',
  stop: '/tune/stop',
  keep: '/tune/keep',
  revert: '/tune/revert',
  export: '/tune/export',
  flight: '/tune/flight'
};

/** A write is acknowledged, not completed, inside this: a start answers once the worker is up, a revert once the driver has applied the baseline. */
const WRITE_TIMEOUT_MS = 30_000;

/**
 * STRATA_TUNE_MAX_CANDIDATES=n caps a hunt at n candidates: the bounded smoke test of the
 * ladder on a live card (the collector's TuneStartRequest.maxCandidates). Unset in
 * ordinary use, so the hunt runs to its ceiling.
 */
function maxCandidates(): number | undefined {
  const n = Number.parseInt(process.env.STRATA_TUNE_MAX_CANDIDATES ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export class TuneClient {
  constructor(private readonly c: CollectorClient) {}

  state(): Promise<TuneStatus> {
    return this.c.get<TuneStatus>(ROUTES.state);
  }

  /**
   * On: the collector records the warning's acknowledgement (date from the click, this app's
   * version; it adds the GPU name) and registers the logon revert task; off: it takes anything
   * of Tune's off the card, then removes the task.
   */
  enable(enabled: boolean, acknowledgedAt?: string): Promise<TuneStatus> {
    const request: TuneEnableRequest = enabled ? { enabled, acknowledgedAt, appVersion: app.getVersion() } : { enabled };
    return this.c.post<TuneStatus>(ROUTES.enable, request, WRITE_TIMEOUT_MS);
  }

  /** `enabled` is the renderer's own setting, checked beside the state file's flag so neither side can start a hunt alone. */
  start(kind: Exclude<TuneRunKind, 'validate'>, enabled: boolean): Promise<TuneStatus> {
    const request: TuneStartRequest = { kind, enabled, maxCandidates: maxCandidates() };
    return this.c.post<TuneStatus>(ROUTES.start, request, WRITE_TIMEOUT_MS);
  }

  /** The second phase (plan 16): the found values replayed at the user's real fan curve, 5 min heavy and 2 min transient. */
  validate(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.validate, {}, WRITE_TIMEOUT_MS);
  }

  stop(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.stop, {}, WRITE_TIMEOUT_MS);
  }

  /** Puts a validated result on the card as VALIDATING; a clean shutdown and a start promote it. */
  keep(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.keep, {}, WRITE_TIMEOUT_MS);
  }

  revert(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.revert, {}, WRITE_TIMEOUT_MS);
  }

  /** 404 until a hunt has a result: answered as null rather than an error. */
  async export(): Promise<TuneExport | null> {
    try {
      return await this.c.get<TuneExport>(ROUTES.export);
    } catch (e) {
      if (/answered 404/.test((e as Error).message)) return null;
      throw e;
    }
  }

  /** The last 30 s before a hard hang, one FlightLine per NDJSON line; null when no crash has been found at a start. */
  async flight(): Promise<FlightLine[] | null> {
    let body: string;
    try {
      body = await this.c.text(ROUTES.flight);
    } catch (e) {
      if (/answered 404/.test((e as Error).message)) return null;
      throw e;
    }
    const lines: FlightLine[] = [];
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        lines.push(JSON.parse(line) as FlightLine);
      } catch {
        /* the last line, cut short by the hang mid-flush */
      }
    }
    return lines;
  }
}

/**
 * IPC for the renderer (electron/preload.cjs `tune`). Run events are forwarded
 * only between subscribe and unsubscribe, and a renderer reload starts over
 * unsubscribed, so a hidden Tune page costs nothing (plan 17c).
 */
export function registerTuneIpc(ipc: IpcMain, collector: CollectorClient, send: (channel: string, payload: unknown) => void): void {
  const client = new TuneClient(collector);
  let wanted = false;
  ipc.handle('tune:state', () => client.state());
  ipc.handle('tune:enable', (_e, enabled: boolean, acknowledgedAt?: string) => client.enable(!!enabled, typeof acknowledgedAt === 'string' ? acknowledgedAt : undefined));
  ipc.handle('tune:start', (_e, kind: TuneRunKind, enabled: boolean) => client.start(kind === 'memory' ? 'memory' : 'core', !!enabled));
  ipc.handle('tune:validate', () => client.validate());
  ipc.handle('tune:stop', () => client.stop());
  ipc.handle('tune:keep', () => client.keep());
  ipc.handle('tune:revert', () => client.revert());
  ipc.handle('tune:export', () => client.export());
  ipc.handle('tune:flight', () => client.flight());
  ipc.on('tune:subscribe', () => (wanted = true));
  ipc.on('tune:unsubscribe', () => (wanted = false));
  collector.on('tune', (run: TuneRun) => {
    if (wanted) send('tune:run', run);
  });
}
