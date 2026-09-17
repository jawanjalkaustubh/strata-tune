import React from 'react';
import { Cpu, MemoryStick, ShieldCheck, Square } from 'lucide-react';
import type { CollectorState } from '../../api';
import type { TuneRun, TuneStatus } from '../../collector-types';
import { statusLabel } from '../useCollectorStatus';
import type { TuneAction } from './useTune';
import { revertable } from './wire';

export interface Gates {
  find: string | null;
  validate: string | null;
  stop: string | null;
  keep: string | null;
  revert: string | null;
}

/**
 * Why each control is disabled, in the words the user needs (plan 17). Only what this
 * side can know for certain is gated here: the collector's own refusals (gpu.lock held,
 * an Ollama model resident, a vendor tool running — plan 20) come back from the start
 * itself and are shown beside the buttons, which stay enabled so the user can retry
 * once the cause is gone.
 */
export function gates(inElectron: boolean, collector: CollectorState, status: TuneStatus | null, run: TuneRun | null): Gates {
  const dead = !inElectron ? 'Not running inside Electron' : collector.status !== 'connected' ? `Collector: ${statusLabel(collector)}` : null;
  if (dead) return { find: dead, validate: dead, stop: dead, keep: dead, revert: dead };
  if (!status) {
    const waiting = 'Waiting for the Tune state';
    return { find: waiting, validate: waiting, stop: waiting, keep: waiting, revert: waiting };
  }
  if (run?.state === 'running') return { find: 'A test is running', validate: 'A test is running', stop: null, keep: 'A test is running', revert: null };
  const applied = status.state === 'VALIDATING' ? 'A kept result is on the card: revert it, or reboot once so a clean boot promotes it' : status.state === 'PENDING' ? 'A candidate is still applied: revert it first' : status.problem ? `Tune is refusing to act: ${status.problem}` : null;
  const result = status.result;
  return {
    find: applied,
    validate: applied ?? (result ? (result.validated ? 'This result is already validated' : null) : 'Nothing to validate yet: find a headroom first'),
    stop: 'No test is running',
    keep: applied ?? (result ? (result.validated ? null : 'Validate the result first') : 'Nothing to keep yet'),
    revert: revertable(status) ? null : "Nothing of Tune's is on the card"
  };
}

interface Props {
  gates: Gates;
  busy: TuneAction | null;
  /** The collector's last refusal, shown once beside the buttons. */
  refusal: string | null;
  onFind(kind: 'core' | 'memory'): void;
  onValidate(): void;
  onStop(): void;
}

const Button: React.FC<{ icon: React.ReactNode; label: string; reason: string | null; busy: boolean; accent?: boolean; danger?: boolean; onClick(): void }> = ({ icon, label, reason, busy, accent, danger, onClick }) => (
  <button
    className={`btn ${accent ? 'btn-accent' : ''} ${danger ? 'text-rose-300 hover:bg-rose-500/15 hover:text-rose-200' : ''}`}
    disabled={reason !== null || busy}
    title={reason ?? label}
    aria-label={reason ? `${label}: ${reason}` : label}
    onClick={onClick}
  >
    {icon} {busy ? `${label}…` : label}
  </button>
);

/** The four controls (plan 16); the refusal or the first disabled reason is written out once beneath them, the rest sit in the tooltips. */
export const Controls: React.FC<Props> = ({ gates: g, busy, refusal, onFind, onValidate, onStop }) => {
  const reason = refusal ?? g.find ?? g.validate ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Button icon={<Cpu size={13} />} label="Find core headroom" reason={g.find} busy={busy === 'core'} accent={g.find === null} onClick={() => onFind('core')} />
      <Button icon={<MemoryStick size={13} />} label="Find memory headroom" reason={g.find} busy={busy === 'memory'} accent={g.find === null} onClick={() => onFind('memory')} />
      <Button icon={<ShieldCheck size={13} />} label="Validate result" reason={g.validate} busy={busy === 'validate'} onClick={onValidate} />
      <Button icon={<Square size={13} />} label="Stop" reason={g.stop} busy={busy === 'stop'} danger onClick={onStop} />
      {reason && g.stop !== null && (
        <span className={`text-mini basis-full min-w-0 ${refusal ? 'text-amber-300' : 'text-studio-muted'}`} title={reason}>
          {reason}
        </span>
      )}
    </div>
  );
};
