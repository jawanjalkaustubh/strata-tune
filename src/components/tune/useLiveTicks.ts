import { useEffect, useRef, useState } from 'react';
import { api, ipcErrorMessage } from '../../api';
import type { StaticSnapshot, Tick } from '../../collector-types';
import { SensorIndex } from '../monitor/sensors';
import { Ring } from '../monitor/history';
import { cachedSensorMeta, cachedSnapshot, refreshSensorMeta } from '../monitor/cache';

export interface LiveTicks {
  index: SensorIndex | null;
  snapshot: StaticSnapshot | null;
  tick: Tick | null;
  ring: Ring;
  error: string;
}

/**
 * The 2 Hz feed for the Tune page's live monitor: the same subscription the Monitor
 * page holds, taken only while this page is mounted and released on unmount (plan 17c).
 * The sensor list is re-fetched while the collector is still warming, as on the
 * Monitor page, so a card whose group opened late still gets its temps and fans.
 */
export function useLiveTicks(connected: boolean): LiveTicks {
  const [index, setIndex] = useState<SensorIndex | null>(null);
  const [snapshot, setSnapshot] = useState<StaticSnapshot | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  const [error, setError] = useState('');
  const ring = useRef(new Ring()).current;

  useEffect(() => {
    if (!api || !connected) return;
    const c = api.collector;
    let live = true;
    let fetches = 0;
    const fetchMeta = (again: boolean) => {
      const seq = ++fetches;
      (again ? refreshSensorMeta() : cachedSensorMeta())
        .then((m) => live && seq === fetches && setIndex(new SensorIndex(m)))
        .catch((e) => live && setError(ipcErrorMessage(e)));
    };
    fetchMeta(false);
    cachedSnapshot()
      .then((s) => live && setSnapshot(s))
      .catch(() => {
        /* the DIMM count and CPU name only; the bars read the ticks */
      });
    c.subscribe();
    let widest = -1;
    let warmed = false;
    const off = c.onTick((t) => {
      ring.push(t);
      if (!live) return;
      setTick(t);
      if (warmed) return;
      const width = Object.keys(t.sensors).length;
      if (t.warming && width <= widest) return;
      warmed = !t.warming;
      widest = width;
      fetchMeta(true);
    });
    return () => {
      live = false;
      off();
      c.unsubscribe();
    };
  }, [connected, ring]);

  return { index, snapshot, tick, ring, error };
}
