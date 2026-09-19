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
  /** PCI vendor ids as "0x1043" strings; a GPU's subsystem vendor id names its board partner. */
  pciVendorIds?: string[];
}

/** Slate, the same as "idle or absent", so an unrecognised vendor never borrows a state colour. */
export const UNKNOWN_VENDOR: Vendor = { vendor: '', colour: '#64748b' };

const RULES = (table as VendorRule[]).map((r) => ({ vendor: r.vendor, colour: r.colour, regex: new RegExp(r.pattern, 'i'), ids: (r.pciVendorIds ?? []).map((x) => parseInt(x, 16)) }));

/** The board partner behind a PCI subsystem vendor id (GpuFacts.pciSubsystem), or null when the id is not in the table. */
export function boardPartnerOf(vendorId: number | null | undefined): string | null {
  if (vendorId === null || vendorId === undefined) return null;
  return RULES.find((r) => r.ids.includes(vendorId))?.vendor ?? null;
}

/**
 * "ASUS · GeForce RTX 5090": the partner from the subsystem id, then the model with the
 * silicon vendor's prefix dropped. The exact board ("ROG Astral LC") is not readable,
 * which is why every panel title is renameable.
 */
export function gpuTitle(gpu: { name: string; pciSubsystem?: { vendorId: number } | null } | undefined): string {
  if (!gpu) return 'GPU';
  const partner = boardPartnerOf(gpu.pciSubsystem?.vendorId);
  const model = gpu.name.replace(/^(NVIDIA|AMD|Intel)\s+/i, '');
  const silicon = vendorOf(gpu.name).vendor;
  return partner && partner !== silicon ? `${partner} · ${model}` : gpu.name;
}

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
