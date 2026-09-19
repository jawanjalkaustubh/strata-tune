import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, HOME } from '../src/App';
import { BottomBar, PAGES } from '../src/components/BottomBar';
import { resolveTarget } from '../src/components/navigate';
import { updateSettings } from '../src/components/useSettings';
import { HEADROOM_OFF, HEADROOM_TAGLINE, WRITES_SENTENCE } from '../src/components/tune/text';

// Outside Electron: no window.strata; the shell renders with everything disabled and its reasons shown.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

const esc = (text: string) => text.replace(/'/g, '&#x27;');

describe('the shell (plan 17): Tune is the home page and holds the audit', () => {
  it('the page switcher is Tune · Monitor · Capture · AI Models, with no Audit entry', () => {
    expect(PAGES.map((p) => p.label)).toEqual(['Tune', 'Monitor', 'Capture', 'AI Models']);
    const html = renderToStaticMarkup(<BottomBar page="tune" onSelect={() => undefined} status="Collector: Connected" />);
    expect(html).not.toContain('Audit');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('truncate');
    expect(HOME).toBe('tune');
  });

  it("an 'audit' target is the Tune page with the audit intent; other targets pass through", () => {
    expect(resolveTarget({ page: 'audit' })).toEqual({ page: 'tune', intent: 'audit' });
    expect(resolveTarget({ page: 'monitor', intent: 'cpu-ppt' })).toEqual({ page: 'monitor', intent: 'cpu-ppt' });
    expect(resolveTarget({ page: 'capture' })).toEqual({ page: 'capture', intent: null });
  });

  it('the home page opens on the audit with the Headroom section beneath it: one line while the switch is off, the header with the one sentence when on', () => {
    store.delete('strata-tune.settings');
    const off = renderToStaticMarkup(<App />);
    expect(off).toContain('>Audit<');
    expect(off).toContain('Run audit');
    expect(off.indexOf('id="audit"')).toBeLessThan(off.indexOf('id="headroom"'));
    expect(off).toContain(esc(HEADROOM_OFF));
    expect(off).not.toContain(esc(HEADROOM_TAGLINE));

    updateSettings({ enableTune: true, tuneAcceptedWarningAt: '2026-09-16T10:00:00Z' });
    const on = renderToStaticMarkup(<App />);
    expect(on).toContain(esc(HEADROOM_TAGLINE));
    expect(on).toContain(esc(WRITES_SENTENCE));
    expect(on).toContain('What does your vendor tool show?');
    expect(on).toContain('Find headroom');
    expect(on).not.toContain(esc(HEADROOM_OFF));
    updateSettings({ enableTune: false, tuneAcceptedWarningAt: null });
  });
});
