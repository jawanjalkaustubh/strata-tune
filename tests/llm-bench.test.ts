import { describe, expect, it } from 'vitest';
import {
  COLUMNS, DEPTHS, LLM_PROTOCOL, PROMPT_BODY, atDepth, bestBenchy, bestOf, fillerForDepth, groupBenchy, groupByModel, median, numCtxFor, parseBenchFile, parseBenchyJson, promptForRun, std, summarise, supersede, validBenchy, validResult,
  type BenchyResult,
  type LlmBenchResult, type LlmMachine, type LlmModel, type LlmRun
} from '../src/analysis/llm-bench';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveIds, tokenizerFor } from '../electron/llm-bench';
import { sensorsOf, type MacmonSample } from '../electron/mac/sensors';
import { devboxMeta } from './fixtures';

const macmon = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mac', 'macmon.sample.json'), 'utf8')) as MacmonSample;
const macMeta = () => sensorsOf('Apple M5 Max', macmon, { usedMiB: 847, totalMiB: 38338 }, null).meta;

const pc: LlmMachine = { hostname: 'DESKTOP', os: 'Windows', gpuName: 'NVIDIA GeForce RTX 5090', cpuName: 'AMD Ryzen 9 9950X3D', ramBytes: 64 * 1024 ** 3, vramBytes: 32 * 1024 ** 3, unified: false, driver: '581.29' };
const mac: LlmMachine = { hostname: 'MacBook-Pro', os: 'macOS', gpuName: 'Apple M5 Max (40-core GPU)', cpuName: 'Apple M5 Max', ramBytes: 128 * 1024 ** 3, vramBytes: 96 * 1024 ** 3, unified: true, driver: null };
const qwen: LlmModel = { name: 'qwen3.8:27b', parameterSize: '27B', quantization: 'Q4_K_M', family: 'qwen3', sizeBytes: 17 * 1024 ** 3 };

/** A run whose counters give the stated tok/s exactly. */
const run = (gen: number, prefill: number, over: Partial<LlmRun> = {}): LlmRun => ({
  promptEvalCount: 1000,
  promptEvalMs: (1000 / prefill) * 1000,
  evalCount: 256,
  evalMs: (256 / gen) * 1000,
  loadMs: 900,
  totalMs: 5000,
  ...over
});

const result = (machine: LlmMachine, gen: number, prefill: number, gpuW: number | null, systemW: number | null, id = machine.hostname): LlmBenchResult =>
  summarise({
    id,
    measuredAt: '2026-09-20T10:00:00Z',
    machine,
    model: qwen,
    runs: [run(gen, prefill, { loadMs: 3200 }), run(gen * 1.02, prefill * 0.98, { loadMs: 10 }), run(gen * 0.99, prefill, { loadMs: 12 })],
    idle: [{ gpuW: gpuW === null ? null : gpuW / 10, cpuW: 5, systemW: systemW === null ? null : systemW / 4, gpuMemMiB: 1024 }],
    busy: [
      { gpuW, cpuW: 20, systemW, gpuMemMiB: 18_000 },
      { gpuW: gpuW === null ? null : gpuW + 40, cpuW: 24, systemW: systemW === null ? null : systemW + 10, gpuMemMiB: 18_400 }
    ],
    residentBytes: 17.4 * 1024 ** 3
  });

