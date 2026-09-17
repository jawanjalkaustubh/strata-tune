import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { CpuPanel } from '../src/components/monitor/CpuPanel';
import { GpuPanel } from '../src/components/monitor/GpuPanel';
import { BoardPanel } from '../src/components/monitor/BoardPanel';
import { SystemPower } from '../src/components/monitor/SystemPower';
import { devbox, devboxMeta, devboxTick } from './fixtures';

/**
 * The panels rendered over the dev box's real sensor tree and one real tick: a
 * render-time exception here is a blank Monitor page in the app, and no eyeball
 * run catches every branch (an Intel tree, a card without pins, a snapshot that
 * has not arrived yet).
 */
function render(snapshot = devbox(), meta = devboxMeta(), tick = devboxTick(), ticks = 10) {
  const index = new SensorIndex(meta);
  const ring = new Ring();
  for (let i = 0; i < ticks; i++) ring.push({ ...tick, qpc: tick.qpc + i * 5_000_000 });
  return {
    cpu: renderToStaticMarkup(<CpuPanel index={index} tick={tick} ring={ring} snapshot={snapshot} />),
    gpu: renderToStaticMarkup(<GpuPanel index={index} tick={tick} ring={ring} />),
    board: renderToStaticMarkup(<BoardPanel index={index} tick={tick} ring={ring} snapshot={snapshot} />),
    power: renderToStaticMarkup(<SystemPower index={index} tick={tick} ring={ring} snapshot={snapshot} />)
  };
}

describe('Monitor panels render the dev box', () => {
  it('CPU: sixteen cells in two dies, the vendor accent, Tctl and package bars', () => {
    const { cpu } = render();
    expect((cpu.match(/chip-figure/g) ?? []).length).toBeGreaterThanOrEqual(16);
    expect(cpu).toContain('CCD1 (TDIE)');
    expect(cpu).toContain('#ED1C24');
    expect(cpu).toContain('Tctl');
    expect(cpu).toContain('PPT 230 W');
  });

  it('GPU: pins with spread figures, the perf-limit pill for 0x400 in its own case, no LHM ghost', () => {
    const { gpu } = render();
    expect(gpu).toContain('12V-2x6');
    expect(gpu).toContain('#76B900');
    expect(gpu).toContain('idle (0x400)');
    expect(gpu).toContain('normal-case');
    expect(gpu).toContain('driver 616.92');
    expect(gpu).not.toContain('Requested');
  });

  it('Board: the SoC at 1.304 V is emerald, one amber fan row, the unused headers folded', () => {
    const { board } = render();
    expect(board).toContain('#C8102E');
    expect(board).toContain('no tacho at 100 %');
    expect(board).toContain('8 headers unused');
    expect(board).not.toContain('System Fan #3');
    // The SoC figure keeps the ok tone: no rose text on an idle, tuned box.
    const soc = board.slice(board.indexOf('>SoC<'), board.indexOf('>SoC<') + 900);
    expect(soc).toContain('text-emerald-400');
    expect(soc).not.toContain('text-rose-400');
  });

  it('System power: measured and estimated parts with the total', () => {
    const { power } = render();
    expect(power).toContain('System power');
    expect(power).toContain('CPU package');
    expect(power).toContain('GPU board');
    expect(power).toContain('RAM (2 DIMM)');
  });

  it('renders without a snapshot, without pins and without a GPU', () => {
    const noSnapshot = render(null as unknown as ReturnType<typeof devbox>);
    expect(noSnapshot.cpu).toContain('Tctl');
    const meta = devboxMeta().filter((m) => !/12VHPWR/.test(m.name));
    expect(render(devbox(), meta).gpu).not.toContain('12V-2x6');
    // No NVML card: the dev box's own iGPU node stands in (plan 17d row 1), headed by its library name, no NVML-shaped rows.
    const tick = devboxTick();
    tick.gpu = [];
    const igpu = render(devbox(), devboxMeta(), tick).gpu;
    expect(igpu).toContain('AMD Radeon(TM) Graphics');
    expect(igpu).toContain('integrated · no discrete card');
    expect(igpu).toContain('Core clock');
    expect(igpu).not.toContain('12V-2x6');
    expect(igpu).not.toContain('Requested');
    // No GPU node of any kind: one sentence.
    const none = render(devbox(), devboxMeta().filter((m) => !/^Gpu/i.test(m.hardwareType)), tick).gpu;
    expect(none).toContain('No GPU sensors on this machine');
  });
});
