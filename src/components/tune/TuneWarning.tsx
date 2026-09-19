import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { emphasis, hardwareRiskSection } from './disclaimer';
import { WARNING_BODY, WARNING_LAPTOP_LINE, WARNING_RISK, WRITES_ROUTE_LINE } from './text';

interface Props {
  isOpen: boolean;
  onAccept(): void;
  onClose(): void;
  /** Plan 17d: on a gaming laptop the warning adds the one line about the vendor app's own OC mode. */
  laptop?: boolean;
}

const RISK = hardwareRiskSection();

/**
 * The Headroom warning (plan 27a, phase 8 follow-up 6b): short and plain — what happens,
 * that it stops at the first small mistake, that a one-to-two-second freeze on a driver
 * reset is the signal, that nothing changes voltage, power limits or fans and the card is
 * left as found, that the values go into the vendor's tool — then the one risk line, and
 * the sentence about what is actually written. The disclaimer's hardware-risk section stays
 * behind a collapsed link, verbatim from DISCLAIMER.md. Accept flips the setting and sends
 * the acknowledgement (date, app version, GPU name) to the collector's log; Escape cancels.
 */
export const TuneWarning: React.FC<Props> = ({ isOpen, onAccept, onClose, laptop = false }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-labelledby="tune-warning-title">
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col bg-studio-surface border border-amber-400/40 rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 h-12 border-b border-studio-border shrink-0">
          <AlertTriangle size={16} className="text-amber-400" />
          <h2 id="tune-warning-title" className="text-sm font-semibold text-studio-text flex-1">
            Headroom tests your graphics card
          </h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="p-5 space-y-3 text-mini text-studio-muted leading-relaxed overflow-y-auto">
          <p className="text-studio-text" data-testid="tune-warning-body">
            {WARNING_BODY}
          </p>
          <p className="text-amber-200" data-testid="tune-warning-risk">
            {WARNING_RISK}
          </p>
          <p data-testid="tune-warning-writes">{WRITES_ROUTE_LINE}</p>
          {laptop && <p data-testid="tune-warning-laptop">{WARNING_LAPTOP_LINE}</p>}
          <details className="border-t border-studio-border pt-2" data-testid="tune-warning-disclaimer">
            <summary className="label cursor-pointer select-none text-studio-subtle">Full text: the disclaimer's hardware-risk section</summary>
            <div className="space-y-2 pt-2">
              {RISK.map((block, i) =>
                block.kind === 'bullet' ? (
                  <p key={i} className="pl-4 relative before:content-['•'] before:absolute before:left-0">
                    <Emphasis text={block.text} />
                  </p>
                ) : (
                  <p key={i}>
                    <Emphasis text={block.text} />
                  </p>
                )
              )}
            </div>
          </details>
          <p className="text-micro text-studio-subtle">Turning Headroom on records this acknowledgement (date, app version, graphics card) in the tune log.</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 h-14 border-t border-studio-border bg-studio-panel/40 shrink-0">
          <button className="btn" onClick={onClose}>
            Not now
          </button>
          <button className="btn btn-accent" onClick={onAccept} autoFocus>
            I understand, turn Headroom on
          </button>
        </div>
      </div>
    </div>
  );
};

const Emphasis: React.FC<{ text: string }> = ({ text }) => (
  <>
    {emphasis(text).map((s, i) =>
      s.bold ? (
        <strong key={i} className="text-studio-text font-medium">
          {s.text}
        </strong>
      ) : (
        <React.Fragment key={i}>{s.text}</React.Fragment>
      )
    )}
  </>
);
