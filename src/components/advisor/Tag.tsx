import React from 'react';

/**
 * Every number on the page says where it came from (plan sections 10 and 13).
 * `derived` is a dense figure halved from the vendor's sparse headline, not one
 * the vendor printed.
 */
export type Provenance = 'spec' | 'measured' | 'estimated' | 'default' | 'derived';

/** Slate for everything but a measurement (plan 17a: one accent), which is the outlined emerald chip. */
const TONE: Record<Provenance, string> = {
  spec: 'text-slate-400 border-slate-500/40',
  measured: 'text-emerald-400 border-emerald-500/60',
  estimated: 'text-slate-400 border-slate-500/40',
  default: 'text-slate-400 border-slate-500/40 border-dashed',
  derived: 'text-slate-400 border-slate-500/40 border-dashed'
};

const CHIP = 'inline-flex items-center h-4 px-1 rounded border text-[9px] uppercase tracking-[0.08em] leading-none whitespace-nowrap';

export const Tag: React.FC<{ kind: Provenance; title?: string }> = ({ kind, title }) => (
  <span title={title} className={`${CHIP} ${TONE[kind]}`}>
    {kind}
  </span>
);

/** Beside a tok/s that already includes accepted draft tokens: the figure is per token emitted, not per forward pass (models.json mtpAcceptedTokens). */
export const MtpTag: React.FC<{ accepted: number }> = ({ accepted }) => (
  <span
    title={`Multi-token prediction: Ollama 0.34 or newer runs the model's MTP head as a speculative draft, so the estimate is the forward-pass rate × ${accepted} accepted tokens per pass. Assumes the model fully in VRAM; the real length varies with the text.`}
    className={`${CHIP} text-slate-400 border-slate-500/40`}
  >
    with MTP
  </span>
);

/** Beside a MoE row's tok/s: the bandwidth bound on its active experts, which the dense-model factor has not been checked against. */
export const MoeTag: React.FC = () => (
  <span
    title="Mixture of experts: paced by the active experts alone. The calibration factor was measured on a dense model; MoE decode runs many small kernels per token and lands below this, by an amount not yet measured here."
    className={`${CHIP} text-slate-400 border-slate-500/40 border-dashed`}
  >
    MoE ceiling
  </span>
);

interface StatProps {
  label: string;
  value: string;
  unit?: string;
  kind?: Provenance;
  /** Smaller line under the figure: the sparse figure, the gap to spec, the device measured on. */
  note?: React.ReactNode;
  muted?: boolean;
}

/** One labelled figure: label, tabular number, provenance tag. */
export const Stat: React.FC<StatProps> = ({ label, value, unit, kind, note, muted }) => (
  <div className="min-w-0">
    <div className="label truncate">{label}</div>
    <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
      <span className={`figure text-[15px] leading-6 ${muted ? 'text-studio-muted' : 'text-studio-text'}`}>{value}</span>
      {unit && <span className="text-[10px] text-studio-subtle">{unit}</span>}
      {kind && <Tag kind={kind} />}
    </div>
    {note && <div className="text-[10px] text-studio-subtle leading-4">{note}</div>}
  </div>
);
