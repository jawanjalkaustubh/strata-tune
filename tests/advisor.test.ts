import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_FACTOR, DEFAULT_RAM_BANDWIDTH_GBS, STREAM_EFFICIENCY, TIGHT_HEADROOM, advise, bestFor, factorFrom, kvBytes, ramBandwidthFromModules, ramBandwidthGBs,
  requiredBytes, tokPerSec, tokPerSecOffloaded, weightsBytes, type AdvisorInputs, type ModelSpec, type QuantSpec
} from '../src/analysis/advisor';
import { GPU_SPECS, lookupCpu, lookupGpu } from '../src/analysis/hardware-tables';
import modelsJson from '../src/data/models.json';
import { devbox } from './fixtures';

const GB = 1e9;
const GIB = 1024 ** 3;
const MODELS = modelsJson as ModelSpec[];

const spec = lookupGpu('NVIDIA GeForce RTX 5090', 32607)!;
const BANDWIDTH = spec.bandwidthGBs!;

/** The dev box: 32 GiB VRAM, 31 GiB usable RAM, DDR5-6200 dual channel, plenty of disk; bandwidth as the spec figure so the arithmetic below is legible. */
const devBoxInputs = (over: Partial<AdvisorInputs> = {}): AdvisorInputs => ({
  vramBytes: 32607 * 1024 ** 2,
  vramFreeBytes: (32607 - 3124) * 1024 ** 2,
  ramBytes: 31 * GIB,
  ramFreeBytes: 20 * GIB,
  gpuBandwidthGBs: BANDWIDTH,
  ramBandwidthGBs: ramBandwidthGBs(6200, 2),
  freeDiskBytes: 140 * GB,
  contextTokens: 8192,
  models: MODELS,
  ...over
});

/** Another card from the table, standalone: spec VRAM, the spec bandwidth scaled to what a copy reaches, the picker's default RAM. */
const cardInputs = (name: string, over: Partial<AdvisorInputs> = {}): AdvisorInputs => {
  const g = lookupGpu(name)!;
  return devBoxInputs({
    vramBytes: g.vramGiB * GIB,
    vramFreeBytes: g.vramGiB * GIB,
    ramBytes: 32 * GIB,
    ramFreeBytes: 32 * GIB,
    gpuBandwidthGBs: g.bandwidthGBs! * STREAM_EFFICIENCY,
    ramBandwidthGBs: DEFAULT_RAM_BANDWIDTH_GBS,
    ...over
  });
};

const find = (tag: string): { model: ModelSpec; quant: QuantSpec } => {
  for (const model of MODELS) {
    const quant = model.quants.find((q) => q.tag === tag);
    if (quant) return { model, quant };
  }
  throw new Error(`${tag} is not in models.json`);
};

const rowFor = (rows: ReturnType<typeof advise>, tag: string) => rows.find((r) => r.quant.tag === tag)!;
const USES = ['chat', 'coding', 'vision', 'reasoning'] as const;
const picks = (rows: ReturnType<typeof advise>) => Object.fromEntries(USES.map((u) => [u, bestFor(rows, u)?.quant.tag ?? null]));

