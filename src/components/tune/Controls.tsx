import React from 'react';
import { Cpu, MemoryStick, Search, Square } from 'lucide-react';
import type { CollectorState } from '../../api';
import type { TuneRun, TuneRunKind, TuneStatus } from '../../collector-types';
import { statusLabel } from '../useCollectorStatus';
import type { TuneAction } from './useTune';
import { revertable } from './wire';

export interface Gates {
  find: string | null;
  stop: string | null;
  revert: string | null;
}

/**
 * Why each control is disabled, in the words the user needs (plan 17). Only what this
 * side can know for certain is gated here: the collector's own refusals (gpu.lock held,
 * an Ollama model resident, a foreign tune with no vendor value — plan 16, 20) come back
 * from the start itself and are shown beside the buttons, which stay enabled so the user
 * can retry once the cause is gone.
 */
export function gates(inElectron: boolean, collector: CollectorState, status: TuneStatus | null, run: TuneRun | null): Gates {
  const dead = !inElectron ? 'Not running inside Electron' : collector.status !== 'connected' ? `Collector: ${statusLabel(collector)}` : null;
  if (dead) return { find: dead, stop: dead, revert: dead };
  if (!status) {
    const waiting = 'Waiting for the Tune state';
    return { find: waiting, stop: waiting, revert: waiting };
  }
  // Revert mid-run would write the baseline under the rung being tested; Stop is the way out of a run.
  if (run?.state === 'running') return { find: 'A hunt is running', stop: null, revert: 'A hunt is running: Stop it first' };
  const blocked = !status.nvapi.available
    ? (status.nvapi.reason ?? 'NVAPI is unavailable on this card')
    : status.state === 'PENDING'
      ? 'A rung is still on the card: revert it first'
      : status.problem
        ? `Tune is refusing to act: ${status.problem}`
        : null;
  return {
    find: blocked,
    stop: 'No hunt is running',
    revert: revertable(status) ? null : "Nothing of Tune's is on the card"
  };
}

interface Props {
  gates: Gates;
  busy: TuneAction | null;
  /** The collector's last refusal, shown once beside the buttons. */
  refusal: string | null;
  /** "about 16 minutes": the collector's estimate for a full hunt. */
  estimateMinutes: number | null;
  onFind(kind: TuneRunKind): void;
  onStop(): void;
}

const Button: React.FC<{ icon: React.ReactNode; label: string; reason: string | null; busy: boolean; accent?: boolean; danger?: boolean; title?: string; onClick(): void }> = ({ icon, label, reason, busy, accent, danger, title, onClick }) => (
  <button
    className={`btn ${accent ? 'btn-accent' : ''} ${danger ? 'text-rose-300 hover:bg-rose-500/15 hover:text-rose-200' : ''}`}
    disabled={reason !== null || busy}
    title={reason ?? title ?? label}
    aria-label={reason ? `${label}: ${reason}` : label}
    onClick={onClick}
  >
    {icon} {busy ? `${label}…` : label}
  </button>
);

/**
 * The controls (plan 16): the hunt (memory ladder, then core, from the card as found), each
 * ladder alone, and Stop. The refusal or the disabled reason is written out once beneath
 * them as plain text, never clipped (plan 17a).
 */
export const Controls: React.FC<Props> = ({ gates: g, busy, refusal, estimateMinutes, onFind, onStop }) => {
  const reason = refusal ?? g.find ?? null;
  const estimate = estimateMinutes ? ` (about ${estimateMinutes} min)` : '';
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Button icon={<Search size={13} />} label={`Find headroom${estimate}`} reason={g.find} busy={busy === 'hunt'} accent={g.find === null} title="Memory ladder first, then core, each from the card as found; the certified pair gets the two-minute scored run" onClick={() => onFind('hunt')} />
      <Button icon={<MemoryStick size={13} />} label="Memory only" reason={g.find} busy={busy === 'memory'} onClick={() => onFind('memory')} />
      <Button icon={<Cpu size={13} />} label="Core only" reason={g.find} busy={busy === 'core'} onClick={() => onFind('core')} />
      <Button icon={<Square size={13} />} label="Stop" reason={g.stop} busy={busy === 'stop'} danger title="Kills the worker and puts the baseline back" onClick={onStop} />
      {reason && g.stop !== null && <span className={`text-mini basis-full min-w-0 whitespace-normal break-words ${refusal ? 'text-amber-300' : 'text-studio-muted'}`}>{reason}</span>}
    </div>
  );
};
