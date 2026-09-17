import React, { useEffect, useRef, useState } from 'react';
import { Minus, Square, X, HelpCircle, Heart, Info, Settings2 } from 'lucide-react';
import { api } from '../api';
import { SupportLinks, openExternal } from '../support';
import { Monogram } from './Monogram';

export interface TitleBarProps {
  support: SupportLinks;
  onOpenAbout: () => void;
  /** Help → Settings: the Tune switch behind its warning (plan 17). */
  onOpenSettings: () => void;
}

/**
 * Help menu: About, and the donate entry only once support.json has a URL.
 * Strata Video shows a "soon" placeholder instead; Tune is a public repo, so
 * an entry that goes nowhere would only draw issues.
 */
const HelpMenu: React.FC<TitleBarProps> = ({ support, onOpenAbout, onOpenSettings }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative" ref={ref}>
      <button className={`btn ${open ? 'bg-studio-panel-hi text-studio-text' : ''}`} onClick={() => setOpen((o) => !o)} title="Help">
        <HelpCircle size={14} /> Help
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-50 w-64 rounded-control border border-studio-border bg-studio-panel shadow-xl py-1">
          {support.donateUrl && (
            <button
              className="w-full flex items-center justify-between px-3 py-1.5 text-mini text-studio-text hover:bg-studio-panel-hi"
              onClick={() => run(() => openExternal(support.donateUrl))}
              title={support.donateUrl}
            >
              <span className="flex items-center gap-2">
                <Heart size={13} className="text-state-danger-400" /> {support.donateLabel} (donate)
              </span>
              <span className="text-micro text-studio-accent font-semibold">Free</span>
            </button>
          )}
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-mini text-studio-text hover:bg-studio-panel-hi" onClick={() => run(onOpenSettings)}>
            <Settings2 size={13} /> Settings
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-mini text-studio-text hover:bg-studio-panel-hi" onClick={() => run(onOpenAbout)}>
            <Info size={13} /> About Strata Tune
          </button>
          <div className="my-1 h-px bg-studio-border" />
          <div className="px-3 py-1 flex items-center gap-1.5">
            <span className="text-[10px] uppercase font-semibold text-studio-accent">Created by</span>
            <span className="text-[11px] font-bold text-white">Kaustubh Jawanjal</span>
          </div>
          <div className="px-3 py-0.5 text-studio-subtle text-[10px]">Free, no telemetry, no accounts. Runs on your own PC.</div>
        </div>
      )}
    </div>
  );
};

const TitleBarInner: React.FC<TitleBarProps> = (p) => (
  <div className="custom-titlebar h-10 flex items-center bg-studio-surface border-b border-studio-border px-2 gap-1 shrink-0">
    {/* Wordmark only; the author credit lives in About (and the Help menu footer), not here. */}
    <div className="no-drag flex items-center gap-2 pr-3 mr-1 border-r border-studio-border cursor-pointer hover:opacity-90" onClick={p.onOpenAbout} title="About Strata Tune">
      <Monogram size={20} />
      <span className="text-mini font-bold tracking-[0.12em] text-white">STRATA TUNE</span>
    </div>

    <div className="no-drag flex items-center gap-0.5">
      <HelpMenu {...p} />
    </div>

    <div className="flex-1" />

    <div className="no-drag flex items-center gap-1">
      <button className="btn-icon" onClick={() => api?.minimize()} title="Minimize">
        <Minus size={14} />
      </button>
      <button className="btn-icon" onClick={() => api?.maximize()} title="Maximize / restore">
        <Square size={12} />
      </button>
      <button className="btn-icon hover:bg-state-danger-600 hover:text-white" onClick={() => api?.close()} title="Close">
        <X size={14} />
      </button>
    </div>
  </div>
);

export const TitleBar = React.memo(TitleBarInner);
