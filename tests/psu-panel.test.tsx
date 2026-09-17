import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { SystemPower } from '../src/components/monitor/SystemPower';
import { psuBadge, psuOf } from '../src/components/advisor/PsuForm';
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings';
import { updateSettings } from '../src/components/useSettings';
import { wallWatts } from '../src/analysis/psu';
import { devbox, devboxMeta, devboxTick } from './fixtures';

/** The renderer's localStorage, enough of it for settings.ts. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

/** The dev box's tick, with the two measured parts set as a test wants them. */
function render(cpuW: number, gpuW: number) {
  const tick = devboxTick();
  tick.sensors['/amdcpu/0/power/0'] = cpuW;
  tick.gpu[0].powerMw = gpuW * 1000;
  const index = new SensorIndex(devboxMeta());
  const ring = new Ring();
  ring.push(tick);
  return renderToStaticMarkup(<SystemPower index={index} tick={tick} ring={ring} snapshot={devbox()} />);
}

describe('PSU setting (plan section 13, pulled forward)', () => {
  beforeEach(() => {
    store.clear();
    updateSettings({ psuWatts: null, psuRating: null });
  });

  it('persists both fields and reads back as the supply; either missing is "not set"', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ psuWatts: null, psuRating: null });
    expect(psuOf(loadSettings())).toBeNull();
    updateSettings({ psuWatts: 1300, psuRating: 'platinum' });
    expect(loadSettings()).toMatchObject({ psuWatts: 1300, psuRating: 'platinum' });
    expect(psuOf(loadSettings())).toEqual({ watts: 1300, rating: 'platinum' });
    updateSettings({ psuRating: null });
    expect(psuOf(loadSettings())).toBeNull();
    // A Monitor write in between keeps the supply.
    updateSettings({ psuRating: 'titanium' });
    updateSettings({ cpuPptW: 300 });
    expect(loadSettings()).toMatchObject({ psuWatts: 1300, psuRating: 'titanium', cpuPptW: 300 });
  });

  it('badges read as one word after "est.,"', () => {
    expect(psuBadge('gold')).toBe('Gold');
    expect(psuBadge('titanium')).toBe('Titanium');
    expect(psuBadge('white')).toBe('80 PLUS');
    expect(psuBadge('none')).toBe('no badge');
  });
});

describe('SYSTEM POWER with the PSU', () => {
  beforeEach(() => {
    store.clear();
    updateSettings({ psuWatts: null, psuRating: null });
  });

  it('unset: the form affordance and no wall figure', () => {
    const html = render(52, 63);
    expect(html).toContain('Set your PSU');
    expect(html).not.toContain('at the wall');
    expect(html).not.toContain('headroom fine');
  });

  it('this box idle on a 1300 W Platinum unit (Lian Li Edge): the wall estimate from the 80 PLUS curve and "headroom fine"', () => {
    updateSettings({ psuWatts: 1300, psuRating: 'platinum' });
    const html = render(52, 63);
    // DC total = 52 + 63 measured + 25 board + 2 x 3.5 RAM + drives + fans (estimated); the wall figure divides by the Platinum curve at that load.
    const dc = Number(html.match(/(\d+) W<\/span><\/div><p/)?.[1]);
    const wall = Number(html.match(/≈ (\d+) W at the wall/)?.[1]);
    expect(dc).toBeGreaterThan(115);
    expect(wall).toBeGreaterThan(dc);
    expect(Math.abs(wall - wallWatts(dc, 1300, 'platinum'))).toBeLessThanOrEqual(1);
    expect(html).toContain('(est., Platinum)');
    expect(html).toContain('headroom fine');
    expect(html).toContain('1300 W · Platinum');
    expect(html).toContain('ten times a second');
    expect(html).not.toContain('Set your PSU');
  });

  it('a 5090 flat out on a 750 W unit: the verdict line names the next common size', () => {
    updateSettings({ psuWatts: 750, psuRating: 'bronze' });
    const html = render(200, 550);
    expect(html).not.toContain('headroom fine');
    expect(html).toContain('(est., Bronze)');
    expect(html).toMatch(/more than the 750 W the supply is rated for|% of the 750 W rating/);
  });
});
