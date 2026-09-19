import { beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MonitorMenu } from '../src/components/monitor/MonitorMenu';
import { CpuPanel } from '../src/components/monitor/CpuPanel';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { coText, cpuTuningDraft, cpuTuningPatch, cpuTuningSummary, curveOptimizerSet, isSet } from '../src/components/monitor/cpuTuning';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../src/settings';
import { updateSettings } from '../src/components/useSettings';
import { devbox, devboxMeta, devboxTick } from './fixtures';

/** The renderer's localStorage, enough of it for settings.ts. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

const RYZEN = 'AMD Ryzen 9 9950X 16-Core Processor';
const RAPTOR = '13th Gen Intel(R) Core(TM) i9-13900K';
/** The dev box as the user runs it (polish 3 items 2–3): PPT 250 set by the user, −30 all-core. */
const DEVBOX_TUNING: Partial<Settings> = { cpuPptW: 250, cpuTdcA: 160, cpuEdcA: 180, coAllCore: -30 };
const EMPTY = { cpuPptW: '', cpuTdcA: '', cpuEdcA: '', coAllCore: '', coPerCore: '' };
const NONE: Partial<Settings> = { cpuPptW: null, cpuTdcA: null, cpuEdcA: null, coAllCore: null, coPerCore: undefined };

const menu = (cpuName: string) => renderToStaticMarkup(<MonitorMenu cpuName={cpuName} layoutIsDefault onClose={() => undefined} />);
const count = (html: string, text: string) => html.split(text).length - 1;

function cpuPanel() {
  const index = new SensorIndex(devboxMeta());
  const ring = new Ring();
  const tick = devboxTick();
  ring.push(tick);
  return renderToStaticMarkup(<CpuPanel index={index} tick={tick} ring={ring} snapshot={devbox()} />);
}

describe('CPU tuning you set in BIOS (polish 3 item 3): the settings', () => {
  beforeEach(() => {
    store.clear();
    updateSettings(NONE);
  });

  it('the four figures default to not set and round-trip through the store; the per-core note is absent until typed', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ cpuPptW: null, cpuTdcA: null, cpuEdcA: null, coAllCore: null });
    expect('coPerCore' in DEFAULT_SETTINGS).toBe(false);
    updateSettings({ ...DEVBOX_TUNING, coPerCore: '−30, cores 3 and 7 at −20' });
    expect(loadSettings()).toMatchObject({ ...DEVBOX_TUNING, coPerCore: '−30, cores 3 and 7 at −20' });
    updateSettings({ coPerCore: undefined });
    expect('coPerCore' in loadSettings()).toBe(false);
  });

  it('typed text becomes a patch: integers, blank or nonsense is not set, a limit must be positive, the Curve Optimizer keeps its sign and 0 is none', () => {
    expect(cpuTuningPatch({ ...EMPTY, cpuPptW: '250', cpuTdcA: '160.4', cpuEdcA: '180', coAllCore: '-30', coPerCore: '  −30 all but core 3  ' }))
      .toEqual({ cpuPptW: 250, cpuTdcA: 160, cpuEdcA: 180, coAllCore: -30, coPerCore: '−30 all but core 3' });
    expect(cpuTuningPatch(EMPTY)).toEqual({ cpuPptW: null, cpuTdcA: null, cpuEdcA: null, coAllCore: null, coPerCore: undefined });
    expect(cpuTuningPatch({ ...EMPTY, cpuPptW: '-250', cpuTdcA: 'abc', cpuEdcA: '0', coAllCore: '0' })).toEqual({ cpuPptW: null, cpuTdcA: null, cpuEdcA: null, coAllCore: null, coPerCore: undefined });
    expect(cpuTuningPatch({ ...EMPTY, coAllCore: '+5' }).coAllCore).toBe(5);
  });

  it('the draft shows stored figures and blanks for not set; set means a real non-zero figure', () => {
    expect(cpuTuningDraft({ ...DEFAULT_SETTINGS, ...DEVBOX_TUNING })).toEqual({ cpuPptW: '250', cpuTdcA: '160', cpuEdcA: '180', coAllCore: '-30', coPerCore: '' });
    expect(cpuTuningDraft(DEFAULT_SETTINGS)).toEqual(EMPTY);
    expect(isSet(250)).toBe(true);
    expect(isSet(0)).toBe(false);
    expect(isSet(null)).toBe(false);
    expect(isSet(Number.NaN)).toBe(false);
    expect(curveOptimizerSet({ coAllCore: -30 })).toBe(true);
    expect(curveOptimizerSet({ coAllCore: null, coPerCore: ' ' })).toBe(false);
    expect(curveOptimizerSet({ coAllCore: null, coPerCore: '−25 all-core' })).toBe(true);
  });

  it('the header strip line names each set field in menu order, in the BIOS\'s own units', () => {
    expect(cpuTuningSummary({ ...DEFAULT_SETTINGS, ...DEVBOX_TUNING }, 'PPT')).toEqual(['PPT 250 W', 'TDC 160 A', 'EDC 180 A', 'CO −30']);
    expect(cpuTuningSummary(DEFAULT_SETTINGS, 'PPT')).toEqual([]);
    expect(cpuTuningSummary({ ...DEFAULT_SETTINGS, cpuPptW: 253 }, 'PL2')).toEqual(['PL2 253 W']);
    expect(cpuTuningSummary({ ...DEFAULT_SETTINGS, coPerCore: '−30 all but core 3' }, 'PPT')).toEqual(['CO per core']);
    expect(coText(-30)).toBe('−30');
    expect(coText(5)).toBe('+5');
  });
});

