import type { DisplayAdapter, StaticSnapshot } from '../collector-types';

/**
 * Which card this machine is (plan 17d, the class matrix): the snapshot's `gpus[]` is NVML's
 * list, so on an AMD or Intel machine the card exists only in `adapters[]`. Every page that
 * used to ask "is there a GPU" by reading `gpus[0]` asks here instead, so an RX 6700S is a
 * discrete card the app has no driver API for, not "no discrete GPU" (the first laptop,
 * 2026-09-19).
 */
export type DiscreteGpu = DisplayAdapter;

/** The discrete card, whatever its vendor: NVML's when there is one, else the first non-integrated adapter. Null on a machine with only a processor's graphics. */
export function discreteAdapter(s: Pick<StaticSnapshot, 'gpus' | 'adapters'>): DiscreteGpu | null {
  const nvml = s.gpus[0];
  if (nvml) {
    const match = s.adapters?.find((a) => a.vendor === 'nvidia' && !a.integrated);
    return match ?? { name: nvml.name, vendor: 'nvidia', dedicatedMiB: nvml.vram.totalMiB, driverVersion: nvml.driver, driverDate: null, integrated: false };
  }
  return s.adapters?.find((a) => !a.integrated && a.vendor !== 'other') ?? null;
}

/** The processor's own graphics when the machine has them beside a discrete card (hybrid laptops), or as its only GPU. */
export function integratedAdapter(s: Pick<StaticSnapshot, 'adapters'>): DisplayAdapter | null {
  return s.adapters?.find((a) => a.integrated) ?? null;
}

/** "AMD Radeon RX 6700S · 8 GB": the one line a header needs; "no GPU" only when Windows lists no adapter at all. */
export function gpuSummary(s: Pick<StaticSnapshot, 'gpus' | 'adapters'>): string {
  const d = discreteAdapter(s);
  if (d) return d.dedicatedMiB > 0 ? `${d.name} · ${Math.round(d.dedicatedMiB / 1024)} GB` : d.name;
  const i = integratedAdapter(s);
  return i ? `${i.name} (integrated)` : 'no GPU';
}
