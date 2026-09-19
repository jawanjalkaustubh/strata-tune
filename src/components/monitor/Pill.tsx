import React from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

/**
 * The panel's whole colour vocabulary (plan 17a): emerald good, amber near a
 * limit, red at it, slate idle or absent. Written out in full so Tailwind's
 * scanner sees every class; `hex` is the same colour for SVG fills.
 */
export const TONE: Record<Tone, { text: string; fill: string; border: string; dim: string; hex: string }> = {
  ok: { text: 'text-emerald-400', fill: 'bg-emerald-500', border: 'border-emerald-500/40', dim: 'bg-emerald-500/10', hex: '#10b981' },
  warn: { text: 'text-amber-400', fill: 'bg-amber-400', border: 'border-amber-400/40', dim: 'bg-amber-400/10', hex: '#fbbf24' },
  bad: { text: 'text-rose-400', fill: 'bg-rose-500', border: 'border-rose-500/40', dim: 'bg-rose-500/10', hex: '#f43f5e' },
  idle: { text: 'text-slate-400', fill: 'bg-slate-500', border: 'border-slate-500/40', dim: 'bg-slate-500/10', hex: '#64748b' },
  info: { text: 'text-sky-400', fill: 'bg-sky-500', border: 'border-sky-500/40', dim: 'bg-sky-500/10', hex: '#0ea5e9' }
};

export const Pill: React.FC<{ tone: Tone; title?: string; className?: string; children: React.ReactNode }> = ({ tone, title, className = '', children }) => (
  <span title={title} className={`inline-flex items-center h-5 px-1.5 rounded border label ${TONE[tone].text} ${TONE[tone].border} ${TONE[tone].dim} ${className}`}>
    {children}
  </span>
);