describe('the Monitor gear menu renders the four fields', () => {
  beforeEach(() => {
    store.clear();
    updateSettings(NONE);
  });

  it('on the 9950X: PPT, TDC, EDC and Curve Optimizer with the per-core note, nothing tagged until set', () => {
    const html = menu(RYZEN);
    expect(html).toContain('CPU tuning you set in BIOS');
    for (const label of ['PPT', 'TDC', 'EDC', 'CO all-core', 'CO per core']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('230 stock');
    expect(html).toContain('no SMU access on Zen 5');
    expect(html).toContain('Reset layout');
    expect(count(html, 'set by you')).toBe(0);
  });

  it('every stored figure carries its "set by you" tag and shows in its field', () => {
    updateSettings({ ...DEVBOX_TUNING, coPerCore: '−30, cores 3 and 7 at −20' });
    const html = menu(RYZEN);
    expect(count(html, 'set by you')).toBe(5);
    expect(html).toContain('value="250"');
    expect(html).toContain('value="160"');
    expect(html).toContain('value="180"');
    expect(html).toContain('value="-30"');
    expect(html).toContain('value="−30, cores 3 and 7 at −20"');
  });

  it('an Intel part gets its PL2 alone: no PBO fields, no Curve Optimizer', () => {
    const html = menu(RAPTOR);
    expect(html).toContain('>PL2<');
    expect(html).toContain('253 stock');
    for (const label of ['TDC', 'EDC', 'CO all-core', 'CO per core']) expect(html).not.toContain(`>${label}<`);
    expect(html).not.toContain('Zen 5');
  });
});

describe('the Package bar consumes the limit', () => {
  beforeEach(() => {
    store.clear();
    updateSettings(NONE);
  });

  it('stock until set, then the tick and the figure say set by you (never clipped: the tag takes its own line)', () => {
    const stock = cpuPanel();
    expect(stock).toContain('PPT 230 W (stock)');
    expect(stock).toContain('>stock</button>');
    expect(stock).not.toContain('set by you');
    updateSettings({ cpuPptW: 250 });
    const set = cpuPanel();
    expect(set).toContain('PPT 250 W (set by you)');
    expect(set).toContain('of 250 W');
    expect(set).toMatch(/<button class="block ml-auto[^"]*"[^>]*>set by you<\/button>/);
    expect(set).not.toContain('(stock)');
  });
});