describe('requiredBytes and tokPerSec, plan section 10', () => {
  it('the weights term is the pulled file, not the parameter count times the table: q4_K_M files carry q6/q8 output tensors', () => {
    const { model, quant } = find('qwen3:32b');
    // 20.0 GB on ollama.com against 32.8 B x 0.56 = 18.4 GB.
    expect(weightsBytes(model, quant)).toBe(20 * GB);
    expect(weightsBytes(model, quant)).toBeGreaterThan(model.paramsB * GB * quant.bytesPerWeight);
    // A vision model's download includes its projector blob once: subtracted from the weights, added back as the tower.
    const vl = find('qwen3-vl:30b');
    expect(weightsBytes(vl.model, vl.quant)).toBeCloseTo(20 * GB - 0.82 * GB, -3);
    expect(requiredBytes(vl.model, vl.quant, 0)).toBeCloseTo(20 * GB + 1.6 * GB, -3);
    for (const m of MODELS) for (const q of m.quants) expect(requiredBytes(m, q, 0)).toBeGreaterThanOrEqual(q.downloadBytes);
  });

  it('llama3.3:70b q4_K_M at 8k spills a 32 GiB card and the cliff is pinned to the formula', () => {
    const { model, quant } = find('llama3.3:70b');
    // 43 GB file + 2 x 80 layers x 8 KV heads x 128 x 8192 x 2 bytes = 2.68 GB of cache + 1.6 GB of reserves.
    expect(requiredBytes(model, quant, 8192)).toBeCloseTo(43 * GB + 2 * 80 * 8 * 128 * 8192 * 2 + 1.6 * GB, -3);
    const r = rowFor(advise(devBoxInputs()), 'llama3.3:70b');
    expect(r.bucket).toBe('slow');
    // In VRAM it would be 1792 / (70.6 x 0.56) x 0.5 = 22.7 tok/s.
    expect(r.tokPerSec).toBeCloseTo((BANDWIDTH / (70.6 * 0.56)) * CALIBRATION_FACTOR, 6);
    // 47.28 GB required on a 34.19 GB card: 13.09 GB (30.45 % of the file) streams from RAM at 99.2 GB/s.
    const spilled = r.requiredBytes - devBoxInputs().vramBytes;
    const fraction = spilled / (43 * GB);
    const seconds = 70.6 * 0.56 * ((1 - fraction) / BANDWIDTH + fraction / 99.2);
    expect(r.tokPerSecOffloaded).toBeCloseTo(CALIBRATION_FACTOR / seconds, 6);
    expect(r.tokPerSecOffloaded).toBeCloseTo(3.66, 2);
    // The cliff meets the in-VRAM figure as the spill goes to zero, and a fully spilled model runs at the RAM rate.
    expect(tokPerSecOffloaded(model, quant, 0, BANDWIDTH, 99.2)).toBeCloseTo(r.tokPerSec, 6);
    expect(tokPerSecOffloaded(model, quant, 43 * GB, BANDWIDTH, 99.2)).toBeCloseTo((99.2 / (70.6 * 0.56)) * CALIBRATION_FACTOR, 6);
  });

  it('qwen3:4b q4_K_M runs fast; the factor is the dev box measurement, so the estimate lands on it at the measured bandwidth', () => {
    const { model, quant } = find('qwen3:4b');
    // docs/phase3-calibration.md: 356.5 tok/s measured on the worker's 1611 GB/s against 1611 / (4.02 x 0.56) at factor 1.
    expect(CALIBRATION_FACTOR).toBeCloseTo(356.5 / (1611 / (4.02 * 0.56)), 1);
    expect(tokPerSec(model, quant, 1611)).toBeCloseTo(356.5, -1);
    // A card nobody measured runs on spec x what a copy reaches: 1792 x 0.8 / 2.25 GB x 0.5 = 318, not 398.
    expect(tokPerSec(model, quant, BANDWIDTH * STREAM_EFFICIENCY)).toBeCloseTo((1792 * 0.8 * CALIBRATION_FACTOR) / (4.02 * 0.56), 6);
    expect(tokPerSec(model, quant, BANDWIDTH * STREAM_EFFICIENCY)).toBeLessThan(330);
    expect(rowFor(advise(devBoxInputs()), 'qwen3:4b').bucket).toBe('fast');
  });

  it('qwen3-vl:30b is sized by its 20 GB file plus the vision tower but paced by its 3.3 B active experts', () => {
    const { model, quant } = find('qwen3-vl:30b');
    const dense = find('qwen3:32b');
    const req = requiredBytes(model, quant, 8192);
    expect(req).toBeGreaterThan(20 * GB);
    expect(req).toBeLessThan(requiredBytes(dense.model, dense.quant, 8192));
    // 1792 / (3.3 x 0.56) x the factor: a MoE decodes like a 3 B model on the bandwidth bound.
    expect(tokPerSec(model, quant, 1792)).toBeCloseTo((1792 / (3.3 * 0.56)) * CALIBRATION_FACTOR, 6);
    expect(tokPerSec(model, quant, 1792)).toBeGreaterThan(9 * tokPerSec(dense.model, dense.quant, 1792));
  });

  it('qwen3.8:27b is paced as a 27 B dense model, then multiplied by its accepted MTP draft length', () => {
    const { model, quant } = find('qwen3.8:27b');
    expect(model.mtpAcceptedTokens).toBe(2.4);
    // 1611 / (27.32 x 0.56) x 0.5 = 53 forward passes per second; x 2.4 accepted tokens per pass lands inside the measured 101–154 tok/s.
    const est = tokPerSec(model, quant, 1611);
    expect(est).toBeCloseTo((1611 / (27.32 * 0.56)) * CALIBRATION_FACTOR * 2.4, 6);
    expect(est).toBeGreaterThan(101);
    expect(est).toBeLessThan(154);
    // The offloaded leg carries the same multiplier: a 20 GB card spills the q8_0 and its cliff figure is still per token emitted.
    const spilled = rowFor(advise(devBoxInputs({ vramBytes: 20 * GB, vramFreeBytes: 20 * GB })), 'qwen3.8:27b-q8_0');
    expect(spilled.bucket).toBe('slow');
    const plain = { ...model, mtpAcceptedTokens: undefined };
    const plainSpilled = rowFor(advise(devBoxInputs({ vramBytes: 20 * GB, vramFreeBytes: 20 * GB, models: [plain] })), 'qwen3.8:27b-q8_0');
    expect(spilled.tokPerSecOffloaded!).toBeCloseTo(plainSpilled.tokPerSecOffloaded! * 2.4, 6);
  });

  it('the KV cache counts only the blocks that grow with context: qwen3.8 keeps 16 of 65, Gemma 3 27B 10 of 62 plus a 1024-token window on the rest', () => {
    const { model } = find('qwen3.8:27b');
    const gemma = find('gemma3:27b').model;
    const perToken = (m: ModelSpec) => kvBytes(m, 16384) - kvBytes(m, 8192);
    // 2 x 16 layers x 4 KV heads x 256 x 2 bytes = 64 KiB per token; Gemma's 2 x 10 x 16 x 128 x 2 = 80 KiB, the 52 windowed blocks add nothing past 1024.
    expect(perToken(model)).toBe(2 * 16 * 4 * 256 * 8192 * 2);
    expect(perToken(gemma)).toBe(2 * 10 * 16 * 128 * 8192 * 2);
    expect(kvBytes(gemma, 32768)).toBe(2 * 16 * 128 * 2 * (10 * 32768 + 52 * 1024));
    // Below the window every block grows alike.
    expect(kvBytes(gemma, 512)).toBe(2 * 16 * 128 * 2 * 62 * 512);
    // gpt-oss: 12 full blocks, 12 on a 128-token window.
    const oss = find('gpt-oss:20b').model;
    expect(kvBytes(oss, 8192)).toBe(2 * 8 * 64 * 2 * (12 * 8192 + 12 * 128));
  });

  it('gpt-oss:120b will not run on 32 GiB VRAM plus 31 GiB RAM: 65 GB of MXFP4 weights exceed VRAM + 0.8 x RAM', () => {
    const r = rowFor(advise(devBoxInputs()), 'gpt-oss:120b');
    expect(r.requiredBytes).toBeGreaterThan(65 * GB);
    expect(r.requiredBytes).toBeGreaterThan(32607 * 1024 ** 2 + 31 * GIB * 0.8);
    expect(r.bucket).toBe('no');
    expect(r.fitsNow).toBe(false);
    // The 20 B sibling fits easily and is paced by 3.6 B active parameters.
    const small = rowFor(advise(devBoxInputs()), 'gpt-oss:20b');
    expect(small.bucket).toBe('fast');
    expect(small.tokPerSec).toBeCloseTo((BANDWIDTH / (3.6 * small.quant.bytesPerWeight)) * CALIBRATION_FACTOR, 6);
  });

  it('a larger KV element (fp32 cache) grows only the cache term', () => {
    const { model, quant } = find('qwen3:32b');
    const kv16 = requiredBytes(model, quant, 8192, 2);
    const kv32 = requiredBytes(model, quant, 8192, 4);
    expect(kv32 - kv16).toBeCloseTo(2 * 64 * 8 * 128 * 8192 * 2, 0);
  });

  it('the context is capped at the model window, so the slider cannot push phi4 past 16k', () => {
    const { model, quant } = find('phi4:14b');
    expect(requiredBytes(model, quant, 16384)).toBe(requiredBytes(model, quant, 131072));
  });
});

