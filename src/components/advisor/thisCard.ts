import type { GpuFacts } from '../../collector-types';

/**
 * This card as the driver reports it, against the reference design in gpus.json (plan
 * section 10 'Reference spec vs this card'). Every table figure is the reference board;
 * a board-partner card runs above it by default and a tuned one further still, so the
 * stats card leads with the card's own power limit, clock ceilings and held clocks, and
 * demotes the table row to "reference".
 */

/**
 * NVML reports a GDDR6/6X/7 memory clock at half the per-pin data rate. On the dev box's
 * 5090 the driver ceiling (nvmlDeviceGetMaxClockInfo) reads 14001 MHz for the 28 Gbps
 * reference, the card holds 16032 MHz under load (32.1 Gbps, the user's tune) and idles at
 * 7001, a half-rate P-state that says nothing about the card's speed. nvidia-smi 2026-09-16.
 */
export const NVML_MEM_RATE_FACTOR = 2;

/**
 * Effective Gbps per MHz of the memory clock as GPU-Z, GPU Tweak and the spec tables print
 * it (plan section 10 'MEMORY CLOCK'): GDDR7 and GDDR6X move sixteen bits per clock (1750 MHz
 * is 28 Gbps on the 5090; 1313 MHz is 21 Gbps on the 4090), GDDR6 eight (2125 MHz is 17 Gbps
 * on the 4060). HBM has its own rule and no row here, so its tile is skipped rather than
 * guessed. NVML reports every type at half the data rate, so the printed clock is NVML's
 * figure divided by half this factor: on the dev box 14001 -> 1750 MHz (the reference
 * ceiling) and 16008 -> 2001 MHz (the +4072 GPU Tweak tune, which the slider counts in
 * effective MHz; 2001 - 1750 = +251 MHz in the GPU-Z convention).
 */
export const MEM_GBPS_PER_MHZ: Record<string, number> = { GDDR7: 16, GDDR6X: 16, GDDR6: 8 };

/**
 * nvmlDeviceGetClockOffsets counts the memory offset on the effective data rate, the vendor
 * sliders' unit, twice the NVML memory clock: with the collector's own P0 delta of +2036 NVML
 * MHz on the card (NvAPI_GPU_SetPstates20, the card holding 14001 + 2036 = 16037) the driver
 * read +4072 (2026-09-17, driver 616.92), and adding that to the 14001 ceiling put the stats
 * card at 18073 MHz / 36.1 Gbps. The SM offset is 1:1. This is the one conversion to NVML
 * clock units; the wire keeps what the driver said.
 */
export function nvmlMemOffsetMhz(clockOffsets: GpuFacts['clockOffsets']): number | null {
  const v = clockOffsets?.memMhz ?? null;
  return v === null ? null : Math.trunc(v / NVML_MEM_RATE_FACTOR);
}

/** NVML's memory clock in the GPU-Z convention for the card's memory type; null for a type without a rule. */
export function memClockMhzOf(nvmlMemMhz: number, vramType: string): number | null {
  const factor = MEM_GBPS_PER_MHZ[vramType];
  return factor ? Math.round(nvmlMemMhz / (factor / NVML_MEM_RATE_FACTOR)) : null;
}

/**
 * GPU utilisation from which a live reading counts as the card under load, its memory at
 * the full P0 rate. Below it the memory may sit in a half-rate state (7001 MHz here at 3 %),
 * and on a driver without clock ceilings such a reading would become "this card": an RTX
 * 4080 idling at 405 MHz read 0.8 Gbps that way. The GpuIdle event bit is no help: this box
 * reports an unnamed bit (0x400) at idle and never GpuIdle.
 */
export const LOADED_UTIL = 50;

/** The highest clocks this card has been seen holding under load (heldClocks.ts): a tuned memory rate only shows there. */
export interface HeldClocks {
  smMhz: number;
  memMhz: number;
}

