import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { factsFromPicker, factsFromSnapshot } from '../src/components/advisor/hardware';
import { DEFAULT_FACTOR, adviseRows, bestRows, gpuSpecOf, streamedBandwidth } from '../src/components/advisor/rows';
import { ModelList } from '../src/components/advisor/ModelList';
import { devbox } from './fixtures';

// Calibration's install link goes through support.ts, which reads window.strata at import: a bare window is enough here.
(globalThis as { window?: unknown }).window = globalThis;
const { Calibration } = await import('../src/components/advisor/Calibration');

const calibration = (over: Partial<React.ComponentProps<typeof Calibration>>) =>
  renderToStaticMarkup(
    <Calibration
      installed={null}
      loaded={[]}
      available
      ollamaAbsent={false}
      listError=""
      estimates={{}}
      measurements={{}}
      calibrating={null}
      calibrateError=""
      factor={DEFAULT_FACTOR}
      defaultFactor={DEFAULT_FACTOR}
      factorIsSet={false}
      derived={null}
      onCalibrate={() => {}}
      onSetFactor={() => {}}
      onResetFactor={() => {}}
      {...over}
    />
  );

/**
 * Plan section 10, 'No local model is the normal case': the page is complete from the
 * snapshot and the spec tables with no Ollama, no model and no bench.json, and the
 * Ollama-only block is one quiet line, never a frame, a spinner or an error.
 */
describe('the advisor without Ollama or a bench', () => {
  it('the calibration block is the one muted install line, with no card frame and no factor chip', () => {
    const html = calibration({ ollamaAbsent: true, listError: 'Ollama is not running' });
    expect(html).toContain('Install Ollama');
    expect(html).toContain('to measure real tokens/s on your models.');
    expect(html).toContain('https://ollama.com');
    expect(html).not.toContain('Tokens/s calibration');
    expect(html).not.toContain('factor');
    expect(html).not.toContain('Calibrate');
    // The plain browser has no bridge at all: the same one line.
    const browser = calibration({ available: false });
    expect(browser).toContain('cannot reach Ollama');
    expect(browser).not.toContain('Tokens/s calibration');
  });

  it('nothing stands in while Ollama is still being asked; a factor set earlier stays visible with its reset', () => {
    expect(calibration({})).toBe('');
    const kept = calibration({ ollamaAbsent: true, factorIsSet: true, factor: 0.62 });
    expect(kept).toContain('Estimates use the factor');
    expect(kept).toContain('0.62');
    expect(kept).toContain(`reset to ${DEFAULT_FACTOR}`);
  });

  it('the table appears only once Ollama answered, and an empty answer says so without a spinner', () => {
    const empty = calibration({ installed: [] });
    expect(empty).toContain('Tokens/s calibration');
    expect(empty).toContain('has no models');
    const one = calibration({ installed: [{ name: 'qwen3:4b', sizeBytes: 2.6e9, parameterSize: '4.0B', quantization: 'Q4_K_M', family: 'qwen3', contextLength: 40960 }] });
    expect(one).toContain('qwen3:4b');
    expect(one).toContain('Calibrate');
  });

  it('every row is estimated from the reference ceiling with no bench, carries its pull command and its download size', () => {
    const facts = factsFromPicker({ gpuName: 'GeForce RTX 5090', ramGiB: 32, freeDiskGiB: 100 }, 32);
    const spec = gpuSpecOf(facts.gpuName)!;
    const bandwidth = streamedBandwidth(null, false, spec.bandwidthGBs);
    expect(bandwidth).toMatchObject({ measured: false });
    const rows = adviseRows({ facts, bandwidthGBs: bandwidth!.gbs, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.tokPerSec !== null && r.tokPerSec > 0)).toBe(true);
    const picks = bestRows(rows);
    expect(picks.chat).not.toBeNull();
    const html = renderToStaticMarkup(
      <ModelList rows={rows} vramBytes={facts.vramBytes} ramBytes={facts.ramBytes} liveVram={false} freeDiskBytes={facts.freeDiskBytes} diskLabel="the model drive" contextTokens={8192} maxContext={131072} onContext={() => {}} tags={[]} filter={null} onFilter={() => {}} bandwidthKnown />
    );
    for (const r of rows) expect(html).toContain(`Copy &quot;ollama pull ${r.pullTag}&quot;`);
    expect(html).toContain('100 GiB free');
    expect(html).not.toContain('tok/s needs bandwidth');
  });

  it('the snapshot without Ollama gives the same rows from the live card, none waiting on :11434', () => {
    const s = devbox();
    s.ollama = null;
    const facts = factsFromSnapshot(s, null, null);
    const rows = adviseRows({ facts, bandwidthGBs: 2052 * 0.8, contextTokens: 8192, factor: DEFAULT_FACTOR });
    expect(rows.every((r) => r.tokPerSec !== null)).toBe(true);
  });
});
