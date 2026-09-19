import { describe, expect, it } from 'vitest';
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SensorMeta, StaticSnapshot, Tick } from '../src/collector-types';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { capsOf } from '../src/components/monitor/caps';
import { CpuPanel } from '../src/components/monitor/CpuPanel';
import { GpuPanel } from '../src/components/monitor/GpuPanel';
import { BoardPanel } from '../src/components/monitor/BoardPanel';
import { SystemPower, batteryLine } from '../src/components/monitor/SystemPower';
import { BatteryPanel } from '../src/components/monitor/BatteryPanel';
import { MonitorMenu } from '../src/components/monitor/MonitorMenu';
import { igpuLayout } from '../src/components/monitor/gpuLayout';
import { factsFromSnapshot } from '../src/components/advisor/hardware';
import { adviseRows, bestRows, DEFAULT_FACTOR, gpuSpecOf, streamedBandwidth } from '../src/components/advisor/rows';
import { ModelList } from '../src/components/advisor/ModelList';
import { BestFor } from '../src/components/advisor/BestFor';
import { thisCard } from '../src/components/advisor/thisCard';
import { deviceClass } from '../src/analysis/tune';

/** The renderer's localStorage, enough of it for settings.ts inside the panels. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
(globalThis as { window?: unknown }).window = globalThis;
const { StatsCard, noSpecText } = await import('../src/components/advisor/StatsCard');

interface Machine {
  class: string;
  snapshot: StaticSnapshot;
  meta: SensorMeta[];
  tick: Tick;
}

const machine = (cls: string): Machine => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'classes', `${cls}.machine.json`), 'utf8')) as Machine;

/** The Monitor page's panels over a class fixture, with the capability object the page computes once (plan 17d rule 2). */
function monitor(m: Machine) {
  const index = new SensorIndex(m.meta);
  const ring = new Ring();
  for (let i = 0; i < 6; i++) ring.push({ ...m.tick, qpc: m.tick.qpc + i * 5_000_000 });
  const caps = capsOf(m.snapshot, index, m.tick);
  return {
    caps,
    cpu: renderToStaticMarkup(<CpuPanel index={index} tick={m.tick} ring={ring} snapshot={m.snapshot} />),
    gpu: renderToStaticMarkup(<GpuPanel index={index} tick={m.tick} ring={ring} caps={caps} />),
    board: renderToStaticMarkup(<BoardPanel index={index} tick={m.tick} ring={ring} snapshot={m.snapshot} />),
    power: renderToStaticMarkup(<SystemPower index={index} tick={m.tick} ring={ring} snapshot={m.snapshot} caps={caps} />),
    menu: renderToStaticMarkup(<MonitorMenu cpuName={m.snapshot.cpu.name} laptop={caps.laptop} layoutIsDefault onClose={() => undefined} />),
    battery: batteryLine(index, m.tick)
  };
}

