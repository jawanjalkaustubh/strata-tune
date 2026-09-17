/**
 * NVML clocks-event-reason bits (docs/dependencies.md), shared by the audit
 * rules and the Monitor's perf-limit pills. The mask is an unsigned 64-bit
 * value on the wire, so the tests below avoid JavaScript's 32-bit `&`.
 */
export const GPU_IDLE = 0x1;
export const SW_POWER_CAP = 0x4;
export const HW_SLOWDOWN = 0x8;
export const SW_THERMAL_SLOWDOWN = 0x20;
export const HW_THERMAL_SLOWDOWN = 0x40;
export const HW_POWER_BRAKE = 0x80;
/** Newer than the public header; on Blackwell (driver 616.92) it reads as idle / not loaded. */
export const IDLE_HINT = 0x400;
/** Heat: the software and hardware thermal slowdowns. */
export const THERMAL = SW_THERMAL_SLOWDOWN | HW_THERMAL_SLOWDOWN;
/** The board's brake: the external power-brake signal and the hardware slowdown it engages. */
export const POWER_BRAKE = HW_SLOWDOWN | HW_POWER_BRAKE;
/** The card is protecting itself: heat, or the board's power brake. The one set the collector ends a ladder on (TuneLadder.ThermalBits, src/analysis/tune.ts THERMAL_BITS). */
export const THERMAL_OR_BRAKE = THERMAL | POWER_BRAKE;
/** Any reason the clocks are held below what the boost governor would give. */
export const SLOWDOWN = SW_POWER_CAP | THERMAL_OR_BRAKE;

export function hasBit(mask: number, bit: number): boolean {
  return Math.floor(mask / bit) % 2 === 1;
}

export function hasAny(mask: number, bits: number): boolean {
  for (let bit = 1; bit <= bits; bit *= 2) if (hasBit(bits, bit) && hasBit(mask, bit)) return true;
  return false;
}
