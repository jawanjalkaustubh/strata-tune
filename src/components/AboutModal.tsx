import React, { useEffect } from 'react';
import { X, MonitorOff, ShieldCheck, Gauge, Heart, Bug, ExternalLink } from 'lucide-react';
import { SupportLinks, openExternal } from '../support';
import { Monogram } from './Monogram';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  version: string;
  support: SupportLinks;
}

/** Same layout and wording as the About dialogs in Strata Code, Photo and Video. */
export const AboutModal: React.FC<Props> = ({ isOpen, onClose, version, support }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 select-none" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-md bg-studio-surface border border-studio-border rounded-lg shadow-2xl overflow-hidden">
        <div className="h-32 bg-gradient-to-br from-emerald-950/60 via-teal-950/30 to-studio-surface relative flex items-center justify-center border-b border-studio-border">
          <button onClick={onClose} className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-studio-panel text-slate-400 hover:text-slate-200 transition">
            <X size={16} />
          </button>
          <div className="flex flex-col items-center">
            <Monogram size={56} className="mb-1.5 drop-shadow-[0_0_16px_rgba(16,185,129,0.55)]" glow={false} />
            <h2 className="text-lg font-extrabold tracking-wider bg-gradient-to-r from-emerald-200 via-teal-200 to-white bg-clip-text text-transparent">STRATA TUNE</h2>
            <span className="text-micro text-emerald-300/80 font-mono tracking-wide">v{version || '0.0.1'} • PC tuning and diagnostics</span>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="p-3 rounded-lg bg-gradient-to-r from-emerald-950/50 via-slate-900 to-teal-950/50 border border-emerald-500/30 flex items-center space-x-3 shadow-inner">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300">
              <Gauge size={19} />
            </div>
            <div>
              <div className="text-micro uppercase font-semibold tracking-wider text-emerald-400">Created By</div>
              <div className="text-sm font-bold text-slate-100 tracking-wide">Kaustubh Jawanjal</div>
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between p-2 rounded-lg bg-studio-panel/50 border border-studio-border">
              <div className="flex items-center space-x-2 text-slate-300">
                <MonitorOff size={14} className="text-state-info-400" />
                <span>Rendering</span>
              </div>
              <span className="font-mono text-slate-200 font-medium" title="The app never competes with a GPU under test">CPU only, GPU acceleration off</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-studio-panel/50 border border-studio-border">
              <div className="flex items-center space-x-2 text-slate-300">
                <ShieldCheck size={14} className="text-emerald-400" />
                <span>Privacy</span>
              </div>
              <span className="text-state-ok-400 font-semibold">No telemetry, no accounts, no cloud</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-studio-panel/50 border border-studio-border space-y-2">
            {support.donateUrl && (
              <button
                onClick={() => openExternal(support.donateUrl)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-control bg-state-danger-500/15 border border-state-danger-500/40 text-state-danger-200 hover:bg-state-danger-500/25 text-xs font-medium transition"
                title={support.donateUrl}
              >
                <Heart size={14} className="text-state-danger-400" />
                <span>{support.donateLabel}</span>
              </button>
            )}
            <div className="text-micro text-slate-400 text-center">Strata Tune is free. Donations are voluntary and fund new features and apps; they buy nothing and are not required.</div>
            {(support.projectUrl || support.issuesUrl) && (
              <div className="flex items-center justify-center gap-4 text-micro">
                {support.projectUrl && (
                  <button onClick={() => openExternal(support.projectUrl)} className="flex items-center gap-1 text-slate-300 hover:text-white" title={support.projectUrl}>
                    <ExternalLink size={12} /> Project page
                  </button>
                )}
                {support.issuesUrl && (
                  <button onClick={() => openExternal(support.issuesUrl)} className="flex items-center gap-1 text-slate-300 hover:text-white" title={support.issuesUrl}>
                    <Bug size={12} /> Report an issue
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="text-micro text-slate-500 text-center">Part of the Strata family with Strata Code, Strata Photo, Strata Video and StrataSnap. Runs entirely on your own hardware.</div>
        </div>
      </div>
    </div>
  );
};