describe('plan 17d row 1, a laptop with no discrete GPU: the Monitor page', () => {
  const m = machine('laptop-no-dgpu');
  const page = monitor(m);

  it('the capability object says what the machine is: no NVML, an iGPU, a battery, a laptop', () => {
    expect(deviceClass(m.snapshot)).toBe('laptop-no-dgpu');
    expect(page.caps).toMatchObject({ nvml: false, nvapi: false, pins: false, igpu: true, battery: true, laptop: true, dynamicBoost: false, npu: false, arm64: false });
  });

  it("the GPU panel is the iGPU's own sensors headed by its library name, no NVML-shaped rows and no line about a missing card", () => {
    const layout = igpuLayout(new SensorIndex(m.meta), undefined)!;
    expect(layout.name).toBe('AMD Radeon(TM) Graphics');
    expect(layout.clock).toBeDefined();
    expect(layout.load).toBeDefined();
    expect(layout.sharedUsed).toBeDefined();
    expect(page.gpu).toContain('AMD Radeon(TM) Graphics');
    expect(page.gpu).toContain('integrated · no discrete card');
    expect(page.gpu).toContain('Core clock');
    expect(page.gpu).toContain('1800 MHz');
    expect(page.gpu).toContain('Shared memory');
    expect(page.gpu).toContain('of 8.0 GiB of RAM');
    expect(page.gpu).toContain('>3D<');
    expect(page.gpu).toContain('4.1 W');
    for (const gone of ['no NVML GPU', '12V-2x6', 'Perf limit', 'Board power', 'VRAM', 'driver ']) expect(page.gpu).not.toContain(gone);
    expect(page.gpu).not.toMatch(/undefined|NaN|—/);
  });

  it('no super-IO: the Board panel says so in one line instead of vanishing', () => {
    expect(page.board).toContain('No board sensors on this machine');
    expect(page.board).toContain('LNVNB161216');
  });

  it("the PSU question is not asked; the battery's line stands in its place", () => {
    expect(page.battery).toBe('81 % charged · discharging at 17.2 W · about 148 min left');
    expect(page.power).toContain('>Battery<');
    expect(page.power).toContain('81 % charged');
    expect(page.power).not.toContain('>PSU<');
    expect(page.power).not.toContain('for the wall-side figure');
  });

  it("the gear popover's fields are the vendor app's, not the BIOS's", () => {
    expect(page.menu).toContain('CPU power mode you set in the vendor app');
    expect(page.menu).toContain('Armoury Crate');
    expect(page.menu).not.toContain('you set in BIOS');
    expect(page.menu).not.toContain('set in the BIOS or Ryzen Master');
  });

  it('the CPU panel renders the eight cores with the vendor accent', () => {
    expect(page.cpu).toContain('#ED1C24');
    expect((page.cpu.match(/chip-figure/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(page.cpu).not.toMatch(/undefined|NaN/);
  });
});

describe('plan 17d row 1, a laptop with no discrete GPU: AI Models', () => {
  const m = machine('laptop-no-dgpu');
  const facts = factsFromSnapshot(m.snapshot, null, null);

  it('names the device honestly and estimates CPU-only inference from the RAM bus', () => {
    expect(facts.integrated).toBe(true);
    expect(facts.gpuName).toBe('Integrated graphics (no discrete GPU)');
    expect(facts.vramBytes).toBe(0);
    // Dual-channel DDR5-5600: 89.6 GB/s on the plan's rule.
    expect(facts.ramBandwidthGBs).toBeCloseTo(89.6, 1);
    const rows = adviseRows({ facts, bandwidthGBs: null, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.cpuOnly)).toBe(true);
    expect(rows.every((r) => r.bucket === 'slow' || r.bucket === 'no')).toBe(true);
    // A 4B model at a few tokens a second, as the plan says: the RAM bus over about 2.2 GB of paced weights, at the calibrated factor.
    const small = rows.find((r) => /qwen3:4b/.test(r.pullTag) && /q4/i.test(r.quantLabel));
    expect(small).toBeDefined();
    expect(small!.bucket).toBe('slow');
    expect(small!.tokPerSec).toBeGreaterThan(5);
    expect(small!.tokPerSec).toBeLessThan(40);
    // A 70B model does not fit 16 GB of RAM.
    expect(rows.find((r) => /70b/.test(r.pullTag))?.bucket).toBe('no');
  });

  it('the list says "runs on the CPU" and why, against RAM, with no VRAM bar and no "tok/s needs bandwidth"', () => {
    const rows = adviseRows({ facts, bandwidthGBs: null, contextTokens: 8192, factor: DEFAULT_FACTOR });
    const html = renderToStaticMarkup(
      <ModelList rows={rows} vramBytes={facts.vramBytes} ramBytes={facts.ramBytes} liveVram freeDiskBytes={facts.freeDiskBytes} diskLabel="C:" contextTokens={8192} maxContext={131072} onContext={() => {}} tags={[]} filter={null} onFilter={() => {}} bandwidthKnown />
    );
    expect(html).toContain('Runs on the CPU');
    expect(html).toContain('required RAM');
    expect(html).toContain('a discrete GPU is what changes this');
    expect(html).not.toContain('tok/s needs bandwidth');
    expect(html).not.toContain('of 0 GiB');
    expect(html).not.toContain('Runs slowly');
    const picks = bestRows(rows);
    expect(picks.chat).not.toBeNull();
    const best = renderToStaticMarkup(<BestFor picks={picks} measured={{}} contextTokens="8k" />);
    expect(best).toContain('tok/s on the CPU');
    expect(best).not.toContain('Nothing tagged chat runs fast');
  });

  it("the stats card explains the absence in the user's words, never a file to edit", () => {
    expect(noSpecText(true, facts.ramBandwidthGBs, false)).toContain('No discrete GPU: models run on the CPU from RAM, paced by the RAM bus at about 90 GB/s');
    expect(noSpecText(false, undefined, true)).toBe("No reference figures for this GPU yet; the estimates use the driver's own bandwidth (the memory clock the card holds times its bus width).");
    const html = renderToStaticMarkup(
      <StatsCard gpuName={facts.gpuName} gpuColour="#64748b" spec={null} card={null} integrated ramBandwidthGBs={facts.ramBandwidthGBs} latest={null} npuTops={null} bench={null} applies={false} measuring={false} canMeasure={false} error="" onMeasure={() => {}} />
    );
    expect(html).toContain('No discrete GPU: models run on the CPU from RAM');
    expect(html).toContain('A discrete GPU is what changes this.');
    expect(html).toContain('RAM bus');
    expect(html).toContain('No tensor cores');
    expect(html).toContain('not measured');
    for (const gone of ['gpus.json', 'could not determine', '—', 'No NVML GPU', '>This card<']) expect(html).not.toContain(gone);
  });
});

describe('plan 17d row 2, a gaming laptop: the Monitor page and AI Models', () => {
  const m = machine('gaming-laptop');
  const page = monitor(m);

  it('the capability object: NVML and NVAPI present, no pins, Dynamic Boost, a battery, a laptop', () => {
    expect(deviceClass(m.snapshot)).toBe('gaming-laptop');
    expect(page.caps).toMatchObject({ nvml: true, nvapi: true, pins: false, battery: true, laptop: true, dynamicBoost: true });
  });

  it('the board-power limit is a band from the TGP to the Dynamic Boost limit, not one tick; no 12V-2x6 block', () => {
    expect(page.gpu).toContain('TGP 115 W');
    expect(page.gpu).toContain('Dynamic Boost up to 140 W');
    expect(page.gpu).not.toContain('12V-2x6');
    expect(page.gpu).not.toContain('Power limit 115 W');
    expect(page.gpu).toContain('GeForce RTX 4070 Laptop GPU');
  });

  it("the popover and the PSU line follow the laptop rules here too", () => {
    expect(page.menu).toContain('CPU power mode you set in the vendor app');
    expect(page.power).toContain('>Battery<');
    expect(page.power).not.toContain('>PSU<');
    expect(page.board).toContain('No board sensors on this machine');
  });

  it('AI Models has a reference row for the laptop card: the TGP range on the tile, tok/s on every row, no developer text', () => {
    const facts = factsFromSnapshot(m.snapshot, null, null);
    expect(facts.integrated).toBe(false);
    const spec = gpuSpecOf(facts.gpuName, facts.vramBytes / 1024 ** 2);
    expect(spec?.name).toBe('GeForce RTX 4070 Laptop');
    expect(spec?.tiles.tgpRangeW).toEqual([35, 115]);
    const card = thisCard(facts.gpu!, spec!.tiles.busBits, null);
    const bandwidth = streamedBandwidth(null, false, card.bandwidthGBs ?? spec!.bandwidthGBs);
    expect(bandwidth?.gbs).toBeGreaterThan(150);
    const rows = adviseRows({ facts, bandwidthGBs: bandwidth!.gbs, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(rows.every((r) => r.tokPerSec !== null && !r.cpuOnly)).toBe(true);
    const html = renderToStaticMarkup(
      <StatsCard gpuName={facts.gpuName} gpuColour="#76B900" spec={spec} card={card} latest={null} npuTops={null} bench={null} applies={false} measuring={false} canMeasure={false} error="" onMeasure={() => {}} />
    );
    expect(html).toContain('laptop makers set 35–115 W');
    expect(html).toContain('>TGP');
    for (const gone of ['gpus.json', 'could not determine', 'no reference row']) expect(html).not.toContain(gone);
  });
});

describe('the first real laptop (2026-09-19): an AMD/AMD hybrid gaming laptop, the RX 6700S beside the 6900HS, no PawnIO', () => {
  const m = machine('gaming-laptop-amd');
  const page = monitor(m);

  it('the capability object: no NVML, a discrete AMD card, an iGPU beside it, a battery, a laptop, no CPU node', () => {
    expect(page.caps).toMatchObject({ nvml: false, nvapi: false, pins: false, igpu: true, battery: true, laptop: true, dynamicBoost: false });
    expect(page.caps.dgpu?.name).toBe('AMD Radeon RX 6700S');
    expect(page.caps.dgpu?.dedicatedMiB).toBe(8176);
    expect(page.caps.igpuAdapter?.name).toBe('AMD Radeon(TM) Graphics');
    expect(deviceClass(m.snapshot)).toBe('gaming-laptop');
  });

  it("the GPU panel is the card's, never 'integrated · no discrete card': its VRAM, memory clock, hot spot and the iGPU beside it named", () => {
    expect(page.gpu).toContain('AMD Radeon RX 6700S');
    expect(page.gpu).toContain('8 GB · driver 31.0.12024.2005');
    expect(page.gpu).not.toContain('integrated · no discrete card');
    expect(page.gpu).toContain('>VRAM<');
    expect(page.gpu).toContain('of 8.0 GiB');
    expect(page.gpu).toContain('Memory clock');
    expect(page.gpu).toContain('Hot spot');
    expect(page.gpu).toContain('AMD Radeon(TM) Graphics drives the desktop');
    for (const gone of ['Shared memory', 'no NVML GPU', '12V-2x6', 'Perf limit', 'Board power']) expect(page.gpu).not.toContain(gone);
    expect(page.gpu).not.toMatch(/undefined|NaN|—/);
  });

  it('the CPU panel with no PawnIO says so and points at pawnio.eu instead of drawing empty bars', () => {
    expect(page.cpu).toContain('No CPU sensors: the PawnIO driver is not installed');
    expect(page.cpu).toContain('pawnio.eu');
    expect(page.cpu).not.toContain('chip-figure');
    expect(page.cpu).not.toContain('Tctl');
  });

  it("the battery panel reads the pack's real rows: charge, the watts flowing in, the voltage and the wear against the design figure", () => {
    const index = new SensorIndex(m.meta);
    const ring = new Ring();
    ring.push(m.tick);
    const html = renderToStaticMarkup(<BatteryPanel index={index} tick={m.tick} ring={ring} snapshot={m.snapshot} />);
    expect(html).toContain('ASUS');
    expect(html).toContain('plugged in');
    expect(html).toContain('87 %');
    expect(html).toContain('charging 8.9 W');
    expect(html).toContain('15.93 V');
    expect(html).toContain('>Wear<');
    expect(html).toContain('20 %');
    expect(html).toContain('61.0 of 76.0 Wh as new');
    expect(html).not.toMatch(/undefined|NaN|—/);
    expect(page.battery).toBe('87 % charged · charging at 8.9 W');
  });

  it('the system-power row exists from the card\'s library power alone, with the battery line where the PSU question would be', () => {
    expect(page.power).toContain('>Battery<');
    expect(page.power).toContain('87 % charged');
    expect(page.power).not.toContain('>PSU<');
  });

  it("AI Models sizes against the card's 8 GB, not RAM: not integrated, the bench for this card applies, the reference row is found", () => {
    const facts = factsFromSnapshot(m.snapshot, null, null, { usedMiB: 4, totalMiB: 8176 });
    expect(facts.integrated).toBe(false);
    expect(facts.gpuName).toBe('AMD Radeon RX 6700S');
    expect(facts.vramBytes).toBe(8176 * 1024 ** 2);
    expect(facts.vramFreeBytes).toBe(8172 * 1024 ** 2);
    expect(facts.gpu).toBeNull();
    expect(facts.driver).toBe('31.0.12024.2005');
    const spec = gpuSpecOf(facts.gpuName, facts.vramBytes / 1024 ** 2);
    expect(spec?.name).toBe('Radeon RX 6700S');
    expect(spec?.bandwidthGBs).toBe(224);
    const rows = adviseRows({ facts, bandwidthGBs: 197, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(rows.every((r) => !r.cpuOnly)).toBe(true);
    // A 4B q4 model fits the 8 GB card outright; a 14B q4 spills into RAM; a 70B does not run.
    expect(rows.find((r) => /qwen3:4b/.test(r.pullTag) && /q4/i.test(r.quantLabel))?.bucket).toBe('fast');
    expect(rows.find((r) => /qwen2\.5-coder:14b$/.test(r.pullTag))?.bucket).toBe('slow');
    expect(rows.find((r) => /70b/.test(r.pullTag))?.bucket).toBe('no');
    const html = renderToStaticMarkup(
      <StatsCard gpuName={facts.gpuName} gpuColour="#ED1C24" spec={spec} card={null} latest={null} npuTops={null} bench={null} applies={false} measuring={false} canMeasure={false} error="" onMeasure={() => {}} />
    );
    expect(html).toContain('Navi 23');
    expect(html).toContain('8 GB GDDR6');
    for (const gone of ['No discrete GPU', 'no discrete GPU', 'not this GPU', 'gpus.json']) expect(html).not.toContain(gone);
  });
});