describe('the LLM benchmark protocol', () => {
  it('the prompt is long enough to time a prefill and differs by run so the KV prefix cache cannot answer it', () => {
    // Roughly four characters per token: a thousand tokens wants four thousand characters or so.
    expect(PROMPT_BODY.length).toBeGreaterThan(3500);
    expect(PROMPT_BODY).not.toMatch(/^\s*$/);
    const a = promptForRun(1, 3);
    const b = promptForRun(2, 3);
    expect(a).not.toBe(b);
    expect(a.startsWith('Benchmark run 1 of 3 at depth 0.')).toBe(true);
    expect(a.endsWith(PROMPT_BODY)).toBe(true);
  });

  it('median: the middle of odd, the mean of the middle pair of even, zero of nothing', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('summarise', () => {
  it('folds Ollama counters into medians, the cold load from run 1, and watts from the samples', () => {
    const r = result(pc, 100, 5000, 400, null);
    expect(r.protocol).toBe(LLM_PROTOCOL);
    expect(r.genTokPerSec).toBeCloseTo(100, 5);
    expect(r.prefillTokPerSec).toBeCloseTo(5000, 5);
    expect(r.loadMs).toBe(3200);
    expect(r.firstTokenMs).toBeCloseTo(200, 5);
    expect(r.settings).toEqual({ promptTokens: 1000, predictTokens: 256, numCtx: 4096, runs: 3 });
    expect(r.power.gpuAvgW).toBe(420);
    expect(r.power.gpuPeakW).toBe(440);
    expect(r.power.gpuIdleW).toBe(40);
    expect(r.power.cpuAvgW).toBe(22);
    // A PC has no whole-system sensor: the column stays empty rather than zero.
    expect(r.power.systemAvgW).toBeNull();
    expect(r.efficiency.tokPerSecPerSystemW).toBeNull();
    expect(r.efficiency.tokPerSecPerGpuW).toBeCloseTo(100 / 420, 6);
    expect(r.memory.residentBytes).toBeCloseTo(17.4 * 1024 ** 3, 0);
    expect(r.memory.gpuUsedPeakMiB).toBe(18_400);
    expect(r.memory.gpuUsedIdleMiB).toBe(1024);
    expect(r.imported).toBe(false);
  });

  it('without a collector every watt and memory figure is null and the tokens still stand', () => {
    const r = summarise({ id: 'x', measuredAt: '2026-09-20T10:00:00Z', machine: mac, model: qwen, runs: [run(30, 600)], idle: [], busy: [], residentBytes: null });
    expect(r.genTokPerSec).toBeCloseTo(30, 5);
    expect(r.power).toEqual({ gpuIdleW: null, gpuAvgW: null, gpuPeakW: null, cpuAvgW: null, systemIdleW: null, systemAvgW: null, systemPeakW: null });
    expect(r.efficiency).toEqual({ tokPerSecPerGpuW: null, tokPerSecPerSystemW: null });
    expect(r.memory.residentBytes).toBeNull();
  });
});

describe('the comparison', () => {
  const a = result(pc, 100, 5000, 420, null, 'pc');
  const b = result(mac, 32, 700, 40, 90, 'mac');

  it('groups rows by model tag, newest first, and marks the best of each column; a column only one side reports has no winner', () => {
    const groups = groupByModel([a, { ...b, measuredAt: '2026-09-21T10:00:00Z' }]);
    expect(groups.map((g) => g.model)).toEqual(['qwen3.8:27b']);
    expect(groups[0].results.map((r) => r.id)).toEqual(['mac', 'pc']);
    const best = bestOf([a, b]);
    expect(best.gen.has('pc')).toBe(true);
    expect(best.gen.has('mac')).toBe(false);
    expect(best.prefill.has('pc')).toBe(true);
    // Lower is better for watts and the load; the Mac draws a tenth of the power and wins per watt.
    expect(best.gpuW.has('mac')).toBe(true);
    expect(best.perGpuW.has('mac')).toBe(true);
    expect(best.systemW).toBeUndefined();
    expect(best.perSystemW).toBeUndefined();
    expect(COLUMNS.map((c) => c.key)).toContain('load');
  });

  it('a rerun on the same machine and model replaces the earlier row of the same origin; an older incoming row is dropped', () => {
    const rows = [a, b];
    const again = { ...a, id: 'pc2', measuredAt: '2026-09-21T10:00:00Z' };
    const after = supersede(rows, again, (r) => r.model.name);
    expect(after.map((r) => r.id)).toEqual(['mac', 'pc2']);
    // An imported row of the same machine does not replace this machine's own, and vice versa.
    const importedPc = { ...a, id: 'pc-imp', imported: true, measuredAt: '2026-09-22T10:00:00Z' };
    expect(supersede(after, importedPc, (r) => r.model.name).map((r) => r.id)).toEqual(['mac', 'pc2', 'pc-imp']);
    // Older than what is there: nothing changes.
    const stale = { ...a, id: 'pc0', measuredAt: '2026-09-19T10:00:00Z' };
    expect(supersede(after, stale, (r) => r.model.name).map((r) => r.id)).toEqual(['mac', 'pc2']);
  });

  it('validates rows and reads an export file, marking its rows imported and refusing anything else', () => {
    expect(validResult(a)).toBe(true);
    expect(validResult({ ...a, protocol: 'other' })).toBe(false);
    expect(validResult({ ...a, genTokPerSec: 'fast' })).toBe(false);
    expect(validResult(null)).toBe(false);
    const file = JSON.stringify({ strataLlmBench: 1, exportedAt: 'x', results: [a, { junk: true }] });
    const parsed = parseBenchFile(file);
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) {
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].imported).toBe(true);
    }
    expect(parseBenchFile('not json')).toEqual({ error: 'Not a JSON file' });
    expect(parseBenchFile('{"results":[]}')).toEqual({ error: 'Not a Strata Tune LLM benchmark export' });
    expect(parseBenchFile('{"strataLlmBench":1,"results":[{"x":1}]}')).toEqual({ error: 'The file holds no readable result' });
  });
});

