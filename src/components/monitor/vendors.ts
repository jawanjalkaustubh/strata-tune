import table from '../../data/vendors.json';
import type { StaticSnapshot } from '../../collector-types';

export interface Vendor {
  /** Empty when no row matched. */
  vendor: string;
  /** The identity accent (plan 17a): header text, left border, chip outline and cell tint. Never a state colour. */
  colour: string;
}

interface VendorRule {
  vendor: string;
  colour: string;
  pattern: string;
}

/** Slate, the same as "idle or absent", so an unrecognised vendor never borrows a state colour. */
export const UNKNOWN_VENDOR: Vendor = { vendor: '', colour: '#64748b' };

const RULES = (table as VendorRule[]).map((r) => ({ vendor: r.vendor, colour: r.colour, regex: new RegExp(r.pattern, 'i') }));

export function vendorOf(name: string | undefined): Vendor {
  if (!name) return UNKNOWN_VENDOR;
  const hit = RULES.find((r) => r.regex.test(name));
  return hit ? { vendor: hit.vendor, colour: hit.colour } : UNKNOWN_VENDOR;
}

/** The three device panels' accents, read from the snapshot (cpu.name, gpus[].name, motherboard.manufacturer). */
export function vendorsOf(snapshot: StaticSnapshot | null, gpuName?: string): { cpu: Vendor; gpu: Vendor; board: Vendor } {
  return {
    cpu: vendorOf(snapshot?.cpu.name),
    gpu: vendorOf(gpuName ?? snapshot?.gpus[0]?.name),
    board: vendorOf(snapshot?.motherboard.manufacturer)
  };
}
