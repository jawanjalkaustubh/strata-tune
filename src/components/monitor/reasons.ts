import type { Tone } from './Pill';
import { hasBit, IDLE_HINT } from '../../analysis/nvmlBits';

/**
 * Perf-limit pills for the NVML clocks-event-reason bits (dependencies.md).
 * 0x400 is newer than the public header and behaves as an idle / not-loaded
 * marker on Blackwell, so it gets a name; anything else above the header is
 * shown as hex, never dropped.
 */
const REASONS: { bit: number; label: string; tone: Tone }[] = [
  { bit: 0x1, label: 'idle', tone: 'idle' },
  { bit: 0x2, label: 'app clocks', tone: 'info' },
  { bit: 0x4, label: 'power cap', tone: 'warn' },
  { bit: 0x8, label: 'hw slowdown', tone: 'bad' },
  { bit: 0x10, label: 'sync boost', tone: 'info' },
  { bit: 0x20, label: 'thermal', tone: 'bad' },
  { bit: 0x40, label: 'thermal (hw)', tone: 'bad' },
  { bit: 0x80, label: 'power brake', tone: 'bad' },
  { bit: 0x100, label: 'display clocks', tone: 'info' }
];

export interface Reason {
  label: string;
  tone: Tone;
  /** Hex and the 0x400 marker keep their case; the named bits are pill labels. */
  mono?: boolean;
}

export function decodeReasons(raw: number): Reason[] {
  if (!raw) return [{ label: 'none', tone: 'ok' }];
  const out: Reason[] = [];
  let rest = raw;
  for (const r of REASONS) {
    if (hasBit(raw, r.bit)) {
      out.push({ label: r.label, tone: r.tone });
      rest -= r.bit;
    }
  }
  if (hasBit(rest, IDLE_HINT)) {
    out.push({ label: 'idle (0x400)', tone: 'idle', mono: true });
    rest -= IDLE_HINT;
  }
  if (rest > 0) out.push({ label: `0x${rest.toString(16)}`, tone: 'idle', mono: true });
  return out;
}
