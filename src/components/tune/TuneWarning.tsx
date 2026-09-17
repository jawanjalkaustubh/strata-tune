import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { emphasis, hardwareRiskSection } from './disclaimer';

interface Props {
  isOpen: boolean;
  onAccept(): void;
  onClose(): void;
}

const RISK = hardwareRiskSection();

/**
 * The warning that stands in front of the Tune page (plan 17, 27a), in plain words: what it
 * does, what can happen, what to do first, that nothing is applied for good until the
 * user says so, then the disclaimer's own hardware-risk section verbatim and the one
 * sentence the user is agreeing to. Accept is what flips the setting and sends the
 * acknowledgement to the collector's log; Escape or the backdrop cancels.
 */
export const TuneWarning: React.FC<Props> = ({ isOpen, onAccept, onClose }) => {
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
            Tune writes to your graphics card
          </h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="p-5 space-y-4 text-mini text-studio-muted leading-relaxed overflow-y-auto">
          <Section title="What it does">
            It raises the card's core or memory clock offset one small step at a time, checking each step with a fixed workload whose result it already knows, until the card makes its first
            small mistake. Then it backs off to the last step that held. Memory is judged by measured bandwidth: GDDR7 corrects its own errors silently and simply gets slower.
          </Section>
          <Section title="What can happen">
            A step too far can reset the graphics driver: the screen goes black for about five seconds and comes back. Rarely, the card hangs hard and the PC needs a reboot. Strata Tune
            writes down what it is about to try before it tries it, puts the last good values back the next time it starts, and registers a Windows logon task that does the same even if
            this app never opens again.
          </Section>
          <Section title="Before you start">
            Close GPU Tweak, Afterburner and any other tool that sets clocks or fan curves for the run; their settings would fight the test. Save your work. Do not run games, renders or a
            local AI model at the same time: the test refuses to start while the GPU is busy, and would measure the wrong thing if it did.
          </Section>
          <Section title="Nothing is applied for good by itself">
            A found value is kept on the card only while you validate it, only when you press Keep, and only until the next reboot. Every result is also given to you as a value set you can
            type into Afterburner or GPU Tweak yourself; that text is what persists.
          </Section>
          <div className="space-y-2 border-t border-amber-400/30 pt-3" data-testid="tune-warning-disclaimer">
            <div className="label text-amber-300">From the disclaimer: hardware risk is real, and it is yours</div>
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
            <p className="text-studio-text">
              Raising clocks or voltages can crash the machine, lose unsaved work in other apps, shorten the life of or damage the card, and may void the vendor's warranty. You do this at
              your own risk. Enabling Tune records this acknowledgement (date, app version, graphics card) in the tune log.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 h-14 border-t border-studio-border bg-studio-panel/40 shrink-0">
          <button className="btn" onClick={onClose}>
            Not now
          </button>
          <button className="btn btn-accent" onClick={onAccept} autoFocus>
            I understand and accept the risk, enable Tune
          </button>
        </div>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1">
    <div className="label text-studio-text">{title}</div>
    <p>{children}</p>
  </div>
);

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
