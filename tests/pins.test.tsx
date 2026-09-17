import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SensorMeta, Tick } from '../src/collector-types';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { GpuPanel } from '../src/components/monitor/GpuPanel';
import { gpuLayout } from '../src/components/monitor/gpuLayout';
import { devboxMeta, devboxTick } from './fixtures';

/**
 * Plan section 17a: the 12V-2x6 block exists only on a card with per-pin shunts. A Founders
 * Edition (or most partner cards) reports board power alone, and then the block, its spread
 * and max/mean figures and the connector totals are absent, not faked from a total, and the
 * column the block would fill is not there either.
 */

/** The dev box's tree and tick with every sensor matching `drop` removed: the shape of a card that does not have them. */
function without(drop: RegExp): { meta: SensorMeta[]; tick: Tick } {
  const meta = devboxMeta().filter((m) => !drop.test(m.name));
  const keep = new Set(meta.map((m) => m.id));
  const tick = devboxTick();
  tick.sensors = Object.fromEntries(Object.entries(tick.sensors).filter(([id]) => keep.has(id)));
  return { meta, tick };
}

function render(meta: SensorMeta[], tick: Tick): string {
  const index = new SensorIndex(meta);
  const ring = new Ring();
  for (let i = 0; i < 4; i++) ring.push({ ...tick, qpc: tick.qpc + i * 5_000_000 });
  return renderToStaticMarkup(<GpuPanel index={index} tick={tick} ring={ring} />);
}

const GPU = 'NVIDIA GeForce RTX 5090';
const BLOCK = ['12V-2x6', 'Spread', 'Max/mean', 'Connector', 'per-pin'];

describe('12V-2x6 block only with per-pin sensors (plan section 17a)', () => {
  it('the Astral: six pins by their current sensors, with volts and watts riding along, and the connector totals', () => {
    const layout = gpuLayout(new SensorIndex(devboxMeta()), GPU);
    expect(layout.pins.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(layout.pins[0]).toEqual({ n: 1, ampsId: '/gpu-nvidia/0/current/1', voltsId: '/gpu-nvidia/0/voltage/0#1', wattsId: '/gpu-nvidia/0/power/2' });
    expect(layout.connectorA).toBe('/gpu-nvidia/0/current/0');
    expect(layout.connectorW).toBe('/gpu-nvidia/0/power/1');
    const html = render(devboxMeta(), devboxTick());
    for (const word of BLOCK.slice(0, 4)) expect(html).toContain(word);
    expect(html).toContain('<div class="flex-1 min-w-0">');
  });

  it('a Founders Edition shape (no 12VHPWR sensors at all): no block, no figures, no fallback line, and the column is gone', () => {
    const { meta, tick } = without(/12VHPWR/);
    const layout = gpuLayout(new SensorIndex(meta), GPU);
    expect(layout.pins).toEqual([]);
    expect(layout.connectorA).toBeUndefined();
    expect(layout.connectorW).toBeUndefined();
    const html = render(meta, tick);
    for (const word of BLOCK) expect(html).not.toContain(word);
    expect(html).not.toContain('<div class="flex-1 min-w-0">');
    // The card is still drawn and the board power still has its bar: nothing is lost, nothing is faked.
    expect(html).toContain('GPU card schematic');
    expect(html).toContain('Board power');
  });

  it('connector totals without per-pin currents make no block either: a total is already the board-power bar', () => {
    const { meta, tick } = without(/12VHPWR Pin/);
    expect(meta.some((m) => m.name === '12VHPWR Connector')).toBe(true);
    const layout = gpuLayout(new SensorIndex(meta), GPU);
    expect(layout.pins).toEqual([]);
    expect(layout.connectorA).toBeUndefined();
    expect(layout.connectorW).toBeUndefined();
    const html = render(meta, tick);
    for (const word of BLOCK) expect(html).not.toContain(word);
  });

  it('per-pin voltage or power rows without a current row make no pin: the analysis is of currents', () => {
    const { meta } = without(/12VHPWR Pin/);
    const voltsOnly = [...meta, ...devboxMeta().filter((m) => /12VHPWR Pin/.test(m.name) && m.sensorType !== 'Current')];
    const layout = gpuLayout(new SensorIndex(voltsOnly), GPU);
    expect(layout.pins).toEqual([]);
    // One current row is one pin, with its own voltage and power attached and no others.
    const onePin = [...voltsOnly, ...devboxMeta().filter((m) => m.name === '12VHPWR Pin 3' && m.sensorType === 'Current')];
    const one = gpuLayout(new SensorIndex(onePin), GPU);
    expect(one.pins).toEqual([{ n: 3, ampsId: '/gpu-nvidia/0/current/3', voltsId: '/gpu-nvidia/0/voltage/2', wattsId: '/gpu-nvidia/0/power/4' }]);
  });
});
