import type { Tone } from './Pill';

export interface FanState {
  /** No tacho and the board's default duty (or none): an unpopulated header, counted rather than listed. */
  unused: boolean;
  tone: Tone;
  /** Replaces the duty figure when there is something to say about it. */
  note?: string;
}

/** Boards park an empty header at this duty; above it, 0 rpm is a stopped fan or a missing tacho wire. */
const DEFAULT_DUTY = 50;

/**
 * Plan 17a: absent sensors collapse rather than filling a wall of zeros. A header
 * reporting 0 rpm while the board drives it past its default curve is a stopped fan
 * or a missing tacho wire (the dev box's CPU_FAN header at 100 % behind an AIO),
 * which is worth amber, not idle slate.
 */
export function fanState(rpm: number | undefined, duty: number | undefined): FanState {
  if (rpm === undefined || !Number.isFinite(rpm)) return { unused: true, tone: 'idle' };
  if (rpm > 0) return { unused: false, tone: 'ok' };
  if (duty !== undefined && duty > DEFAULT_DUTY) return { unused: false, tone: 'warn', note: `no tacho at ${duty.toFixed(0)} %` };
  return { unused: true, tone: 'idle' };
}
