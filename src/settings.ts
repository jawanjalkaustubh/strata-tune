import type { PsuRating } from './analysis/psu';

/**
 * User settings. Tune (Phase 8) writes to hardware, so its page stays hidden
 * until the user turns it on here, and even then a warning modal stands in
 * front of it (master plan section 17). The rest are the few facts no sensor can
 * read: the advisor's calibration factor, the CPU's socket limit, the power supply.
 * The Tune flag is flipped from Help → Settings (src/components/SettingsModal.tsx)
 * behind the warning in src/components/tune/TuneWarning.tsx.
 */
export interface Settings {
  enableTune: boolean;
  /** When the user accepted the Tune warning (ISO); null until then, and cleared with the flag. */
  tuneAcceptedWarningAt: string | null;
  /** Advisor tok/s factor set from Ollama measurements on this box; null keeps the analysis default (plan section 10). */
  calibrationFactor: number | null;
  /**
   * The CPU's socket power limit (AMD PPT / Intel PL2) in watts as the user configured it in
   * the BIOS; the sensors cannot read a raised PBO limit (docs/dependencies.md). null means
   * "not set", and the Monitor bar and the audit fall back to the stock value from
   * src/data/cpus.json, labelled stock.
   */
  cpuPptW: number | null;
  /**
   * The rest of the PBO tuning the user set in the BIOS, typed in the Monitor gear beside the
   * PPT (polish 3 items 2–3) and tagged "set by you" wherever it is used: the TDC and EDC
   * current limits in amperes, and the Curve Optimizer, which no software can read on Zen 5
   * (no SMU access), so the audit's CPU advice takes it from here and never recommends the
   * undervolt the user already runs. coAllCore is the all-core offset as the BIOS shows it
   * (negative is an undervolt, −30 on the dev box); coPerCore is the user's own note of
   * per-core values, absent when not set. null means "not set".
   */
  cpuTdcA: number | null;
  cpuEdcA: number | null;
  coAllCore: number | null;
  coPerCore?: string;
  /**
   * The power supply's rated wattage and 80 PLUS badge, asked once (plan section 13): the
   * wall-side figure, the "bigger PSU?" verdict and the stats card's PSU tile read them.
   * null means "not set": the card offers the form and the reference suggestion stays muted.
   */
  psuWatts: number | null;
  psuRating: PsuRating | null;
  /**
   * What the user's vendor OC tool shows (plan section 16, 'a P0 delta write replaces the
   * vendor tool's offset'): the core offset in MHz, and the memory offset in the unit the
   * tool's slider uses. GPU Tweak III and Afterburner show the effective data rate, twice
   * NVML's memory clock (+4072 effective = +2036 NVML on the dev box); a tool that shows the
   * NVML clock is entered as 'nvml'. The one conversion is src/analysis/tune.ts
   * vendorMemoryNvml. Asked once, remembered, sent with every hunt start; null means not set.
   */
  vendorCoreOffsetMhz: number | null;
  vendorMemoryOffset: { value: number; unit: 'effective' | 'nvml' } | null;
  /**
   * "Never test above __ MHz" (plan section 16): the user's own caution for a night run, sent
   * with every hunt start; the collector skips a rung whose predicted top-of-curve SM clock
   * (core) or memory clock would pass it and ends the ladder with "stopped at your cap". null
   * means no cap, the default on every box.
   */
  coreCapMhz: number | null;
  memCapMhz: number | null;
  /**
   * "Keep my tune applied at startup" (plan section 16, 2026-09-17): the vendor values above are
   * written through our route once per collector start when the driver reads 0 / 0, so one
   * program holds the tune and the vendor tool's short-landing Apply never enters the picture.
   * Off by default; the user turns it on knowing the app then holds an overclock on the card.
   */
  holdTuneAtStartup: boolean;
  /** Monitor panel titles the user typed over the detected names, keyed by the hardware id (e.g. "/amdcpu/0", "/nvml/0", "/motherboard"). */
  panelNames: Record<string, string>;
  /** Monitor panel order and sizes, owned entirely by the Monitor page; null is the default layout. */
  monitorLayout: unknown;
  /** Plan 27a, first launch: the disclaimer version accepted and when; the main process keeps the record that gates the collector, this mirrors it. null until accepted. */
  disclaimerAccepted?: { version: number; acceptedAt: string } | null;
}

export const DEFAULT_SETTINGS: Settings = { enableTune: false, tuneAcceptedWarningAt: null, calibrationFactor: null, cpuPptW: null, cpuTdcA: null, cpuEdcA: null, coAllCore: null, psuWatts: null, psuRating: null, vendorCoreOffsetMhz: null, vendorMemoryOffset: null, coreCapMhz: null, memCapMhz: null, holdTuneAtStartup: false, panelNames: {}, monitorLayout: null };

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
