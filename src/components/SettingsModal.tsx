import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { updateSettings, useSettings } from './useSettings';
import { TuneWarning } from './tune/TuneWarning';
import { markEnableFailed } from './tune/enableRetry';
import { rememberedSnapshot } from './monitor/cache';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * App settings, from Help → Settings. The per-page facts (the CPU limit, the PSU,
 * panel names) live on their pages; this holds the one switch that changes what
 * the app may do: the Headroom hunt on the Tune page, behind its warning (plan 17,
 * 27a). Accepting flips the flag and sends the acknowledgement (date, app version; the
 * collector adds the GPU name) to the tune log; turning it off takes anything of
 * Tune's off the card. Only the checkbox itself toggles: a click on the description
 * must not switch it off without a word. The Tune page retries the collector call once
 * if it could not go through from here.
 */
export const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const settings = useSettings();
  const [warning, setWarning] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !warning) onClose();
    };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, warning]);

  if (!isOpen) return null;

  const setEnabled = (on: boolean) => {
    const acknowledgedAt = on ? new Date().toISOString() : null;
    updateSettings({ enableTune: on, tuneAcceptedWarningAt: acknowledgedAt });
    setNote('');
    api?.tune
      .enable(on, acknowledgedAt ?? undefined)
      .then(() => setNote(on ? 'Headroom is on; the acknowledgement is in the tune log.' : "Headroom is off; nothing of Tune's is left on the card."))
      .catch((e) => {
        if (on) markEnableFailed();
        setNote(`The collector did not take the ${on ? 'acknowledgement' : 'switch-off'}: ${ipcErrorMessage(e)}${on ? '. The Tune page retries it once.' : ''}`);
      });
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className="w-full max-w-md bg-studio-surface border border-studio-border rounded-lg shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 h-12 border-b border-studio-border">
            <h2 className="text-sm font-semibold text-studio-text">Settings</h2>
            <button className="btn-icon" onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-3">
              <input
                id="enable-tune"
                type="checkbox"
                className="mt-0.5 accent-emerald-500 cursor-pointer"
                checked={settings.enableTune}
                onChange={(e) => (e.target.checked ? setWarning(true) : setEnabled(false))}
              />
              <div className="space-y-1">
                <label htmlFor="enable-tune" className="block text-mini font-medium text-studio-text cursor-pointer">
                  Headroom hunt (tests small clock offsets on the GPU)
                </label>
                <p className="text-micro text-studio-subtle leading-relaxed">
                  Turns on the Headroom section of the Tune page: it finds how far your card's clocks go, scores each step and hands you the values for your vendor tool; the card is
                  left as it was found. Off by default; a warning says what happens before it turns on.
                  {settings.tuneAcceptedWarningAt && settings.enableTune && ` Accepted ${new Date(settings.tuneAcceptedWarningAt).toLocaleDateString()}.`}
                </p>
                {note && <p className="text-micro text-studio-muted">{note}</p>}
              </div>
            </div>
            <p className="text-micro text-studio-subtle border-t border-studio-border pt-3">
              The facts no sensor can read (your CPU power limit, your power supply) are asked for on the pages that use them; panel names are edited on the panels themselves.
            </p>
          </div>
        </div>
      </div>
      <TuneWarning
        isOpen={warning}
        laptop={!!rememberedSnapshot()?.chassis.isLaptop}
        onClose={() => setWarning(false)}
        onAccept={() => {
          setWarning(false);
          setEnabled(true);
        }}
      />
    </>
  );
};
