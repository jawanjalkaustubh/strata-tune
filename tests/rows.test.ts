import { describe, expect, it } from 'vitest';
import type { GpuBench } from '../electron/bench';
import { STREAM_EFFICIENCY } from '../src/analysis/advisor';
import { lookupGpu } from '../src/analysis/hardware-tables';
import { factsFromPicker, factsFromSnapshot, sameGpu } from '../src/components/advisor/hardware';
import { DEFAULT_FACTOR, FACTOR_BAND, GPU_NAMES, PRECISIONS, adviseRows, bestRows, derivedFactor, estimateFor, gpuSpecOf, inFactor, streamedBandwidth } from '../src/components/advisor/rows';
import { devbox } from './fixtures';

const GB = 1e9;
const box = factsFromPicker({ gpuName: 'GeForce RTX 5090', ramGiB: 32, freeDiskGiB: 100 }, 32);
const spec = gpuSpecOf(box.gpuName)!;
/** Standalone: nobody measured this card and no live clock is known, so the estimates run on the reference figure scaled to what a copy reaches. */
const bandwidthGBs = streamedBandwidth(null, false, spec.bandwidthGBs)!.gbs;

const bench = (device: string, bandwidthGBs: number): GpuBench => ({
  device, luid: '1', bandwidthGBs, bandwidthMedianGBs: null, bufferBytes: null, matmulN: null, matmulTflopsFp32: 50, matmulTflopsFp16: null, elapsedMs: null, driver: null, measuredAt: '2026-09-16T00:00:00Z'
});

describe('lookupGpu: NVML and DXGI names carry a vendor prefix the table does not', () => {
  it('matches through the prefix and prefers the longer row', () => {
    expect(lookupGpu('NVIDIA GeForce RTX 5090')?.name).toBe('GeForce RTX 5090');
    expect(lookupGpu('NVIDIA GeForce RTX 5070')?.name).toBe('GeForce RTX 5070');
    expect(lookupGpu('NVIDIA GeForce RTX 5070 Ti')?.name).toBe('GeForce RTX 5070 Ti');
    expect(lookupGpu('Some Unknown Card')).toBeNull();
    expect(GPU_NAMES).toContain('GeForce RTX 5090');
  });

  it('sameGpu pairs a bench.json device with the picker or snapshot name, and never with a sibling card', () => {
    expect(sameGpu('NVIDIA GeForce RTX 5090', 'GeForce RTX 5090')).toBe(true);
    expect(sameGpu('NVIDIA GeForce RTX 5090', 'GeForce RTX 4090')).toBe(false);
    expect(sameGpu('NVIDIA GeForce RTX 5070', 'GeForce RTX 5070 Ti')).toBe(false);
    expect(sameGpu('NVIDIA GeForce RTX 5070 Ti', 'NVIDIA GeForce RTX 5070')).toBe(false);
    expect(sameGpu('NVIDIA GeForce RTX 4060', 'GeForce RTX 4060 Ti 16 GB')).toBe(false);
    expect(sameGpu('NVIDIA GeForce RTX 3080', 'GeForce RTX 3080 Ti')).toBe(false);
    expect(sameGpu('AMD Radeon RX 7900 XT', 'Radeon RX 7900 XTX')).toBe(false);
    // The driver names no memory size; the picker row does, and the two share a chip and a bus.
    expect(sameGpu('NVIDIA GeForce RTX 4060 Ti', 'GeForce RTX 4060 Ti 16 GB')).toBe(true);
    expect(sameGpu('Intel(R) Arc(TM) B580 Graphics', 'Arc B580 Graphics')).toBe(true);
  });

  it('a bench from another device falls back to the ceiling, a matching one replaces it', () => {
    expect(streamedBandwidth(bench('NVIDIA GeForce RTX 4090', 900), sameGpu('NVIDIA GeForce RTX 4090', box.gpuName), spec.bandwidthGBs)).toEqual({ gbs: 1792 * STREAM_EFFICIENCY, measured: false });
    expect(streamedBandwidth(bench('NVIDIA GeForce RTX 5090', 1611), sameGpu('NVIDIA GeForce RTX 5090', box.gpuName), spec.bandwidthGBs)).toEqual({ gbs: 1611, measured: true });
    // The dev box's own ceiling (thisCard.ts) replaces the reference in the estimate: the copy factor was measured against it.
    expect(streamedBandwidth(null, false, 2052)).toEqual({ gbs: 2052 * STREAM_EFFICIENCY, measured: false });
    expect(streamedBandwidth(null, false, null)).toBeNull();
  });

  it('the spec view carries the headline, the tiles and every published precision in the card order', () => {
    expect(spec.advertised).toMatchObject({ value: 3352, precision: 'fp4', sparse: true });
    expect(spec.tiles).toMatchObject({ die: 'GB202', shadingUnits: 21760, busBits: 512, memoryGbps: 28, suggestedPsuW: 1000 });
    expect(spec.fp32Tflops).toBe(104.8);
    expect(spec.denseDerived).toBe(false);
    expect(Object.keys(spec.tops)).toEqual(PRECISIONS.filter((p) => p !== 'int4'));
    expect(gpuSpecOf('GeForce RTX 5060')!.denseDerived).toBe(true);
    expect(gpuSpecOf('Radeon RX 9070 XT')!.tops.int4).toBe(779);
  });
});

