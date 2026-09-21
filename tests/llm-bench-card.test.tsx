import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlmBenchCard } from '../src/components/advisor/LlmBenchCard';
import { summarise, type LlmBenchResult, type LlmMachine } from '../src/analysis/llm-bench';

const pc: LlmMachine = { hostname: 'DESKTOP', os: 'Windows', gpuName: 'NVIDIA GeForce RTX 5090', cpuName: 'AMD Ryzen 9 9950X3D', ramBytes: 64 * 1024 ** 3, vramBytes: 32 * 1024 ** 3, unified: false, driver: '581.29' };
const mac: LlmMachine = { hostname: 'MacBook-Pro', os: 'macOS', gpuName: 'Apple M5 Max (40-core GPU)', cpuName: 'Apple M5 Max', ramBytes: 128 * 1024 ** 3, vramBytes: 96 * 1024 ** 3, unified: true, driver: null };
const model = { name: 'qwen3.8:27b', parameterSize: '27B', quantization: 'Q4_K_M', family: 'qwen3', sizeBytes: 17 * 1024 ** 3 };

const row = (machine: LlmMachine, gen: number, gpuW: number, systemW: number | null, imported: boolean): LlmBenchResult => ({
  ...summarise({
    id: machine.hostname,
    measuredAt: '2026-09-20T10:00:00Z',
    machine,
    model,
    runs: [{ promptEvalCount: 1000, promptEvalMs: 500, evalCount: 256, evalMs: (256 / gen) * 1000, loadMs: 2000, totalMs: 9000 }],
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
      {...over}
    />
  );

describe('the LLM benchmark card', () => {
  it('puts a PC row and an imported Mac row under one model tag, marking the best of each column, with the system column only when a row reports it', () => {
    const html = card({ results: [row(pc, 100, 420, null, false), row(mac, 32, 40, 90, true)] });
    expect(html).toContain('LLM benchmark');
    expect(html).toContain('qwen3.8:27b');
    expect(html).toContain('27B');
    expect(html).toContain('DESKTOP · NVIDIA GeForce RTX 5090');
    expect(html).toContain('MacBook-Pro · Apple M5 Max (40-core GPU)');
    expect(html).toContain('100 tok/s');
    expect(html).toContain('32 tok/s');
    expect(html).toContain('420 W');
    expect(html).toContain('90 W');
    expect(html).toContain('tok/s per system W');
    // The PC wins generation, the Mac wins per watt: each in the emerald figure style.
    expect(html).toMatch(/text-emerald-400 figure[^>]*>100 tok\/s/);
    expect(html).toMatch(/text-emerald-400 figure[^>]*>0\.80/);
    expect(html).toContain('Export');
    expect(html).toContain('Import');
    // No system power on the PC: a dash, never a zero.
    expect(html).not.toMatch(/>0 W</);
  });

  it('without a row on both sides the system column is left out, and Ollama absent is one quiet line with no Run', () => {
    const one = card({ results: [row(pc, 100, 420, null, false)] });
    expect(one).not.toContain('tok/s per system W');
    expect(one).toContain('tok/s per GPU W');
    const absent = card({ installed: null, ollamaAbsent: true });
    expect(absent).toContain('Ollama is not running');
    expect(absent).not.toContain('<select');
    const browser = card({ available: false, installed: null });
    expect(browser).toContain('cannot reach Ollama');
  });

  it('while a run goes the header shows Stop and the phase line names the run', () => {
    const html = card({ running: { model: 'qwen3.8:27b', phase: 'run', run: 2, runs: 3 } });
    expect(html).toContain('Stop');
    expect(html).toContain('generating (run 2 of 3)');
    expect(html).not.toContain('>Run<');
    const noCollector = card({ collectorConnected: false });
    expect(noCollector).toContain('Collector not connected');
  });
});
