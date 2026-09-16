/**
 * User settings. Tune (Phase 8) writes to hardware, so its page stays hidden
 * until the user turns it on here, and even then a warning modal stands in
 * front of it (master plan section 17). Nothing else is settable yet.
 *
 * TODO(Phase 8): Phase 0 ships only the flag. There is no settings UI that
 * flips it (saveSettings has no caller; the only way in is localStorage
 * 'strata-tune.settings' = {"enableTune":true}) and no warning modal. Both
 * arrive with the Tune page itself.
 */
export interface Settings {
  enableTune: boolean;
}

export const DEFAULT_SETTINGS: Settings = { enableTune: false };

const KEY = 'strata-tune.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode or full storage: the defaults come back next launch */
  }
}