describe('buckets', () => {
  /** A synthetic 10 B dense model whose weights are exactly 10 GB at 1 byte per weight, no KV cache at zero context. */
  const synthetic: ModelSpec = {
    name: 'Synthetic 10B', family: 'test', tags: ['chat'], paramsB: 10, activeParamsB: 10, layers: 1, kvHeads: 1, headDim: 1, hiddenSize: 1,
    maxContext: 1, visionEncoderGB: 0, source: 'test', quants: [{ tag: 'synthetic:10b', quant: 'q8_0', bytesPerWeight: 1, downloadBytes: 10 * GB }]
  };
  // weights 10 GB + KV 2 x 1 x 1 x 1 x 1 x 2 bytes + 0.6 + 1.0 GB reserves.
  const required = 11.6 * GB + 4;
  const at = (vramBytes: number, ramBytes = 0) =>
    advise({ ...devBoxInputs(), vramBytes, vramFreeBytes: vramBytes, ramBytes, ramFreeBytes: ramBytes, contextTokens: 1, models: [synthetic] })[0];

  it('fast needs 1.5 GiB of headroom (the unit the page prints), tight is anything less that still fits', () => {
    expect(TIGHT_HEADROOM).toBe(1.5 * GIB);
    expect(at(required + 1.5 * GIB).bucket).toBe('fast');
    expect(at(required + 1.5 * GIB - 1).bucket).toBe('tight');
    expect(at(required).bucket).toBe('tight');
    expect(at(required).headroomBytes).toBe(0);
  });

  it('slow spills into 80 % of RAM, no is beyond that', () => {
    expect(at(required - 1, 0).bucket).toBe('no');
    expect(at(required - 1 * GB, 1.25 * GB).bucket).toBe('slow');
    expect(at(required - 1 * GB, 1.25 * GB - 1).bucket).toBe('no');
  });

  it('fitsNow judges free memory, the bucket judges totals', () => {
    const busy = advise({ ...devBoxInputs(), vramBytes: required + 2 * GB, vramFreeBytes: required - 1, models: [synthetic], contextTokens: 1 })[0];
    expect(busy.bucket).toBe('fast');
    expect(busy.fitsNow).toBe(false);
  });

  it('the context slider moves deepseek-r1:32b q4_K_M from fast through tight to slow on 32 GiB', () => {
    const { model, quant } = find('deepseek-r1:32b');
    const bucketAt = (contextTokens: number) => rowFor(advise(devBoxInputs({ contextTokens })), quant.tag).bucket;
    expect(bucketAt(8192)).toBe('fast');
    // 64 layers x 8 KV heads x 128 x 2 x 2 bytes = 256 KiB per token: 44k of context is 11 GiB on top of the 20 GB file.
    expect(bucketAt(45056)).toBe('tight');
    expect(bucketAt(49152)).toBe('slow');
    expect(requiredBytes(model, quant, 49152) - requiredBytes(model, quant, 8192)).toBe(2 * 64 * 8 * 128 * (49152 - 8192) * 2);
  });

  it('Gemma 3 12B fits a 12 GiB card at 8k with its windowed cache: 9.8 GiB, fast, where counting every block as full attention said tight', () => {
    const r = rowFor(advise(cardInputs('GeForce RTX 5070')), 'gemma3:12b');
    expect(r.requiredBytes / GIB).toBeCloseTo(9.85, 1);
    expect(r.bucket).toBe('fast');
    // Gemma 3 27B at 32k on the dev box: 20.2 GiB, still fast; the old formula charged 16 GB of cache and called it slow.
    expect(rowFor(advise(devBoxInputs({ contextTokens: 32768 })), 'gemma3:27b').requiredBytes / GIB).toBeCloseTo(20.2, 1);
    expect(rowFor(advise(devBoxInputs({ contextTokens: 32768 })), 'gemma3:27b').bucket).toBe('fast');
  });
});

