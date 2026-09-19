import { useEffect, useState } from 'react';
import { loadSettings, saveSettings, type Settings } from '../settings';

type Listener = (s: Settings) => void;

let current: Settings | null = null;
const listeners = new Set<Listener>();

function read(): Settings {
  if (!current) current = loadSettings();
  return current;
}

/**
 * Merge, persist and tell every mounted hook, so a rename in one panel shows in the header
 * strip at once. The merge is over what storage holds now, not over this module's copy:
 * the Advisor writes its calibration factor through saveSettings on its own, and a patch
 * laid over a stale copy would put the old value back.
 */
export function updateSettings(patch: Partial<Settings>) {
  current = { ...loadSettings(), ...patch };
  saveSettings(current);
  listeners.forEach((l) => l(current!));
}

/** The settings as one shared value across components; App's startup copy stays untouched. */
export function useSettings(): Settings {
  const [s, setS] = useState<Settings>(read);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
