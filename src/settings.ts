/**
 * User settings. Tune (Phase 8) writes to hardware, so its page stays hidden
 * until the user turns it on here, and even then a warning modal stands in
 * front of it (master plan section 17). The advisor's calibration factor is the only other setting.
 *
 * TODO(Phase 8): Phase 0 ships only the flag. There is no settings UI that
 * flips it (saveSettings has no caller; the only way in is localStorage
 * 'strata-tune.settings' = {"enableTune":true}) and no warning modal. Both
 * arrive with the Tune page itself.
 */
export interface Settings {
  enableTune: boolean;
  /** Advisor tok/s factor set from Ollama measurements on this box; null keeps the analysis default (plan section 10). */
  calibrationFactor: number | null;
  /**
   * The CPU's socket power limit (AMD PPT / Intel PL2) in watts as the user configured it in
   * the BIOS; the sensors cannot read a raised PBO limit (docs/dependencies.md). null means
   * "not set", and the Monitor bar and the audit fall back to the stock value from
   * src/data/cpus.json, labelled stock.
   */
  cpuPptW: number | null;
  /** Monitor panel titles the user typed over the detected names, keyed by the hardware id (e.g. "/amdcpu/0", "/nvml/0", "/motherboard"). */
  panelNames: Record<string, string>;
  /** Monitor panel order and sizes, owned entirely by the Monitor page; null is the default layout. */
  monitorLayout: unknown;
}

export const DEFAULT_SETTINGS: Settings = { enableTune: false, calibrationFactor: null, cpuPptW: null, panelNames: {}, monitorLayout: null };

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
