import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlmBenchCard } from '../src/components/advisor/LlmBenchCard';
import { summarise, type BenchyResult, type LlmBenchResult, type LlmMachine } from '../src/analysis/llm-bench';

const pc: LlmMachine = { hostname: 'DESKTOP', os: 'Windows', gpuName: 'NVIDIA GeForce RTX 5090', cpuName: 'AMD Ryzen 9 9950X3D', ramBytes: 64 * 1024 ** 3, vramBytes: 32 * 1024 ** 3, unified: false, driver: '581.29' };
const mac: LlmMachine = { hostname: 'MacBook-Pro', os: 'macOS', gpuName: 'Apple M5 Max (40-core GPU)', cpuName: 'Apple M5 Max', ramBytes: 128 * 1024 ** 3, vramBytes: 96 * 1024 ** 3, unified: true, driver: null };
const model = { name: 'qwen3.8:27b', parameterSize: '27B', quantization: 'Q4_K_M', family: 'qwen3', sizeBytes: 17 * 1024 ** 3 };

const row = (machine: LlmMachine, gen: number, gpuW: number, systemW: number | null, imported: boolean): LlmBenchResult => ({
  ...summarise({
    id: machine.hostname,
    measuredAt: '2026-09-20T10:00:00Z',
    machine,
    model,
    runs: [
      { depth: 0, promptEvalCount: 1000, promptEvalMs: 500, evalCount: 256, evalMs: (256 / gen) * 1000, loadMs: 2000, totalMs: 9000 },
      { depth: 0, promptEvalCount: 1000, promptEvalMs: 500, evalCount: 256, evalMs: (256 / (gen * 1.1)) * 1000, loadMs: 1, totalMs: 9000 },
      { depth: 4096, promptEvalCount: 5000, promptEvalMs: 4000, evalCount: 256, evalMs: (256 / (gen * 0.8)) * 1000, loadMs: 1, totalMs: 9000 }
    ],
    idle: [{ gpuW: 10, cpuW: 5, systemW, gpuMemMiB: 1000 }],
    busy: [{ gpuW, cpuW: 20, systemW, gpuMemMiB: 18_000 }],
    residentBytes: 17.4 * 1024 ** 3
  }),
  imported
});

const card = (over: Partial<React.ComponentProps<typeof LlmBenchCard>>) =>
  renderToStaticMarkup(
    <LlmBenchCard
      installed={[{ name: 'qwen3.8:27b', sizeBytes: 17 * 1024 ** 3, parameterSize: '27B', quantization: 'Q4_K_M', family: 'qwen3', contextLength: null }]}
      available
      ollamaAbsent={false}
      collectorConnected
      results={[]}
      running={null}
      error=""
      stopped={false}
      notice=""
      onRun={() => {}}
      onStop={() => {}}
      onDelete={() => {}}
      onExport={() => {}}
      onImport={() => {}}
      benchy={[]}
      benchyStatus={{ uvx: '/opt/homebrew/bin/uvx', installHint: 'brew install uv' }}
      benchyRunning={null}
      onBenchy={() => {}}
      onBenchyStop={() => {}}
      {...over}
    />
  );