describe('advise ordering, bestFor and calibration', () => {
  const rows = advise(devBoxInputs());

  it('largest model that still runs fast comes first, then tight, slow, no: a 30B-A3B ranks as a 30B', () => {
    const order = { fast: 0, tight: 1, slow: 2, no: 3 };
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      expect(order[a.bucket]).toBeLessThanOrEqual(order[b.bucket]);
      if (a.bucket === b.bucket) expect(a.model.paramsB).toBeGreaterThanOrEqual(b.model.paramsB);
    }
    expect(rows[0].bucket).toBe('fast');
    expect(rows[0].model.paramsB).toBe(32.8);
    const fast = rows.filter((r) => r.bucket === 'fast').map((r) => r.quant.tag);
    expect(fast.indexOf('qwen3-vl:30b')).toBeLessThan(fast.indexOf('gemma3:27b'));
    expect(fast.indexOf('gemma3:27b')).toBeLessThan(fast.indexOf('qwen3:4b'));
  });

  it('bestFor on the dev box at 8k: the 32B rows for chat, coding and reasoning, the 30B-A3B vision model for vision', () => {
    expect(picks(rows)).toEqual({ chat: 'qwen3:32b', coding: 'qwen3:32b', vision: 'qwen3-vl:30b', reasoning: 'qwen3:32b' });
    for (const tag of USES) expect(bestFor(rows, tag)!.tokPerSec).toBeGreaterThan(0);
    expect(bestFor(rows, 'embedding')).toBeNull();
  });

  it('bestFor per card: a MoE row wins a 24 GB card at 32k, a 12 GiB card takes Gemma 3 12B for vision', () => {
    expect(picks(advise(cardInputs('GeForce RTX 4090')))).toEqual({ chat: 'qwen3:32b', coding: 'qwen3:32b', vision: 'qwen3-vl:30b', reasoning: 'qwen3:32b' });
    // 32k of cache pushes the dense 32B rows off a 24 GB card; the 30B-A3B's 4 KV heads keep it fast.
    expect(picks(advise(cardInputs('GeForce RTX 4090', { contextTokens: 32768 })))).toEqual({ chat: 'qwen3:30b-a3b', coding: 'qwen3:30b-a3b', vision: 'gemma3:27b', reasoning: 'qwen3:30b-a3b' });
    expect(picks(advise(cardInputs('GeForce RTX 5070')))).toEqual({ chat: 'gemma3:12b', coding: 'llama3.1:8b', vision: 'gemma3:12b', reasoning: 'deepseek-r1:8b' });
    expect(picks(advise(cardInputs('GeForce RTX 5060')))).toEqual({ chat: 'gemma3:4b', coding: 'qwen2.5-coder:7b', vision: 'gemma3:4b', reasoning: 'qwen3:4b' });
  });

  it('a pick must hold the context asked for: at 128k the 40k-window 32B rows step aside, at 256k nothing runs fast', () => {
    const wide = advise(devBoxInputs({ contextTokens: 131072 }));
    expect(rowFor(wide, 'qwen3:32b').contextCapped).toBe(true);
    expect(rowFor(wide, 'qwen3:32b').bucket).toBe('fast');
    expect(picks(wide)).toEqual({ chat: 'gemma3:27b', coding: 'gemma3:27b', vision: 'gemma3:27b', reasoning: 'qwen3.8:27b' });
    const widest = advise(devBoxInputs({ contextTokens: 262144 }));
    expect(picks(widest)).toEqual({ chat: null, coding: null, vision: null, reasoning: null });
    expect(rowFor(widest, 'gemma3:27b').contextCapped).toBe(true);
    expect(rowFor(rows, 'qwen3:32b').contextCapped).toBe(false);
  });

  it('factorFrom is the median of measured over the estimate at factor 1', () => {
    const at1 = (tag: string) => {
      const { model, quant } = find(tag);
      return { model, quant, estimate: tokPerSec(model, quant, BANDWIDTH, 1) };
    };
    const a = at1('qwen3:4b');
    const b = at1('llama3.1:8b');
    const c = at1('gemma3:4b');
    const measurements = [
      { model: a.model, quant: a.quant, measuredTokS: 0.4 * a.estimate },
      { model: b.model, quant: b.quant, measuredTokS: 0.5 * b.estimate },
      { model: c.model, quant: c.quant, measuredTokS: 0.9 * c.estimate }
    ];
    expect(factorFrom(measurements, BANDWIDTH)).toBeCloseTo(0.5, 6);
    expect(factorFrom(measurements.slice(0, 2), BANDWIDTH)).toBeCloseTo(0.45, 6);
    expect(factorFrom([], BANDWIDTH)).toBeNull();
    expect(factorFrom([{ model: a.model, quant: a.quant, measuredTokS: 0 }], BANDWIDTH)).toBeNull();
  });

  it('an MTP model is left out of the factor: its 1.46 ratio on the dev box would otherwise drag the median towards 1', () => {
    const plain = find('qwen3:4b');
    const mtp = find('qwen3.8:27b');
    const at1 = tokPerSec(plain.model, plain.quant, 1611, 1);
    const measurements = [
      { ...plain, measuredTokS: 0.5 * at1 },
      // 154 tok/s measured against 105 at factor 1 without the multiplier.
      { ...mtp, measuredTokS: 154 }
    ];
    expect(factorFrom(measurements, 1611)).toBeCloseTo(0.5, 6);
    expect(factorFrom([measurements[1]], 1611)).toBeNull();
  });

  it('an unknown GPU still gets advice from an explicit bandwidth figure', () => {
    expect(lookupGpu('Some Future Card 9000')).toBeNull();
    const unknown = advise(devBoxInputs({ vramBytes: 48 * GIB, vramFreeBytes: 48 * GIB, gpuBandwidthGBs: 1000 }));
    expect(unknown.length).toBe(rows.length);
    expect(rowFor(unknown, 'llama3.3:70b').bucket).toBe('fast');
    expect(rowFor(unknown, 'qwen3:4b').tokPerSec).toBeCloseTo((1000 / (4.02 * 0.56)) * CALIBRATION_FACTOR, 6);
  });

  it('download size is judged against the model drive', () => {
    expect(rowFor(rows, 'llama3.3:70b').fitsOnDisk).toBe(true);
    expect(rowFor(advise(devBoxInputs({ freeDiskBytes: 10 * GB })), 'llama3.3:70b').fitsOnDisk).toBe(false);
    expect(rowFor(advise(devBoxInputs({ freeDiskBytes: null })), 'llama3.3:70b').fitsOnDisk).toBe(true);
  });
});

