import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { updateSettings, useSettings } from './useSettings';
import { TuneWarning } from './tune/TuneWarning';
import { markEnableFailed } from './tune/enableRetry';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * App settings, from Help → Settings. The per-page facts (the CPU limit, the PSU,
 * panel names) live on their pages; this holds the one switch that changes what
 * the app may do: Tune, behind its warning (plan 17). Accepting flips the flag and
 * asks the collector to register the revert-at-logon task, with the acknowledgement's
 * date (plan 27a); turning it off removes both. Only the checkbox itself toggles: a
 * click on the description must not switch Tune off without a word. The Tune page
 * retries the collector call once if it could not go through from here.
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
      .then((s) =>
        setNote(
          on
            ? s.revertTaskRegistered
              ? 'The revert-at-logon task is registered.'
              : `The logon task is not registered: ${s.revertTaskProblem ?? 'schtasks failed'}. A hard hang would be reverted only at the next app start.`
            : "Nothing of Tune's is left on the card; the revert-at-logon task is removed."
        )
      )
      .catch((e) => {
        if (on) markEnableFailed();
        setNote(`${on ? 'Registering' : 'Removing'} the logon task did not go through: ${ipcErrorMessage(e)}${on ? '. The Tune page retries it once.' : ''}`);
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
                  Enable Tune (writes to the GPU)
                </label>
                <p className="text-micro text-studio-subtle leading-relaxed">
                  Shows the Tune page, which finds your card's clock headroom by writing offsets to it. Off by default; a warning explains what can happen before it turns on.
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
        onClose={() => setWarning(false)}
        onAccept={() => {
          setWarning(false);
          setEnabled(true);
        }}
      />
    </>
  );
};
