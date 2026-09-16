import type { SensorIndex } from './sensors';
import { toneByBand } from './Bar';
import type { Tone } from './Pill';

interface RailSpec {
  label: string;
  name: RegExp;
  /** Fixed rails: ±10 % scale, ±5 % band (plan 17a). */
  nominal?: number;
  /** Variable rails: a plain range instead. */
  range?: [number, number];
  band?: [number, number];
  /** Only the SoC rail, and only on Ryzen (see socTone). */
  soc?: boolean;
}

const RAILS: RailSpec[] = [
  { label: '+12 V', name: /^\+12\s?V$/i, nominal: 12 },
  { label: '+5 V', name: /^\+5\s?V$/i, nominal: 5 },
  { label: '+3.3 V', name: /^\+3\.3\s?V$/i, nominal: 3.3 },
  { label: 'Vcore', name: /^(Vcore|CPU Core|CPU VCore)$/i, range: [0, 1.6] },
  { label: 'SoC', name: /SoC|Northbridge/i, range: [0, 1.6], soc: true },
  { label: 'DIMM', name: /^(DIMM|DRAM|VDIMM|Memory)$/i, range: [0.9, 1.6], band: [1.1, 1.45] }
];

export interface Rail {
  label: string;
  id: string;
  min: number;
  max: number;
  band?: [number, number];
  limit?: number;
  limitLabel?: string;
  soc?: boolean;
}

/**
 * AMD capped VSoC at 1.30 V in AGESA after the 2023 burn-outs. EXPO boards sit on the
 * cap by design (this box reads 1.304 V, one sensor step over), so the cap is a
 * tolerance band, not a red line: emerald to the cap plus a step, amber to 1.35 V,
 * red above. The tick stays at 1.30 V as the reference.
 */
export const SOC_CAP_V = 1.3;
const SOC_OK_TO_V = 1.305;
const SOC_WARN_TO_V = 1.35;

export function socTone(volts: number): Tone {
  return volts > SOC_WARN_TO_V ? 'bad' : volts > SOC_OK_TO_V ? 'warn' : 'ok';
}

export function railTone(rail: Rail, volts: number): Tone {
  if (rail.soc) return socTone(volts);
  return rail.band ? toneByBand(volts, rail.band) : 'ok';
}

/** The rails this board exposes, in plan order; the SoC cap applies only where AGESA does (a Ryzen CPU). */
export function boardRails(index: SensorIndex, io: string[], cpuName: string | undefined): Rail[] {
  const ryzen = /Ryzen/i.test(cpuName ?? '');
  const rails: Rail[] = [];
  for (const r of RAILS) {
    const m = index.find(io, 'Voltage', r.name);
    if (!m) continue;
    const range: [number, number] = r.nominal ? [r.nominal * 0.9, r.nominal * 1.1] : r.range!;
    const soc = r.soc && ryzen;
    rails.push({
      label: r.label,
      id: m.id,
      min: range[0],
      max: range[1],
      band: r.nominal ? [r.nominal * 0.95, r.nominal * 1.05] : r.band,
      limit: soc ? SOC_CAP_V : undefined,
      limitLabel: soc ? `AMD SoC cap ${SOC_CAP_V.toFixed(2)} V` : undefined,
      soc
    });
  }
  return rails;
}
