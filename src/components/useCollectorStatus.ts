import { useEffect, useState } from 'react';
import { api, type CollectorState } from '../api';

const OUTSIDE_ELECTRON: CollectorState = { status: 'idle', message: 'Not running inside Electron' };

/** The main process owns the collector; every page reads the same state through this hook. */
export function useCollectorStatus(): CollectorState {
  const [state, setState] = useState<CollectorState>(api ? { status: 'starting', message: 'Starting…' } : OUTSIDE_ELECTRON);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.collector
      .status()
      .then((s) => live && setState(s))
      .catch(() => {
        /* the push channel below catches up */
      });
    const off = api.collector.onStatus(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** Short text for pills and the bottom bar; the full message is the tooltip. */
export function statusLabel(s: CollectorState): string {
  switch (s.status) {
    case 'idle':
      return 'Collector not started';
    case 'starting':
      return 'Starting…';
    case 'elevating':
      return 'Waiting for permission (UAC)';
    case 'connected':
      return 'Connected';
    case 'declined':
      return 'Permission declined';
    case 'error':
      return 'Error';
    case 'stopped':
      return 'Collector stopped';
  }
}
