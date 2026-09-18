import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ipcErrorMessage } from '../../api';
import type { FlightLine, PstateDeltas, TuneExport, TuneRun, TuneRunKind, TuneStatus } from '../../collector-types';
import type { TuneCaps } from '../../api';
import { refusalOf } from './wire';

export type TuneAction = TuneRunKind | 'stop' | 'revert' | 'release';

export interface TuneHook {
  /** null until the collector has answered GET /tune/state. */
  status: TuneStatus | null;
  /** The live run: from the status, then from the 2 Hz `tune` events while one goes. */
  run: TuneRun | null;
  export: TuneExport | null;
  flight: FlightLine[] | null;
  /** The action in flight, so its button reads busy and the rest wait. */
  busy: TuneAction | null;
  /** The collector's reason for refusing the last action, in its words; cleared by the next success. */
  refusal: string | null;
  /** A transport failure (the collector gone, a route missing), distinct from a refusal. */
  error: string;
  refresh(): void;
  /** `vendor` is what the user's vendor tool shows (slider units), needed when a tune of the tool's is on the card; `caps` the user's "never test above" clocks (plan section 16). */
  start(kind: TuneRunKind, enabled: boolean, vendor?: PstateDeltas, caps?: TuneCaps): Promise<void>;
  stop(): Promise<void>;
  revert(): Promise<void>;
  release(): Promise<void>;
}

/** The collector says no with a 409 whose body names why; anything else is a transport failure. */
const isRefusal = (message: string) => /answered 4\d\d/.test(message);

/**
 * The collector owns the state machine (plan 16); this is its mirror in the renderer:
 * one GET to seed, the pushed run events while the page is mounted, and every POST's
 * reply (the whole status) taken as the new truth. The export is read beside the
 * status and again whenever a run ends, since that is when it changes.
 */
export function useTune(connected: boolean): TuneHook {
  const [status, setStatus] = useState<TuneStatus | null>(null);
  const [run, setRun] = useState<TuneRun | null>(null);
  const [exp, setExport] = useState<TuneExport | null>(null);
  const [flight, setFlight] = useState<FlightLine[] | null>(null);
  const [busy, setBusy] = useState<TuneAction | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState('');
  const live = useRef(true);

  const take = useCallback((s: TuneStatus) => {
    setStatus(s);
    setRun(s.run);
  }, []);

  const refresh = useCallback(() => {
    if (!api || !connected) return;
    const t = api.tune;
    Promise.all([t.state(), t.export()])
      .then(([s, e]) => {
        if (!live.current) return;
        take(s);
        setExport(e);
        setError('');
      })
      .catch((e) => live.current && setError(ipcErrorMessage(e)));
  }, [connected, take]);

  useEffect(() => {
    live.current = true;
    if (!api || !connected) {
      setStatus(null);
      setRun(null);
      setExport(null);
      setFlight(null);
      return;
    }
    const t = api.tune;
    refresh();
    t.subscribe();
    let lastState: TuneRun['state'] | null = null;
    let lastCandidate = '';
    const off = t.onRun((r) => {
      if (!live.current) return;
      setRun(r);
      // A run that just ended changed the state file and maybe the result, and a new candidate
      // put the file at PENDING with it: the status (the state strip) is read again at both.
      const candidate = r.candidate ? `${r.candidate.coreKhz}/${r.candidate.memKhz}` : '';
      if ((lastState === 'running' && r.state !== 'running') || (r.state === 'running' && candidate !== lastCandidate)) refresh();
      lastState = r.state;
      lastCandidate = candidate;
    });
    return () => {
      live.current = false;
      off();
      t.unsubscribe();
    };
  }, [connected, refresh]);

  // After a start-after-crash the status says which values did it; the recorder has the seconds before.
  const wantFlight = !!status?.reverted && status.flightAvailable;
  useEffect(() => {
    if (!api || !connected || !wantFlight) {
      setFlight(null);
      return;
    }
    api.tune
      .flight()
      .then((f) => live.current && setFlight(f))
      .catch(() => live.current && setFlight(null));
  }, [connected, wantFlight]);

  const act = useCallback(
    async (name: TuneAction, call: () => Promise<TuneStatus>) => {
      if (!api) return;
      setBusy(name);
      setError('');
      try {
        const s = await call();
        if (!live.current) return;
        take(s);
        setRefusal(null);
        refresh();
      } catch (e) {
        if (!live.current) return;
        const message = ipcErrorMessage(e);
        if (isRefusal(message)) setRefusal(refusalOf(message));
        else setError(message);
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [refresh, take]
  );

  return {
    status,
    run,
    export: exp,
    flight,
    busy,
    refusal,
    error,
    refresh,
    start: (kind, enabled, vendor, caps) => act(kind, () => api!.tune.start(kind, enabled, vendor, caps)),
    stop: () => act('stop', () => api!.tune.stop()),
    revert: () => act('revert', () => api!.tune.revert()),
    release: () => act('release', () => api!.tune.release())
  };
}
