import { cpuRow } from '../components/monitor/cpuLimits';

/** What the spec sheet says about a CPU part; the audit never guesses a missing field. */
export interface CpuSpec {
  tjmaxC: number;
  /** Stock socket power ceiling in watts, AMD PPT or Intel PL2; absent for a part the table lists without one (the mobile rows). */
  stockPowerW?: number;
  powerName: 'PPT' | 'PL2';
  baseMhz: number;
  boostMhz: number;
  /** Physical cores and hardware threads; absent on rows that do not list them yet. Equal means the part has no SMT. */
  cores?: number;
  threads?: number;
}

/** The spec for the part the WMI name string identifies, or null for a part not in the table (one reader with the Monitor's cpuLimits). */
export function cpuSpec(name: string | undefined): CpuSpec | null {
  const row = cpuRow(name);
  if (!row) return null;
  return {
    tjmaxC: row.tjmax,
    stockPowerW: row.ppt ?? row.pl2,
    powerName: row.ppt !== undefined ? 'PPT' : 'PL2',
    baseMhz: row.baseMhz,
    boostMhz: row.boostMhz,
    cores: row.cores,
    threads: row.threads
  };
}
