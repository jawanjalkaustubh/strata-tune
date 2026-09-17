import type { Settings } from '../../settings';

/**
 * The CPU tuning the user set in the BIOS and types into the Monitor gear (polish 3 item 3):
 * the PBO limits and the Curve Optimizer. No sensor on Zen 5 reads any of it (LHM has no
 * SMU table and no SVI3 for it; docs/dependencies.md), so every place that uses a value
 * tags it "set by you" and blank means "not set", never zero.
 */
export type CpuTuningKey = 'cpuPptW' | 'cpuTdcA' | 'cpuEdcA' | 'coAllCore';

export interface CpuTuningField {
  key: CpuTuningKey;
  /** The BIOS's own name; the socket limit takes the part's name (PPT or PL2) at render time. */
  label: string;
  unit: string;
  /** A limit is a positive figure; the Curve Optimizer takes either sign, and 0 is "none". */
  limit: boolean;
  /** PBO-only fields, hidden on a part whose limit is Intel's PL2. */
  amd: boolean;
}

export const CPU_TUNING_FIELDS: CpuTuningField[] = [
  { key: 'cpuPptW', label: 'PPT', unit: 'W', limit: true, amd: false },
  { key: 'cpuTdcA', label: 'TDC', unit: 'A', limit: true, amd: true },
  { key: 'cpuEdcA', label: 'EDC', unit: 'A', limit: true, amd: true },
  { key: 'coAllCore', label: 'CO all-core', unit: '', limit: false, amd: true }
];

export type CpuTuningDraft = Record<CpuTuningKey | 'coPerCore', string>;

/** A Curve Optimizer value as the BIOS shows it: −30, +5. */
export const coText = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/** A stored figure counts as set when it is a real number and not the BIOS default of 0. */
export const isSet = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0;

/** True when the user has recorded a Curve Optimizer at all, all-core or as a per-core note. */
export const curveOptimizerSet = (s: Pick<Settings, 'coAllCore' | 'coPerCore'>) => isSet(s.coAllCore) || !!s.coPerCore?.trim();

/** What the menu shows for a stored value: the figure, or blank for "not set". */
export function cpuTuningDraft(s: Settings): CpuTuningDraft {
  const text = (v: number | null) => (isSet(v) ? String(v) : '');
  return { cpuPptW: text(s.cpuPptW), cpuTdcA: text(s.cpuTdcA), cpuEdcA: text(s.cpuEdcA), coAllCore: text(s.coAllCore), coPerCore: s.coPerCore ?? '' };
}

/**
 * Typed text to a settings patch. A figure is rounded to the integer the BIOS takes; blank
 * or nonsense returns the field to "not set"; a limit must be positive; the Curve Optimizer
 * keeps its sign and 0 is "none". The per-core note is kept as typed, trimmed, absent when empty.
 */
export function cpuTuningPatch(draft: CpuTuningDraft): Partial<Settings> {
  const figure = (text: string, limit: boolean): number | null => {
    const n = Math.round(Number(text));
    if (!text.trim() || !Number.isFinite(n) || n === 0 || (limit && n < 0)) return null;
    return n;
  };
  const note = draft.coPerCore.trim();
  return {
    cpuPptW: figure(draft.cpuPptW, true),
    cpuTdcA: figure(draft.cpuTdcA, true),
    cpuEdcA: figure(draft.cpuEdcA, true),
    coAllCore: figure(draft.coAllCore, false),
    coPerCore: note || undefined
  };
}

/** The header strip's "set by you" line, one part per set field in menu order ("PPT 250 W", "TDC 160 A", "CO −30", "CO per core"); empty when nothing is set. */
export function cpuTuningSummary(s: Settings, powerName: string): string[] {
  const parts: string[] = [];
  if (isSet(s.cpuPptW)) parts.push(`${powerName} ${s.cpuPptW} W`);
  if (isSet(s.cpuTdcA)) parts.push(`TDC ${s.cpuTdcA} A`);
  if (isSet(s.cpuEdcA)) parts.push(`EDC ${s.cpuEdcA} A`);
  if (isSet(s.coAllCore)) parts.push(`CO ${coText(s.coAllCore)}`);
  else if (s.coPerCore?.trim()) parts.push('CO per core');
  return parts;
}