describe('the LLM benchmark card', () => {
  it('puts a PC row and an imported Mac row under one model tag, marking the best of each column, with the system column only when a row reports it', () => {
    const html = card({ results: [row(pc, 100, 420, null, false), row(mac, 32, 40, 90, true)] });
    expect(html).toContain('LLM benchmark');
    expect(html).toContain('qwen3.8:27b');
    expect(html).toContain('27B');
    expect(html).toContain('DESKTOP');
    expect(html).toContain('NVIDIA GeForce RTX 5090 · Windows');
    expect(html).toContain('Apple M5 Max (40-core GPU) · macOS');
    // The zero-depth median of 100 and 110 is 105, with its spread beside it; the 4k line under each row.
    expect(html).toContain('105');
    expect(html).toContain('±7.1');
    expect(html).toContain('behind 4k of context');
    expect(html).toContain('80</span> gen');
    expect(html).toContain('1250</span> prefill');
    expect(html).toContain('420 W');
    expect(html).toContain('90 W');
    expect(html).toContain('tok/s per sys W');
    // The PC wins generation, the Mac wins per watt: each in the emerald figure style.
    expect(html).toMatch(/text-emerald-400 figure[^>]*>105<span/);
    expect(html).toMatch(/text-emerald-400 figure[^>]*>0\.84/);
    expect(html).toContain('Export');
    expect(html).toContain('Import');
    // No system power on the PC: a dash, never a zero.
    expect(html).not.toMatch(/>0 W</);
  });

  it('without a row on both sides the system column is left out, and Ollama absent is one quiet line with no Run', () => {
    const one = card({ results: [row(pc, 100, 420, null, false)] });
    expect(one).not.toContain('tok/s per sys W');
    expect(one).toContain('tok/s per GPU W');
    const absent = card({ installed: null, ollamaAbsent: true });
    expect(absent).toContain('Ollama is not running');
    expect(absent).not.toContain('<select');
    const browser = card({ available: false, installed: null });
    expect(browser).toContain('cannot reach Ollama');
  });

  it('while a run goes the header shows Stop and the phase line names the run', () => {
    const html = card({ running: { model: 'qwen3.8:27b', phase: 'run', run: 2, runs: 3, depth: 4096 } });
    expect(html).toContain('Stop');
    expect(html).toContain('generating (run 2 of 3 at 4k context)');
    expect(html).not.toContain('>Run<');
    const noCollector = card({ collectorConnected: false });
    expect(noCollector).toContain('Collector not connected');
  });

  it('llama-benchy rows sit under their own heading, one line per context size, the best pp and tg per size marked, a skipped depth said', () => {
    const rows = (pp: number, tg: number, skip16k: boolean) => [
      { contextSize: 0, promptSize: 1024, responseSize: 256, pp: { mean: pp, std: 12 }, tg: { mean: tg, std: 0.3 }, peak: { mean: tg + 1, std: 0.5 }, ttfrMs: { mean: 360, std: 1 }, estPptMs: { mean: 333, std: 1 }, e2eTtftMs: { mean: 360, std: 1 } },
      { contextSize: 4096, promptSize: 1024, responseSize: 256, pp: { mean: pp * 0.7, std: 50 }, tg: { mean: tg * 0.9, std: 2 }, peak: null, ttfrMs: null, estPptMs: null, e2eTtftMs: null },
      ...(skip16k ? [] : [{ contextSize: 16384, promptSize: 1024, responseSize: 256, pp: { mean: pp * 0.5, std: 50 }, tg: { mean: tg * 0.8, std: 2 }, peak: null, ttfrMs: null, estPptMs: null, e2eTtftMs: null }])
    ];
    const b = (machine: LlmMachine, pp: number, tg: number, skip16k: boolean, imported: boolean): BenchyResult => ({
      id: `b-${machine.hostname}`, measuredAt: '2026-09-20T11:00:00Z', machine, model: 'qwen3.8:27b', version: '0.4.0', latencyMode: 'generation', latencyMs: 26.6,
      contextLength: skip16k ? 8192 : 32768, args: 'llama-benchy --pp 1024 --tg 256', rows: rows(pp, tg, skip16k), imported
    });
    const html = card({ benchy: [b(pc, 9000, 100, true, false), b(mac, 3000, 32, false, true)] });
    expect(html).toContain('llama-benchy');
    expect(html).toContain('pp1024 / tg256');
    expect(html).toContain('pp1024 / tg256 @ d4096');
    expect(html).toContain('pp1024 / tg256 @ d16384');
    expect(html).toContain('9000');
    expect(html).toContain('±12');
    expect(html).toMatch(/text-emerald-400 figure[^>]*>9000<span/);
    expect(html).toContain('does not fit Ollama');
    // Stop and Run for llama-benchy have their own button; without uvx the install line shows.
    expect(html).toContain('llama-benchy</button>');
    const noUv = card({ benchyStatus: { uvx: null, installHint: 'brew install uv' } });
    expect(noUv).toContain('brew install uv');
    const running = card({ benchyRunning: { model: 'qwen3.8:27b', line: 'Run 2/3 (batch size 1)...' } });
    expect(running).toContain('Stop llama-benchy');
    expect(running).toContain('Run 2/3');
  });
});