export interface ThisCard {
  /** The board's default power limit, the TDP it is built for: 600 W on the Astral against the 575 W reference. null when the driver reports none (NOT_SUPPORTED reads 0 on the wire), so the reference stands. */
  tdpW: number | null;
  /** The top of the power slider when it is above tdpW (a Founders Edition: 575 W default, 600 W slider); null when equal or unreported. */
  sliderMaxW: number | null;
  /** The limit in force now; below tdpW when the user lowered it; null when unreported. */
  limitW: number | null;
  /** The driver's SM clock ceiling, the VF-curve top (3090 MHz on every 5090), not the board's boost; null when the driver has no nvmlDeviceGetMaxClockInfo export. */
  ceilingSmMhz: number | null;
  /** The highest SM clock seen held under load; the BOOST tile and the headline lead with it. */
  seenSmMhz: number | null;
  /** The NVML memory clock behind memGbps (held, else the ceiling plus offsets), for the MEMORY CLOCK tile; null with memGbps. */
  memMhz: number | null;
  /** Effective memory data rate; null when neither a ceiling nor a held clock is known, so the reference stands. */
  memGbps: number | null;
  /** 'held': a clock the card was seen holding, above the table; 'ceiling': the driver's table top plus any offset in force. */
  memSource: 'held' | 'ceiling' | null;
  /** The rate the driver's ceiling plus the offsets in force allow now; a held record above it is a tune applied by a route the driver no longer reports (the vendor tool closed). */
  memCeilingGbps: number | null;
  /** memGbps x bus width / 8; null without the bus width (a card outside gpus.json). */
  bandwidthGBs: number | null;
  /** Unit counts read through NVAPI (GpuFacts.units); a count the driver refused is null, and the whole block is null without NVAPI. */
  units: { shaders: number | null; tmus: number | null; rops: number | null } | null;
}

/** Highest of each; a null side yields the other. */
export function raise(a: HeldClocks | null, b: HeldClocks | null): HeldClocks | null {
  if (!a || !b) return a ?? b;
  return { smMhz: Math.max(a.smMhz, b.smMhz), memMhz: Math.max(a.memMhz, b.memMhz) };
}

/** The live reading as held clocks when the card is loaded; null at idle, where the memory clock is a P-state, not the card. */
export function loadedClocks(g: GpuFacts): HeldClocks | null {
  return g.utilisation.gpu >= LOADED_UTIL && g.clocks.memMhz > 0 ? { smMhz: g.clocks.smMhz, memMhz: g.clocks.memMhz } : null;
}

export const memGbpsOf = (memMhz: number) => (memMhz * NVML_MEM_RATE_FACTOR) / 1000;

/**
 * The card's own figures. Memory: the clock it was seen holding under load when that beats
 * the driver's ceiling (an overclock applied by a vendor tool, which NVML's offsets read as 0),
 * else the ceiling plus the largest positive offset in force, whether NVML or NVAPI reports
 * it (both describe the same P0 offset). A held reading is only ever a loaded one
 * (loadedClocks), so without a ceiling it stands on its own, and without either the
 * reference stands.
 */
export function thisCard(gpu: GpuFacts, busBits: number | null, held: HeldClocks | null): ThisCard {
  const o = gpu.clockOffsets;
  const offset = Math.max(0, nvmlMemOffsetMhz(o) ?? 0, gpu.pstateDeltas?.memMhz ?? 0);
  const ceilingMem = o?.maxClockMemMhz != null ? o.maxClockMemMhz + offset : 0;
  const heldMem = held?.memMhz ?? 0;
  const memMhz = Math.max(heldMem, ceilingMem);
  const memGbps = memMhz > 0 ? memGbpsOf(memMhz) : null;
  const tdpMw = gpu.powerDefaultLimitMw || gpu.powerMaxLimitMw;
  return {
    tdpW: tdpMw > 0 ? tdpMw / 1000 : null,
    sliderMaxW: gpu.powerMaxLimitMw > tdpMw ? gpu.powerMaxLimitMw / 1000 : null,
    limitW: gpu.powerLimitMw > 0 ? gpu.powerLimitMw / 1000 : null,
    ceilingSmMhz: o?.maxClockSmMhz ?? null,
    seenSmMhz: held?.smMhz ?? null,
    memMhz: memMhz > 0 ? memMhz : null,
    memGbps,
    memSource: memGbps === null ? null : heldMem > ceilingMem ? 'held' : 'ceiling',
    memCeilingGbps: ceilingMem > 0 ? memGbpsOf(ceilingMem) : null,
    bandwidthGBs: memGbps !== null && busBits ? (memGbps * busBits) / 8 : null,
    units: gpu.units ? { shaders: gpu.units.shaders, tmus: gpu.units.tmus, rops: gpu.units.rops } : null
  };
}
