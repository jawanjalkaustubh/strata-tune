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
import type { TuneCaps } from '../src/api';
import type { FlightLine, PstateDeltas, TuneEnableRequest, TuneExport, TuneRun, TuneRunKind, TuneStartRequest, TuneStatus } from '../src/collector-types';

/** Every route in one place, so a rename on the collector side is a one-line change. */
const ROUTES = {
  state: '/tune/state',
  enable: '/tune/enable',
  start: '/tune/start',
  stop: '/tune/stop',
  revert: '/tune/revert',
  release: '/tune/release',
  export: '/tune/export',
  flight: '/tune/flight'
};

/** A write is acknowledged, not completed, inside this: a start answers once the worker is up, a revert once the driver has applied the baseline. */
const WRITE_TIMEOUT_MS = 30_000;

/**
 * STRATA_TUNE_MAX_CANDIDATES=n caps each ladder at n rungs: the bounded smoke test of the
 * hunt on a live card (the collector's TuneStartRequest.maxCandidates). Unset in ordinary
 * use, so each ladder climbs to its first failure.
 */
function maxCandidates(): number | undefined {
  const n = Number.parseInt(process.env.STRATA_TUNE_MAX_CANDIDATES ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A "never test above" clock is kept only as a positive integer MHz; anything else is no cap. */
function capValue(cap: unknown): number | undefined {
  return Number.isInteger(cap) && (cap as number) > 0 ? (cap as number) : undefined;
}

/** The renderer's vendor value, kept only when both numbers are finite integers (the collector halves the memory rate). */
function vendorValue(vendor: unknown): PstateDeltas | undefined {
  if (!vendor || typeof vendor !== 'object') return undefined;
  const { coreMhz, memMhz } = vendor as Partial<PstateDeltas>;
  return Number.isInteger(coreMhz) && Number.isInteger(memMhz) ? { coreMhz: coreMhz as number, memMhz: memMhz as number } : undefined;
}

export class TuneClient {
  constructor(private readonly c: CollectorClient) {}

  state(): Promise<TuneStatus> {
    return this.c.get<TuneStatus>(ROUTES.state);
  }

  /**
   * On: the collector records the warning's acknowledgement (date from the click, this app's
   * version; it adds the GPU name); off: it takes anything of Tune's off the card first.
   */
  enable(enabled: boolean, acknowledgedAt?: string): Promise<TuneStatus> {
    const request: TuneEnableRequest = enabled ? { enabled, acknowledgedAt, appVersion: app.getVersion() } : { enabled };
    return this.c.post<TuneStatus>(ROUTES.enable, request, WRITE_TIMEOUT_MS);
  }

  /**
   * `enabled` is the renderer's own setting, checked beside the state file's flag so neither
   * side can start a hunt alone. 'hunt' is the memory ladder then the core ladder, each from
   * the card as found; 'core' and 'memory' run one ladder alone.
   */
  start(kind: TuneRunKind, enabled: boolean, vendor?: PstateDeltas, caps?: TuneCaps): Promise<TuneStatus> {
    const request: TuneStartRequest = { kind, enabled, maxCandidates: maxCandidates(), vendor, coreCapMhz: capValue(caps?.coreCapMhz), memCapMhz: capValue(caps?.memCapMhz) };
    return this.c.post<TuneStatus>(ROUTES.start, request, WRITE_TIMEOUT_MS);
  }

  stop(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.stop, {}, WRITE_TIMEOUT_MS);
  }

  /** Takes anything of Tune's off the card now, or acknowledges a crash revert. */
  revert(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.revert, {}, WRITE_TIMEOUT_MS);
  }

  /** Writes our 0 / 0 so the vendor tool's next Apply owns the card (nothing running). */
  release(): Promise<TuneStatus> {
    return this.c.post<TuneStatus>(ROUTES.release, {}, WRITE_TIMEOUT_MS);
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
  ipc.handle('tune:start', (_e, kind: TuneRunKind, enabled: boolean, vendor?: PstateDeltas, caps?: TuneCaps) =>
    client.start(kind === 'memory' || kind === 'core' ? kind : 'hunt', !!enabled, vendorValue(vendor), caps && typeof caps === 'object' ? caps : undefined));
  ipc.handle('tune:stop', () => client.stop());
  ipc.handle('tune:revert', () => client.revert());
  ipc.handle('tune:release', () => client.release());
  ipc.handle('tune:export', () => client.export());
  ipc.handle('tune:flight', () => client.flight());
  ipc.on('tune:subscribe', () => (wanted = true));
  ipc.on('tune:unsubscribe', () => (wanted = false));
  collector.on('tune', (run: TuneRun) => {
    if (wanted) send('tune:run', run);
  });
}
