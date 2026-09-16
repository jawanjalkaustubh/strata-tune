import table from '../../data/cpus.json';

export interface CpuLimits {
  tjmax?: number;
  /** The socket power ceiling in watts: AMD's PPT or Intel's PL2 (maximum turbo power). */
  powerW?: number;
  powerName?: 'PPT' | 'PL2';
  /** Compute dies, for grouping the chip diagram when the sensor tree does not say. */
  ccds?: number;
}

interface CpuRow {
  models: string[];
  tjmax: number;
  ppt?: number;
  pl2?: number;
  ccds?: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex per model token, on word boundaries: "9950X" must not match "9950X3D" and
// "i9-13900K" must not match "i9-13900KF".
const ROWS = (table as CpuRow[]).flatMap((row) => row.models.map((model) => ({ row, regex: new RegExp(`\\b${escape(model)}\\b`, 'i') })));

/** Limits for the part the WMI name string identifies; an unknown part gets no tick, never a guess (plan 17a, section 21). */
export function cpuLimits(name: string | undefined): CpuLimits {
  if (!name) return {};
  const hit = ROWS.find((r) => r.regex.test(name));
  if (!hit) return {};
  const { row } = hit;
  return {
    tjmax: row.tjmax,
    powerW: row.ppt ?? row.pl2,
    powerName: row.ppt !== undefined ? 'PPT' : row.pl2 !== undefined ? 'PL2' : undefined,
    ccds: row.ccds
  };
}