describe('the sensor ids the run samples', () => {
  it('finds the GPU, CPU package and memory rows on the PC and the SMC system figure on the Mac', () => {
    // The dev box lists the 9950X's own Radeon beside the 5090: the card named in the request wins, and without a name the NVIDIA one does.
    const pcIds = resolveIds(devboxMeta(), 'NVIDIA GeForce RTX 5090');
    // LHM's own GpuNvidia rows and NVML's both carry the 5090's name; either is the card's figure.
    expect(pcIds.gpuW).toMatch(/^\/(nvml|gpu-nvidia)\/0\//);
    expect(pcIds.gpuMemMiB).toMatch(/^\/(nvml|gpu-nvidia)\/0\//);
    expect(pcIds.cpuW).toBe('/amdcpu/0/power/0');
    expect(pcIds.systemW).toBeUndefined();
    expect(resolveIds(devboxMeta()).gpuW).toMatch(/^\/(nvml|gpu-nvidia)\/0\//);
    expect(resolveIds(devboxMeta(), 'AMD Radeon(TM) Graphics').gpuW).toBe('/gpu-amd/0/power/0');
    const ids = resolveIds(macMeta());
    expect(ids.gpuW).toBe('/apple/gpu/0/power/core');
    expect(ids.cpuW).toBe('/apple/cpu/0/power/package');
    expect(ids.systemW).toBe('/apple/smc/0/power/system');
    expect(ids.gpuMemMiB).toBe('/apple/gpu/0/smalldata/memory-used');
  });

  it('names an ungated tokenizer for llama-benchy by model family, Qwen for anything unknown', () => {
    expect(tokenizerFor('qwen35', 'qwen3.8:27b')).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(tokenizerFor('gemma3', 'gemma3:27b')).toBe('unsloth/gemma-3-1b-it');
    expect(tokenizerFor('llama', 'llama3.1:8b')).toBe('unsloth/Llama-3.2-1B-Instruct');
    expect(tokenizerFor('', 'deepseek-r1:32b')).toBe('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B');
    expect(tokenizerFor('mystery', 'x:1b')).toBe('Qwen/Qwen2.5-7B-Instruct');
  });
});

describe('the context-depth sweep', () => {
  it('sizes the filler by depth, keeps the prefix first so the cache cannot answer it, and widens the window by the depth', () => {
    expect(DEPTHS).toEqual([0, 4096, 16384]);
    expect(fillerForDepth(0)).toBe('');
    const f4k = fillerForDepth(4096);
    const f16k = fillerForDepth(16384);
    expect(f4k.length).toBeGreaterThan(4096 * 4.5);
    expect(f4k.length).toBeLessThan(4096 * 6.5);
    expect(f16k.length / f4k.length).toBeGreaterThan(3.5);
    expect(f16k.length / f4k.length).toBeLessThan(4.5);
    // Numbered paragraphs, not one string repeated.
    expect(f4k.startsWith('1. ')).toBe(true);
    expect(f4k).toContain('\n\n2. ');
    const deep = promptForRun(2, 3, 4096);
    expect(deep.startsWith('Benchmark run 2 of 3 at depth 4096.')).toBe(true);
    expect(deep.endsWith(PROMPT_BODY)).toBe(true);
    expect(deep).toContain(f4k);
    expect(promptForRun(1, 3, 0)).not.toContain('Background notes');
    expect(numCtxFor(0)).toBe(4096);
    expect(numCtxFor(16384)).toBe(20480);
    expect(std([100, 110])).toBeCloseTo(7.071, 2);
    expect(std([5])).toBe(0);
  });

  it('summarise folds each depth separately, the headline figures being the zero-depth ones, with ± per depth', () => {
    const r = summarise({
      id: 'd', measuredAt: '2026-09-20T10:00:00Z', machine: pc, model: qwen,
      runs: [
        run(100, 5000, { depth: 0, loadMs: 3000 }), run(110, 5000, { depth: 0, loadMs: 1 }),
        run(80, 3000, { depth: 4096, loadMs: 1, promptEvalCount: 5000 }), run(82, 3100, { depth: 4096, loadMs: 1, promptEvalCount: 5000 }),
        run(60, 2000, { depth: 16384, loadMs: 1, promptEvalCount: 17000, promptEvalMs: 8500 })
      ],
      idle: [], busy: [], residentBytes: null
    });
    expect(r.genTokPerSec).toBeCloseTo(105, 5);
    expect(r.loadMs).toBe(3000);
    expect(r.settings.runs).toBe(2);
    expect(r.depths?.map((d) => d.depth)).toEqual([0, 4096, 16384]);
    expect(atDepth(r, 0)?.genStd).toBeCloseTo(7.071, 2);
    expect(atDepth(r, 4096)?.genTokPerSec).toBeCloseTo(81, 5);
    expect(atDepth(r, 4096)?.promptTokens).toBe(5000);
    expect(atDepth(r, 16384)?.prefillTokPerSec).toBeCloseTo(2000, 5);
    expect(atDepth(r, 16384)?.genStd).toBe(0);
    expect(atDepth(r, 8192)).toBeUndefined();
    expect(COLUMNS.find((c) => c.key === 'gen16k')?.of(r)).toBeCloseTo(60, 5);
    // A row from before the sweep answers null for the depth columns and still validates.
    const old = { ...r, depths: undefined };
    expect(COLUMNS.find((c) => c.key === 'gen4k')?.of(old)).toBeNull();
    expect(validResult(old)).toBe(true);
  });
});

describe('llama-benchy', () => {
  const file = JSON.stringify({
    version: '0.4.0', timestamp: 'x', latency_mode: 'generation', latency_ms: 26.6, model: 'qwen2.5vl:7b',
    benchmarks: [
      { concurrency: 1, context_size: 0, prompt_size: 1024, response_size: 256, is_context_prefill_phase: false, pp_throughput: { mean: 3073.1, std: 12.0 }, tg_throughput: { mean: 102.0, std: 0.02 }, peak_throughput: { mean: 102.5, std: 0.5 }, ttfr: { mean: 359.8, std: 1.3 }, est_ppt: { mean: 333.2, std: 1.3 }, e2e_ttft: { mean: 359.8, std: 1.3 } },
      { concurrency: 1, context_size: 4096, prompt_size: 1024, response_size: 256, is_context_prefill_phase: true, pp_throughput: { mean: 1, std: 0 } },
      { concurrency: 1, context_size: 4096, prompt_size: 1024, response_size: 256, is_context_prefill_phase: false, pp_throughput: { mean: 2224.5, std: 56.9 }, tg_throughput: { mean: 91.0, std: 2.6 }, peak_throughput: null, ttfr: { mean: 500 }, est_ppt: null, e2e_ttft: null }
    ]
  });

  it('reads the JSON file into one row per shape, skipping the context-prefill phases, with ± carried', () => {
    const p = parseBenchyJson(file);
    expect('error' in p).toBe(false);
    if ('error' in p) return;
    expect(p.version).toBe('0.4.0');
    expect(p.latencyMs).toBeCloseTo(26.6, 5);
    expect(p.rows.map((r) => r.contextSize)).toEqual([0, 4096]);
    expect(p.rows[0].pp).toEqual({ mean: 3073.1, std: 12.0 });
    expect(p.rows[1].ttfrMs).toEqual({ mean: 500, std: 0 });
    expect(p.rows[1].peak).toBeNull();
    expect(parseBenchyJson('nope')).toEqual({ error: 'llama-benchy wrote no JSON' });
    expect(parseBenchyJson('{"benchmarks":[]}')).toEqual({ error: 'llama-benchy reported no completed test' });
  });

  it('groups by model with the context sizes seen, ranks pp and tg per size, and travels in the export file', () => {
    const p = parseBenchyJson(file);
    if ('error' in p) throw new Error(p.error);
    const mk = (machine: LlmMachine, id: string, scale: number): BenchyResult => ({
      id, measuredAt: '2026-09-20T11:00:00Z', machine, model: 'qwen2.5vl:7b', version: '0.4.0', latencyMode: 'generation', latencyMs: 26.6, contextLength: 32768, args: '',
      rows: p.rows.map((r) => ({ ...r, pp: r.pp && { ...r.pp, mean: r.pp.mean * scale }, tg: r.tg && { ...r.tg, mean: r.tg.mean * scale } })), imported: false
    });
    const a = mk(pc, 'pc', 3);
    const b = mk(mac, 'mac', 1);
    expect(validBenchy(a)).toBe(true);
    expect(validBenchy({ ...a, rows: 'x' })).toBe(false);
    const groups = groupBenchy([b, a]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contexts).toEqual([0, 4096]);
    const best = bestBenchy([a, b]);
    expect(best['pp@0'].has('pc')).toBe(true);
    expect(best['tg@4096'].has('pc')).toBe(true);
    expect(best['tg@4096'].has('mac')).toBe(false);
    const text = JSON.stringify({ strataLlmBench: 1, exportedAt: 'x', results: [], benchy: [a, { junk: 1 }] });
    const parsed = parseBenchFile(text);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.results).toEqual([]);
    expect(parsed.benchy).toHaveLength(1);
    expect(parsed.benchy[0].imported).toBe(true);
  });
});
