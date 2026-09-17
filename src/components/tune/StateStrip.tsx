import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { TuneStatus } from '../../collector-types';
import { Pill } from '../monitor/Pill';
import { pair, STAGE_TEXT, STAGE_TONE, toolIn, type Offsets } from './wire';

const OffsetPair: React.FC<{ label: string; offsets: Offsets; delta?: Offsets | null; tag?: string }> = ({ label, offsets, delta, tag }) => (
  <span className="inline-flex flex-wrap items-baseline gap-x-2 min-w-0">
    <span className="label">{label}</span>
    <span className="figure text-[12px] text-studio-text whitespace-nowrap">{pair(offsets)}</span>
    {delta && (delta.coreMhz !== 0 || delta.memMhz !== 0) && (
      <span className="figure text-[11px] text-studio-muted whitespace-nowrap" title="Change against the baseline">
        (Δ {delta.coreMhz >= 0 ? '+' : '−'}
        {Math.abs(delta.coreMhz)} / {delta.memMhz >= 0 ? '+' : '−'}
        {Math.abs(delta.memMhz)})
      </span>
    )}
    {tag && <span className="text-micro text-studio-subtle whitespace-nowrap">{tag}</span>}
  </span>
);

interface Props {
  status: TuneStatus | null;
  /** Why there is nothing to show yet (no collector, no answer). */
  reason: string | null;
  /** The collector's last refusal; a vendor OC tool named in it becomes the warning. */
  refusal: string | null;
}

/**
 * The rollback state machine as one line (plan 16): IDLE, PENDING or REVERTED, the
 * baseline every restore puts back (the driver's P0 deltas, or the user's vendor tune
 * written through our route), the rung on the card now, the values a crash revert undid.
 * Absent facts collapse; nothing here animates.
 */
export const StateStrip: React.FC<Props> = ({ status, reason, refusal }) => {
  if (!status) {
    return (
      <div className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 flex flex-wrap items-center gap-3 min-w-0">
        <Pill tone="idle">No state</Pill>
        <span className="text-mini text-studio-muted min-w-0">{reason ?? 'Waiting for the collector'}</span>
      </div>
    );
  }
  const delta = status.candidate && status.baseline ? { coreMhz: status.candidate.coreMhz - status.baseline.coreMhz, memMhz: status.candidate.memMhz - status.baseline.memMhz } : null;
  const tool = toolIn(refusal);
  const vendor = status.result?.vendor && status.baseline && (status.baseline.coreMhz !== 0 || status.baseline.memMhz !== 0);
  const baselineTag = status.baseline ? (vendor ? 'your vendor tune through our route' : status.nvapi.deltas ? 'read from the driver' : 'from the state file') : undefined;
  return (
    <div className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 min-w-0">
      <Pill tone={STAGE_TONE[status.state]} title={STAGE_TEXT[status.state]} className="normal-case tracking-normal">
        {status.state}
      </Pill>
      {status.baseline ? (
        <OffsetPair label="Baseline" offsets={status.baseline} tag={baselineTag} />
      ) : (
        <span className="text-mini text-studio-muted min-w-0" title={status.nvapi.reason ?? undefined}>
          {status.nvapi.available ? 'Baseline not read yet: the first hunt reads it from the driver' : `NVAPI unavailable${status.nvapi.reason ? `: ${status.nvapi.reason}` : ''}`}
        </span>
      )}
      {status.candidate && <OffsetPair label="On the card" offsets={status.candidate} delta={delta} />}
      {status.reverted && <OffsetPair label="Reverted from" offsets={status.reverted.candidate} />}
      <span className="flex-1" />
      {tool && (
        <span className="inline-flex items-center gap-1.5 text-mini text-amber-300 min-w-0" title={refusal ?? undefined}>
          <AlertTriangle size={13} className="shrink-0" /> {tool} is changing clocks under the test
        </span>
      )}
    </div>
  );
};