describe('RAM bandwidth', () => {
  it('is 8 bytes per transfer per channel: DDR5-6000 dual is 96 GB/s, 6200 is 99.2, DDR4-3200 dual is 51.2', () => {
    expect(ramBandwidthGBs(6000, 2)).toBe(96);
    expect(ramBandwidthGBs(6200, 2)).toBeCloseTo(99.2, 6);
    expect(ramBandwidthGBs(4800, 1)).toBeCloseTo(38.4, 6);
    expect(ramBandwidthGBs(3200, 2)).toBeCloseTo(51.2, 6);
  });

  it('reads the dev box snapshot: two DIMMs at 6200 MT/s; no module rows means the default', () => {
    expect(ramBandwidthFromModules(devbox().ram.modules)).toBeCloseTo(99.2, 6);
    expect(ramBandwidthFromModules([])).toBe(DEFAULT_RAM_BANDWIDTH_GBS);
  });
});

describe('gpus.json lookups', () => {
  it('matches NVML names and tells variants apart', () => {
    expect(lookupGpu('NVIDIA GeForce RTX 5090', 32607)?.name).toBe('GeForce RTX 5090');
    expect(lookupGpu('NVIDIA GeForce RTX 4070')?.name).toBe('GeForce RTX 4070');
    expect(lookupGpu('NVIDIA GeForce RTX 4070 Ti')?.name).toBe('GeForce RTX 4070 Ti');
    expect(lookupGpu('NVIDIA GeForce RTX 4070 SUPER')?.name).toBe('GeForce RTX 4070 Super');
    expect(lookupGpu('NVIDIA GeForce RTX 4070 Ti SUPER')?.name).toBe('GeForce RTX 4070 Ti Super');
    expect(lookupGpu('AMD Radeon RX 7900 XT')?.name).toBe('Radeon RX 7900 XT');
    expect(lookupGpu('AMD Radeon RX 7900 XTX')?.name).toBe('Radeon RX 7900 XTX');
    expect(lookupGpu('Intel(R) Arc(TM) B580 Graphics')?.name).toBe('Arc B580');
  });

  it('memory variants are picked by the VRAM total, and a size that matches no variant is unknown', () => {
    expect(lookupGpu('NVIDIA GeForce RTX 4060 Ti', 16380)?.name).toBe('GeForce RTX 4060 Ti 16 GB');
    expect(lookupGpu('NVIDIA GeForce RTX 4060 Ti', 8188)?.name).toBe('GeForce RTX 4060 Ti 8 GB');
    expect(lookupGpu('NVIDIA GeForce RTX 3080', 10240)?.name).toBe('GeForce RTX 3080 10 GB');
    expect(lookupGpu('NVIDIA GeForce RTX 3080', 12288)?.name).toBe('GeForce RTX 3080 12 GB');
    expect(lookupGpu('NVIDIA GeForce RTX 3060', 8192)).toBeNull();
    expect(lookupGpu('NVIDIA GeForce RTX 4060 Ti')?.name).toBe('GeForce RTX 4060 Ti 16 GB');
  });

  it('the picker name is exact, laptop parts and unknown cards are null', () => {
    expect(lookupGpu('GeForce RTX 4060 Ti 8 GB')?.vramGiB).toBe(8);
    expect(lookupGpu('NVIDIA GeForce RTX 4070 Laptop GPU')).toBeNull();
    expect(lookupGpu('NVIDIA GeForce RTX 5090 D')).toBeNull();
    expect(lookupGpu('NVIDIA GeForce GTX 1080 Ti')).toBeNull();
  });

  it('every row is sourced, dense never exceeds sparse, and bandwidth agrees with the memory data rate and bus', () => {
    for (const g of GPU_SPECS) {
      expect(g.source).toMatch(/^https:\/\/(images\.nvidia\.com|www\.nvidia\.com|www\.amd\.com|www\.intel\.com)\//);
      expect(g.tpuUrl).toMatch(/^https:\/\/www\.techpowerup\.com\/gpu-specs\/[a-z0-9-]+\.c\d+$/);
      expect(g.vramGiB).toBeGreaterThan(0);
      expect(g.tdpW).toBeGreaterThan(0);
      expect(g.shadingUnits).toBeGreaterThan(0);
      expect(g.fp32Tflops).toBeGreaterThan(0);
      expect(g.bandwidthGBs).not.toBeNull();
      // The reference bus: effective data rate x width, to the rounding the vendor prints.
      expect(Math.abs(g.bandwidthGBs! - (g.memoryGbps * g.busBits) / 8) / g.bandwidthGBs!).toBeLessThan(0.01);
      for (const p of ['fp16', 'bf16', 'tf32', 'fp8', 'int8', 'fp4', 'int4'] as const) {
        const sparse = g.tops.sparse[p];
        // Vendors round dense and sparse separately (AMD: 195 against 389).
        if (sparse !== undefined) expect(Math.abs(g.tops[p]! - sparse / 2)).toBeLessThanOrEqual(1);
      }
      if (g.denseDerived) expect(g.notes).toMatch(/dense is half/);
    }
    expect(lookupGpu('NVIDIA GeForce RTX 4070 SUPER')!.bandwidthGBs).toBe(504);
    expect(lookupGpu('NVIDIA GeForce RTX 3060', 12288)!.bandwidthGBs).toBe(360);
    expect(lookupGpu('NVIDIA GeForce RTX 5090')!.tops).toEqual({
      fp16: 419, bf16: 209.5, tf32: 104.8, fp8: 838, int8: 838, fp4: 1676,
      sparse: { fp16: 838, bf16: 419, tf32: 209.5, fp8: 1676, int8: 1676, fp4: 3352 }
    });
  });

  it('the advertised AI TOPS is the vendor headline with its precision and sparsity, and null where the vendor prints none', () => {
    const advertised = GPU_SPECS.filter((g) => g.advertisedAiTops !== null);
    for (const g of advertised) {
      const a = g.advertisedAiTops!;
      expect(a.value).toBeGreaterThan(0);
      expect(a.source).toMatch(/^https:\/\/(www\.nvidia\.com|www\.amd\.com|www\.intel\.com)\//);
      // The headline is the sparse figure of that precision (NVIDIA, AMD) or the only figure (Intel, no qualifier), to the vendor's rounding (987.8 in the whitepaper, 988 on the compare page).
      const table = a.sparse === true ? g.tops.sparse[a.precision] : g.tops[a.precision];
      expect(Math.abs(table! - a.value)).toBeLessThanOrEqual(1);
    }
    expect(lookupGpu('NVIDIA GeForce RTX 5090')!.advertisedAiTops).toEqual({ value: 3352, precision: 'fp4', sparse: true, source: 'https://www.nvidia.com/en-us/geforce/graphics-cards/compare/' });
    expect(lookupGpu('AMD Radeon RX 9070 XT')!.advertisedAiTops).toMatchObject({ value: 1557, precision: 'int4', sparse: true });
    expect(lookupGpu('Intel(R) Arc(TM) B580 Graphics')!.advertisedAiTops).toMatchObject({ value: 233, precision: 'int8', sparse: null });
    expect(lookupGpu('NVIDIA GeForce RTX 3090')!.advertisedAiTops).toBeNull();
    expect(lookupGpu('AMD Radeon RX 7900 XTX')!.advertisedAiTops).toBeNull();
    expect(advertised.length).toBe(21);
  });

  it('the spec tiles carry the TechPowerUp figures and the vendor power recommendation', () => {
    const g = lookupGpu('NVIDIA GeForce RTX 5090')!;
    expect(g).toMatchObject({ die: 'GB202', shadingUnits: 21760, tmus: 680, rops: 176, vramType: 'GDDR7', busBits: 512, memoryGbps: 28, baseMhz: 2010, boostMhz: 2407, fp32Tflops: 104.8, suggestedPsuW: 1000 });
    expect(lookupGpu('AMD Radeon RX 7900 GRE')!.suggestedPsuW).toBeNull();
    expect(lookupGpu('AMD Radeon RX 9070 XT')!).toMatchObject({ baseMhz: null, fp32Tflops: 48.7, suggestedPsuW: 750, die: 'Navi 48' });
  });
});

describe('cpus.json lookups', () => {
  it('desktop parts carry cores, threads and TDP with no NPU', () => {
    expect(lookupCpu(devbox().cpu.name)).toMatchObject({ model: '9950X', cores: 16, threads: 32, boostMhz: 5700, tdpW: 170, npuTops: null });
    expect(lookupCpu('AMD Ryzen 9 9950X3D 16-Core Processor')?.model).toBe('9950X3D');
    expect(lookupCpu('Intel(R) Core(TM) i9-14900K')).toMatchObject({ cores: 24, threads: 32, npuTops: null });
    expect(lookupCpu('Intel(R) Core(TM) Ultra 9 285K')).toMatchObject({ cores: 24, threads: 24, npuTops: 13 });
  });

  it('laptop parts carry the vendor NPU figure', () => {
    expect(lookupCpu('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')).toMatchObject({ cores: 12, threads: 24, tdpW: 28, npuTops: 50 });
    expect(lookupCpu('AMD RYZEN AI MAX+ 395 w/ Radeon 8060S')).toMatchObject({ cores: 16, threads: 32, npuTops: 50 });
    expect(lookupCpu('Intel(R) Core(TM) Ultra 7 258V')).toMatchObject({ cores: 8, threads: 8, npuTops: 47 });
    expect(lookupCpu('Intel(R) Core(TM) Ultra 9 285H')).toMatchObject({ cores: 16, threads: 16, npuTops: 13 });
  });

  it('a row with only Monitor limits, or no row, is null', () => {
    expect(lookupCpu('AMD Ryzen 9 9900X 12-Core Processor')).toBeNull();
    expect(lookupCpu('AMD Ryzen 7 8700G w/ Radeon 780M Graphics')).toBeNull();
  });
});

describe('models.json integrity', () => {
  it('every pull tag is unique, every quant sized, MoE rows have fewer active than total parameters', () => {
    const tags = MODELS.flatMap((m) => m.quants.map((q) => q.tag));
    expect(new Set(tags).size).toBe(tags.length);
    for (const m of MODELS) {
      expect(m.source).toMatch(/^https:\/\/ollama\.com\/library\//);
      expect(m.activeParamsB).toBeLessThanOrEqual(m.paramsB);
      expect(m.layers * m.kvHeads * m.headDim).toBeGreaterThan(0);
      if (m.swa) {
        expect(m.swa.layers).toBeGreaterThan(0);
        expect(m.swa.window).toBeGreaterThan(0);
        expect(m.swa.window).toBeLessThan(m.maxContext);
      }
      for (const q of m.quants) {
        expect(q.downloadBytes).toBeGreaterThan(0);
        expect(q.bytesPerWeight).toBeGreaterThanOrEqual(0.5);
        expect(q.bytesPerWeight).toBeLessThanOrEqual(2);
        // The file and the table agree to the q6/q8 output tensors a quant carries (up to +32 % on the smallest QAT file) and to a vision tower counted in paramsB (-10 %).
        const ratio = (q.downloadBytes - m.visionEncoderGB * GB) / (m.paramsB * GB * q.bytesPerWeight);
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.35);
      }
      // A multiplier of 1 or less would be a plain-decode row wearing the tag.
      if (m.mtpAcceptedTokens !== undefined) expect(m.mtpAcceptedTokens).toBeGreaterThan(1);
    }
    expect(MODELS.filter((m) => m.mtpAcceptedTokens !== undefined).map((m) => m.name)).toEqual(['Qwen3.8 27B']);
    expect(MODELS.filter((m) => m.swa).map((m) => m.name)).toEqual(['Gemma 3 27B', 'Gemma 3 12B', 'Gemma 3 4B', 'gpt-oss 20B', 'gpt-oss 120B']);
    expect(find('gemma3:27b').model).toMatchObject({ layers: 10, swa: { layers: 52, window: 1024 } });
    expect(find('qwen3:30b-a3b').model.activeParamsB).toBe(3.3);
    expect(find('gpt-oss:20b').model.activeParamsB).toBe(3.6);
    expect(find('qwen3:32b').model.activeParamsB).toBe(32.8);
  });
});
