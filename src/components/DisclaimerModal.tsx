import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { Markdown } from './about/Markdown';
import { BUNDLED_LEGAL } from './about/legalText';
import { updateSettings } from './useSettings';

interface Props {
  /** The disclaimer version on show, from the main process's own read of the bundled file. */
  version: number;
  onAccepted(): void;
}

/**
 * First launch (plan section 27a): DISCLAIMER.md verbatim, through the same Markdown
 * renderer as About → Legal, with one button. Nothing else of the app is usable behind it
 * and the collector waits in the main process until the button is pressed; the acceptance is
 * kept there ({ version, acceptedAt }) and mirrored into the settings, and the modal returns
 * when the text's version changes. No close, no Escape: the text is the condition of use.
 */
export const DisclaimerModal: React.FC<Props> = ({ version, onAccepted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const status = await api.legal.accept();
      updateSettings({ disclaimerAccepted: status.accepted });
      onAccepted();
    } catch (e) {
      setError(ipcErrorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-studio-surface border border-studio-border-light rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 h-12 border-b border-studio-border shrink-0">
          <ShieldAlert size={16} className="text-amber-400" />
          <h2 id="disclaimer-title" className="text-sm font-semibold text-studio-text flex-1">
            Before Strata Tune reads anything
          </h2>
          <span className="figure text-[11px] text-studio-subtle">disclaimer v{version}</span>
        </div>
        <div className="px-5 py-4 overflow-y-auto select-text" data-testid="disclaimer-text">
          <Markdown text={BUNDLED_LEGAL.disclaimer ?? ''} />
        </div>
        <div className="flex items-center justify-between gap-3 px-5 h-14 border-t border-studio-border bg-studio-panel/40 shrink-0">
          <span className="text-micro text-studio-subtle whitespace-normal break-words">{error ? `Could not record the acceptance: ${error}` : 'The sensor collector starts once you press the button; the same text is in About → Legal.'}</span>
          <button className="btn btn-accent shrink-0" onClick={() => void accept()} disabled={busy} autoFocus>
            I understand
          </button>
        </div>
      </div>
    </div>
  );
};
