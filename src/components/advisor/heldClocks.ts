import type { HeldClocks } from './thisCard';

/** Suffixed on 2026-09-16: the key before it held records seeded from idle readings (817 / 7001 MHz on this box), which are not clocks the card held. */
const KEY = 'strata-tune.held-clocks.loaded';

/** Kept with the card and driver it was seen on, the same retirement rule as bench.json and the calibration timings. */
interface Stored extends HeldClocks {
  device: string;
  driver: string | null;
}

export function loadHeldClocks(device: string, driver: string | null): HeldClocks | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<Stored> | null;
    if (!s || s.device !== device || typeof s.smMhz !== 'number' || typeof s.memMhz !== 'number') return null;
    return s.driver === null || driver === null || s.driver === driver ? { smMhz: s.smMhz, memMhz: s.memMhz } : null;
  } catch {
    return null;
  }
}

export function saveHeldClocks(device: string, driver: string | null, held: HeldClocks) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ device, driver, ...held } satisfies Stored));
  } catch {
    /* private mode or full storage: this session still has them */
  }
}
