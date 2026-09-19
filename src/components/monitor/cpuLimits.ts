import table from '../../data/cpus.json';

export interface CpuLimits {
  tjmax?: number;
  /** The socket power ceiling in watts: AMD's PPT or Intel's PL2 (maximum turbo power). */
  powerW?: number;
  powerName?: 'PPT' | 'PL2';
  /** Compute dies, for grouping the chip diagram when the sensor tree does not say. */
  ccds?: number;
}

/** One row of src/data/cpus.json; the audit's cpuSpec reads the clock and thread figures off the same row. */
export interface CpuRow {
  models: string[];
  tjmax: number;
  ppt?: number;
  pl2?: number;
  ccds?: number;
  baseMhz: number;
  boostMhz: number;
  cores?: number;
  threads?: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex per model token, on word boundaries: "9950X" must not match "9950X3D" and
// "i9-13900K" must not match "i9-13900KF".
const ROWS = (table as CpuRow[]).flatMap((row) => row.models.map((model) => ({ row, regex: new RegExp(`\\b${escape(model)}\\b`, 'i') })));

/** The row for the part the WMI name string identifies, or null for a part not in the table. */
export function cpuRow(name: string | undefined): CpuRow | null {
  if (!name) return null;
  return ROWS.find((r) => r.regex.test(name))?.row ?? null;
}

/** Limits for the part the WMI name string identifies; an unknown part gets no tick, never a guess (plan 17a, section 21). */
export function cpuLimits(name: string | undefined): CpuLimits {
  const row = cpuRow(name);
  if (!row) return {};
  return {
    tjmax: row.tjmax,
    powerW: row.ppt ?? row.pl2,
    powerName: row.ppt !== undefined ? 'PPT' : row.pl2 !== undefined ? 'PL2' : undefined,
    ccds: row.ccds
  };
}
