import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GpuBench } from '../electron/bench';
import { STREAM_EFFICIENCY } from '../src/analysis/advisor';
import { updateSettings } from '../src/components/useSettings';
import { factsFromPicker, factsFromSnapshot } from '../src/components/advisor/hardware';
import { gpuSpecOf, streamedBandwidth } from '../src/components/advisor/rows';
import { NVML_MEM_RATE_FACTOR, loadedClocks, raise, thisCard, type HeldClocks } from '../src/components/advisor/thisCard';
import { loadHeldClocks, saveHeldClocks } from '../src/components/advisor/heldClocks';
import { devbox } from './fixtures';

/** The renderer's localStorage, enough of it for settings.ts and the held-clocks store. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
// The card's links go through support.ts, which reads window.strata at import: a bare window is enough here.
(globalThis as { window?: unknown }).window = globalThis;
const { StatsCard } = await import('../src/components/advisor/StatsCard');

/**
 * The dev box as the driver reports it: a 600 W Astral (reference 575 W), the driver's
 * 3090 / 14001 MHz ceilings, and the clocks it was seen holding under load (docs/
 * phase1-verification.md: 3226 MHz SM, 16032 MHz memory, which NVML reports at half the
 * per-pin data rate, so 32.1 Gbps against the 28 Gbps reference).
 */
const HELD: HeldClocks = { smMhz: 3226, memMhz: 16032 };
const gpu = () => {
  const g = devbox().gpus[0];
  // The real box reads offsets 0 / 0 (the tune is a vendor-tool VF curve, invisible to NVML).
  g.clockOffsets = { smMhz: 0, memMhz: 0, maxClockSmMhz: 3090, maxClockMemMhz: 14001 };
  return g;
};
const spec = gpuSpecOf('NVIDIA GeForce RTX 5090', 32607)!;
const bench: GpuBench = {
  device: 'NVIDIA GeForce RTX 5090', luid: '1', bandwidthGBs: 1611, bandwidthMedianGBs: 1460, bufferBytes: null, matmulN: 4096,
  matmulTflopsFp32: 53, matmulTflopsFp16: 59, elapsedMs: null, driver: '616.92', measuredAt: '2026-09-16T00:00:00Z'
};

const render = (card: ReturnType<typeof thisCard> | null, withBench: GpuBench | boolean = true, latest: HeldClocks | null = null) => {
  const b = withBench === true ? bench : withBench || null;
  return renderToStaticMarkup(
    <StatsCard gpuName="NVIDIA GeForce RTX 5090" gpuColour="#76B900" spec={spec} card={card} latest={latest} npuTops={null} bench={b} applies={!!b} measuring={false} canMeasure error="" onMeasure={() => {}} />
  );
};