describe('facts', () => {
  it('the snapshot gives a module-derived RAM bus and the card facts, the picker the tagged default and no card', () => {
    const snap = factsFromSnapshot(devbox(), null, null);
    expect(snap).toMatchObject({ ramBandwidthGBs: 99.2, ramBandwidthDefault: false });
    expect(snap.gpu?.powerMaxLimitMw).toBe(600000);
    expect(box).toMatchObject({ ramBandwidthGBs: 80, ramBandwidthDefault: true, gpu: null });
  });
});

describe('adviseRows on the dev box at 8k context', () => {
  const rows = adviseRows({ facts: box, bandwidthGBs, contextTokens: 8192, factor: DEFAULT_FACTOR });
  const by = (tag: string) => rows.find((r) => r.pullTag === tag)!;

  it('qwen3:4b runs fast at bandwidth / (4 x 0.56 GB) x the factor, on the copy rate rather than the datasheet', () => {
    const r = by('qwen3:4b');
    expect(r.bucket).toBe('fast');
    expect(r.tokPerSec!).toBeCloseTo(((1792 * 0.8) / (4.02 * 0.56)) * DEFAULT_FACTOR, 6);
    expect(r.quantLabel.toLowerCase()).toBe('q4_k_m');
    expect(r.contextCapped).toBe(false);
    expect(r.fitsNow).toBe(true);
  });

  it('llama3.3:70b spills into RAM and shows the cliff', () => {
    const r = by('llama3.3:70b');
    expect(r.bucket).toBe('slow');
    expect(r.requiredBytes).toBeGreaterThan(32 * 1024 ** 3);
    expect(r.tokPerSecOffloaded).not.toBeNull();
    expect(r.tokPerSecOffloaded!).toBeLessThan(r.tokPerSec! / 3);
    // A spilled model is judged after its cliff.
    expect(estimateFor(r)).toBe(r.tokPerSecOffloaded);
    expect(estimateFor(by('qwen3:4b'))).toBe(by('qwen3:4b').tokPerSec);
  });

  it('a calibrated factor scales every estimate, and no bandwidth blanks them', () => {
    const half = adviseRows({ facts: box, bandwidthGBs, contextTokens: 8192, factor: DEFAULT_FACTOR / 2 });
    expect(half.find((r) => r.pullTag === 'qwen3:4b')!.tokPerSec).toBeCloseTo(by('qwen3:4b').tokPerSec! / 2, 6);
    const blank = adviseRows({ facts: box, bandwidthGBs: null, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(blank.every((r) => r.tokPerSec === null)).toBe(true);
    expect(blank.find((r) => r.pullTag === 'qwen3:4b')!.bucket).toBe('fast');
  });

  it('qwen3.8:27b carries its MTP multiplier into the view, folded into tok/s and scaled by the factor like any row', () => {
    const r = by('qwen3.8:27b');
    expect(r.bucket).toBe('fast');
    expect(r.mtpAcceptedTokens).toBe(2.4);
    expect(r.tokPerSec!).toBeCloseTo((bandwidthGBs / (27.32 * 0.56)) * DEFAULT_FACTOR * 2.4, 6);
    expect(by('qwen3:4b').mtpAcceptedTokens).toBeNull();
    const half = adviseRows({ facts: box, bandwidthGBs, contextTokens: 8192, factor: DEFAULT_FACTOR / 2 });
    expect(half.find((x) => x.pullTag === 'qwen3.8:27b')!.tokPerSec).toBeCloseTo(r.tokPerSec! / 2, 6);
  });

  it('bestRows picks a fast row per use whose window holds the context, and leaves the rest null', () => {
    const picks = bestRows(rows);
    for (const tag of ['chat', 'coding', 'vision', 'reasoning'] as const) {
      expect(picks[tag]?.bucket).toBe('fast');
      expect(picks[tag]?.tags).toContain(tag);
    }
    // Largest first: the 30B-A3B vision model outranks Gemma 3 27B and the MTP row at 8k.
    expect(picks.vision?.pullTag).toBe('qwen3-vl:30b');
    expect(picks.chat?.pullTag).toBe('qwen3:32b');
    // At 128k the 40k-window rows cannot be the pick; Gemma's windowed cache keeps it fast and the MTP row takes reasoning.
    const wide = bestRows(adviseRows({ facts: box, bandwidthGBs, contextTokens: 131072, factor: DEFAULT_FACTOR }));
    expect(wide.chat?.pullTag).toBe('gemma3:27b');
    expect(wide.reasoning?.pullTag).toBe('qwen3.8:27b');
    expect(bestRows(rows.filter((r) => r.bucket !== 'fast')).chat).toBeNull();
  });

  it('derivedFactor is the median of measured over the estimate at factor 1, judging a spilled model after its cliff', () => {
    const est = { 'qwen3:4b': by('qwen3:4b'), 'llama3.1:8b': by('llama3.1:8b'), 'gemma3:4b': by('gemma3:4b'), 'llama3.3:70b': by('llama3.3:70b') };
    const at1 = (tag: keyof typeof est) => estimateFor(est[tag])! / DEFAULT_FACTOR;
    const run = (model: string, tokPerSec: number) => ({ model, tokPerSec, promptTokPerSec: 0, loadMs: 0, totalMs: 0 });
    const measured = {
      'qwen3:4b': run('qwen3:4b', 0.4 * at1('qwen3:4b')),
      'llama3.1:8b': run('llama3.1:8b', 0.5 * at1('llama3.1:8b')),
      'gemma3:4b': run('gemma3:4b', 0.9 * at1('gemma3:4b')),
      'not-in-table:1b': run('not-in-table:1b', 100)
    };
    expect(derivedFactor(measured, est, DEFAULT_FACTOR)).toBeCloseTo(0.5, 6);
    expect(derivedFactor({}, est, DEFAULT_FACTOR)).toBeNull();
    // The 70B was timed at 3 tok/s after its cliff: a 0.8 ratio against the offloaded figure, not 0.07 against the in-VRAM one.
    expect(derivedFactor({ 'llama3.3:70b': run('llama3.3:70b', 0.8 * at1('llama3.3:70b')) }, est, DEFAULT_FACTOR)).toBeCloseTo(0.8, 6);
    expect(FACTOR_BAND).toEqual([0.3, 1.0]);
  });

  it('a calibrated MTP model is shown on the card but left out of the derived factor', () => {
    const mtp = by('qwen3.8:27b');
    const plain = by('qwen3:4b');
    expect(inFactor(mtp)).toBe(false);
    expect(inFactor(plain)).toBe(true);
    expect(inFactor(undefined)).toBe(false);
    const run = (model: string, tokPerSec: number) => ({ model, tokPerSec, promptTokPerSec: 0, loadMs: 0, totalMs: 0 });
    const est = { 'qwen3:4b': plain, 'qwen3.8:27b': mtp };
    // The dev box's best run: 154 tok/s, a 1.46 ratio against the estimate at factor 1 before the multiplier.
    const measured = { 'qwen3:4b': run('qwen3:4b', 0.5 * (plain.tokPerSec! / DEFAULT_FACTOR)), 'qwen3.8:27b': run('qwen3.8:27b', 154) };
    expect(derivedFactor(measured, est, DEFAULT_FACTOR)).toBeCloseTo(0.5, 6);
    expect(derivedFactor({ 'qwen3.8:27b': measured['qwen3.8:27b'] }, est, DEFAULT_FACTOR)).toBeNull();
  });

  it('download size is judged against the drive when one is known', () => {
    expect(by('llama3.3:70b').downloadBytes).toBeGreaterThan(40 * GB);
    expect(by('llama3.3:70b').fitsOnDisk).toBe(true);
    const tiny = adviseRows({ facts: factsFromPicker({ gpuName: 'GeForce RTX 5090', ramGiB: 32, freeDiskGiB: 10 }, 32), bandwidthGBs: null, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(tiny.find((r) => r.pullTag === 'llama3.3:70b')!.fitsOnDisk).toBe(false);
  });
});
