import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type CollectorState } from '../api';
import { Pill, type Tone } from './monitor/Pill';
import { statusLabel } from './useCollectorStatus';

const TONE_OF: Record<CollectorState['status'], Tone> = {
  idle: 'idle',
  starting: 'info',
  elevating: 'warn',
  connected: 'ok',
  declined: 'bad',
  error: 'bad',
  stopped: 'idle'
};

/** Status pill shared by the page headers; Retry re-runs the elevation after a decline or a loss. */
export const CollectorStatusPill: React.FC<{ state: CollectorState }> = ({ state }) => {
  const [busy, setBusy] = useState(false);
  const canRetry = !!api && (state.status === 'declined' || state.status === 'error' || state.status === 'stopped');
  const retry = () => {
    if (!api) return;
    setBusy(true);
    api.collector
      .start()
      .catch(() => {
        /* the status channel carries the outcome */
      })
      .finally(() => setBusy(false));
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Pill tone={TONE_OF[state.status]} title={state.message}>
        {statusLabel(state)}
      </Pill>
      {canRetry && (
        <button className="btn h-6" onClick={retry} disabled={busy}>
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </span>
  );
};