describe('thisCard: the driver over the table (plan section 10)', () => {
  it('this box: 600 W, 32.1 Gbps held, 2052 GB/s, against the 575 W / 28 Gbps / 1792 GB/s reference', () => {
    const c = thisCard(gpu(), spec.tiles.busBits, HELD);
    expect(c.tdpW).toBe(600);
    expect(c.limitW).toBe(600);
    expect(c.sliderMaxW).toBeNull();
    expect(c.ceilingSmMhz).toBe(3090);
    expect(c.seenSmMhz).toBe(3226);
    expect(c.memGbps).toBeCloseTo(32.064, 3);
    expect(c.memSource).toBe('held');
    expect(c.bandwidthGBs).toBeCloseTo(2052.1, 0);
    expect(spec.tiles).toMatchObject({ tdpW: 575, memoryGbps: 28 });
    expect(spec.bandwidthGBs).toBe(1792);
  });

  it('the NVML rate factor reproduces the reference from the driver ceiling: 14001 MHz is 28 Gbps', () => {
    expect((14001 * NVML_MEM_RATE_FACTOR) / 1000).toBeCloseTo(28, 1);
    // An idle reading (7001, the half-rate P-state) never counts: the ceiling wins.
    const idle = thisCard(gpu(), 512, { smMhz: 1275, memMhz: 7001 });
    expect(idle.memGbps).toBeCloseTo(28.0, 1);
    expect(idle.memSource).toBe('ceiling');
    expect(idle.bandwidthGBs).toBeCloseTo(1792, 0);
  });

  it('a positive NVML offset lifts the ceiling; a negative one does not lower it; no ceiling and no held clock leaves the reference standing', () => {
    const g = gpu();
    g.clockOffsets = { smMhz: 0, memMhz: 500, maxClockSmMhz: 3090, maxClockMemMhz: 14001 };
    expect(thisCard(g, 512, null).memGbps).toBeCloseTo(29.002, 3);
    g.clockOffsets = { smMhz: 0, memMhz: -500, maxClockSmMhz: 3090, maxClockMemMhz: 14001 };
    expect(thisCard(g, 512, null).memGbps).toBeCloseTo(28.002, 3);
    g.clockOffsets = null;
    const bare = thisCard(g, 512, null);
    expect(bare.memGbps).toBeNull();
    expect(bare.memSource).toBeNull();
    expect(bare.bandwidthGBs).toBeNull();
    expect(bare.ceilingSmMhz).toBeNull();
    expect(thisCard(gpu(), null, HELD).bandwidthGBs).toBeNull();
  });

  it('an NVAPI P-state delta lifts the ceiling like an NVML offset; both describe the same offset, so the larger counts, never the sum', () => {
    const g = gpu();
    g.pstateDeltas = { coreMhz: 0, memMhz: 2031 };
    expect(thisCard(g, 512, null).memGbps).toBeCloseTo(32.064, 3);
    expect(thisCard(g, 512, null).memCeilingGbps).toBeCloseTo(32.064, 3);
    g.clockOffsets = { smMhz: 0, memMhz: 500, maxClockSmMhz: 3090, maxClockMemMhz: 14001 };
    expect(thisCard(g, 512, null).memGbps).toBeCloseTo(32.064, 3);
    // The record above the ceiling in force is 'held'; at the ceiling it is the ceiling's.
    g.pstateDeltas = { coreMhz: 0, memMhz: 0 };
    expect(thisCard(g, 512, HELD)).toMatchObject({ memSource: 'held', memCeilingGbps: 29.002 });
  });

  it('a live reading is a held clock only under load: an idle card on a driver without ceilings leaves the reference standing (the RTX 4080 at 405 MHz case)', () => {
    const idle = { ...gpu(), clockOffsets: null, clocks: { smMhz: 210, memMhz: 405 }, utilisation: { gpu: 0, memory: 0 } };
    expect(loadedClocks(idle)).toBeNull();
    const c = thisCard(idle, 256, loadedClocks(idle));
    expect(c.memGbps).toBeNull();
    expect(c.bandwidthGBs).toBeNull();
    // The tok/s ceiling then falls back to the spec, not to 26 GB/s.
    expect(streamedBandwidth(null, false, c.bandwidthGBs ?? spec.bandwidthGBs)!.gbs).toBeCloseTo(1792 * STREAM_EFFICIENCY, 0);
    // Loaded, the same driver's reading stands on its own.
    const busy = { ...idle, clocks: { smMhz: 2700, memMhz: 11200 }, utilisation: { gpu: 97, memory: 40 } };
    expect(loadedClocks(busy)).toEqual({ smMhz: 2700, memMhz: 11200 });
    expect(thisCard(busy, 256, loadedClocks(busy))).toMatchObject({ memGbps: 22.4, memSource: 'held', bandwidthGBs: 716.8 });
  });

  it('the TDP is the board default limit; a slider above it is said beside it (a Founders Edition: 575 W default, 600 W slider)', () => {
    const fe = { ...gpu(), powerDefaultLimitMw: 575_000, powerMaxLimitMw: 600_000 };
    expect(thisCard(fe, 512, null)).toMatchObject({ tdpW: 575, sliderMaxW: 600 });
    const html = render(thisCard(fe, 512, null));
    expect(html).toContain('slider up to 600 W · reference 575 W');
    // A snapshot from before the field, or a card answering NOT_SUPPORTED, falls back to the slider top.
    expect(thisCard({ ...gpu(), powerDefaultLimitMw: 0 }, 512, null)).toMatchObject({ tdpW: 600, sliderMaxW: null });
  });

  it('a lowered power limit shows beside the board maximum', () => {
    const g = gpu();
    g.powerLimitMw = 500_000;
    expect(thisCard(g, 512, null)).toMatchObject({ tdpW: 600, limitW: 500 });
  });

  it('power limits the driver answers NOT_SUPPORTED for (0 on the wire) leave the reference TDP tile standing, never "0 W · this card"', () => {
    const g = gpu();
    g.powerLimitMw = 0;
    g.powerMaxLimitMw = 0;
    const c = thisCard(g, 512, null);
    expect(c).toMatchObject({ tdpW: null, limitW: null });
    const html = render(c);
    expect(html).not.toMatch(/>0 W</);
    expect(html).toContain('TDP</div>');
    expect(html).not.toContain('TDP <span');
    expect(html).toContain('575 W');
    expect(html).not.toContain('set to');
  });

  it('raise keeps the highest of each clock and tolerates a missing side', () => {
    expect(raise({ smMhz: 1275, memMhz: 7001 }, HELD)).toEqual(HELD);
    expect(raise(HELD, { smMhz: 3300, memMhz: 7001 })).toEqual({ smMhz: 3300, memMhz: 16032 });
    expect(raise(null, HELD)).toEqual(HELD);
    expect(raise(HELD, null)).toEqual(HELD);
    expect(raise(null, null)).toBeNull();
  });

  it("the tok/s estimate runs on this card's ceiling once known, so a tuned card is not estimated at the reference", () => {
    const c = thisCard(gpu(), spec.tiles.busBits, HELD);
    expect(streamedBandwidth(null, false, c.bandwidthGBs)!.gbs).toBeCloseTo(2052.1 * STREAM_EFFICIENCY, 0);
  });
});

describe('held clocks store', () => {
  beforeEach(() => store.clear());

  it('is kept per card and driver, and retired by either changing', () => {
    saveHeldClocks('NVIDIA GeForce RTX 5090', '616.92', HELD);
    expect(loadHeldClocks('NVIDIA GeForce RTX 5090', '616.92')).toEqual(HELD);
    expect(loadHeldClocks('NVIDIA GeForce RTX 5090', null)).toEqual(HELD);
    expect(loadHeldClocks('NVIDIA GeForce RTX 5090', '620.01')).toBeNull();
    expect(loadHeldClocks('NVIDIA GeForce RTX 4090', '616.92')).toBeNull();
    expect(loadHeldClocks('x', 'y')).toBeNull();
  });
});

describe('StatsCard: this card leads, the reference is demoted', () => {
  beforeEach(() => {
    store.clear();
    updateSettings({ psuWatts: null, psuRating: null });
  });

  it('this box: TDP 600 W this card with reference 575 beneath; 32.1 Gbps; 2052 GB/s; measured judged against its own ceiling', () => {
    const html = render(thisCard(gpu(), spec.tiles.busBits, HELD));
    expect(html).toContain('600 W');
    expect(html).toContain('reference 575 W');
    expect(html).toContain('this card');
    expect(html).toContain('32.1 Gbps');
    expect(html).toContain('reference 28 Gbps');
    expect(html).toContain('2052 GB/s');
    expect(html).toContain('reference 1792 GB/s');
    // BOOST leads with the clock held under load; the driver's VF-curve top is the last word of the sub-line, never the headline.
    expect(html).toContain('3226 MHz');
    expect(html).toContain('held under load · reference 2010 / 2407 · driver ceiling 3090');
    expect(html).not.toContain('>3090 MHz<');
    // The AI TOPS headline is this card's: 3,352 x 3226 / 2407, the advertised figure beneath.
    expect(html).toContain('4,493');
    expect(html).toContain('at 3226 MHz held under load');
    expect(html).toContain('NVIDIA advertises <span class="figure">3,352</span> at the 2407 MHz reference boost');
    // The dense / sparse pairs and the shader figure scale the same way, the reference beside each.
    expect(html).toContain('reference 419 / 838');
    expect(html).toContain('>140<');
    expect(html).toContain('reference 105');
    // Three columns: the reference, this card, the measurement.
    expect(html).toContain('>Spec<');
    expect(html).toContain('>This card<');
    expect(html).toContain('>Measured<');
    // 1611 against 2052: −21 % of this card's ceiling, −2 % against the copy a stream reaches; never "+x % above spec".
    expect(html).toContain("−21 % of this card&#x27;s ceiling");
    expect(html).toContain('−2 % vs expected copy');
    expect(html).not.toContain('vs reference spec');
    expect(html).toContain('+15 % vs reference');
  });

  it('reference only (the picker): the table figures are the primary ones, the this-card column waits for the collector', () => {
    const picker = factsFromPicker({ gpuName: 'GeForce RTX 5090', ramGiB: 32, freeDiskGiB: null }, 32);
    expect(picker.gpu).toBeNull();
    const html = render(null);
    expect(html).toContain('575 W');
    expect(html).not.toContain('600 W');
    expect(html).toContain('28 Gbps');
    expect(html).toContain('2010/2407');
    expect(html).toContain('1792 GB/s');
    // No held clock: the advertised figure stands, tagged spec, and nothing claims a clock.
    expect(html).toContain('3,352');
    expect(html).not.toContain('4,493');
    expect(html).not.toContain('held under load');
    expect(html).toContain('of 105 shader spec');
    expect(html).toContain("needs the collector&#x27;s live clocks");
    // The measurement is then judged against the reference, and says so.
    expect(html).toContain('−10 % of reference spec');
    expect(html).not.toContain('reference 575 W');
  });

  it('the PSU tile: the affordance until set, then the user\'s supply with the reference suggestion muted beneath', () => {
    const unset = render(thisCard(gpu(), spec.tiles.busBits, HELD));
    expect(unset).toContain('Set your PSU');
    expect(unset).toContain('reference suggests ≥ 1000 W');
    expect(unset).not.toContain('1300 W');
    updateSettings({ psuWatts: 1300, psuRating: 'platinum' });
    const set = render(thisCard(gpu(), spec.tiles.busBits, HELD));
    expect(set).toContain('1300 W · Platinum');
    expect(set).toContain('reference suggests ≥ 1000 W');
    expect(set).not.toContain('Set your PSU');
    // The label breaks before the provenance, never clips (plan section 17a): the space sits outside the nowrap span.
    expect(set).toContain('PSU <span class="text-slate-300 whitespace-nowrap">· you</span>');
    expect(set).toContain('600 W');
    expect(set).toContain('TDP <span class="text-slate-300 whitespace-nowrap">· this card</span>');
  });

  it('the snapshot facts carry the card, the picker does not', () => {
    expect(factsFromSnapshot(devbox(), null, null).gpu?.name).toBe('NVIDIA GeForce RTX 5090');
    const html = render(thisCard(gpu(), spec.tiles.busBits, null), false);
    // Without a held clock the ceiling stands in and the card says how to see the held one.
    expect(html).toContain('28.0 Gbps');
    expect(html).toContain('measure to see the clock the card holds under load');
    expect(html).toContain('not measured yet');
    expect(html).toContain('run a load to measure');
    // A card equal to the reference prints no "+0 % vs reference".
    expect(html).not.toContain('+0 %');
  });

  it('a measurement is judged against the clock the sweep held, not the record: 1463 GB/s at 14001 MHz is on expectation, not -29 % of a 16032 MHz ceiling', () => {
    const closed: GpuBench = { ...bench, bandwidthGBs: 1463, bandwidthMedianGBs: 1380, heldSmMhz: 2992, heldMemMhz: 14001 };
    const html = render(thisCard(gpu(), spec.tiles.busBits, HELD), closed);
    expect(html).toContain('−18 % of the clock held for this run');
    expect(html).toContain('+2 % vs expected copy');
    expect(html).not.toContain("of this card&#x27;s ceiling");
    expect(html).toContain('Judged against the 28.0 Gbps the card held while the sweep ran');
    // The record stays the card's ceiling on the tiles, and one muted line says the tune was not on for the run.
    expect(html).toContain('32.1 Gbps');
    expect(html).toContain('Earlier this card held 32.1 Gbps (2052 GB/s); this run held 28.0 Gbps — the memory offset was not applied then (vendor tool closed?).');
  });

  it('the last load seen below the record says the offset is not applied now; at the record nothing is said', () => {
    const now = render(thisCard(gpu(), spec.tiles.busBits, HELD), true, { smMhz: 2990, memMhz: 14001 });
    expect(now).toContain('the last load seen held 28.0 Gbps — the memory offset is not applied now (vendor tool closed?).');
    const same = render(thisCard(gpu(), spec.tiles.busBits, HELD), true, HELD);
    expect(same).not.toContain('Earlier this card held');
    // Within 2 % of the record is the same clock, not a lost tune.
    const near = render(thisCard(gpu(), spec.tiles.busBits, HELD), true, { smMhz: 3200, memMhz: 15800 });
    expect(near).not.toContain('Earlier this card held');
  });

  it('the tile row is auto-fit at 150 px, never a fixed twelve columns; the PSU tile is the last and spans two', () => {
    const html = render(thisCard(gpu(), spec.tiles.busBits, HELD));
    expect(html).toContain('grid-cols-[repeat(auto-fit,minmax(150px,1fr))]');
    expect(html).not.toMatch(/2xl:grid-cols-12|xl:grid-cols-11/);
    expect(html).toContain('col-span-2');
  });
});
