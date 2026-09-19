import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings';
import { updateSettings } from '../src/components/useSettings';

/** The renderer's localStorage, enough of it for settings.ts. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

describe('settings: two writers, one store', () => {
  beforeEach(() => store.clear());

  it('a Monitor patch merges over what the Advisor saved in between, so neither loses the other\'s field', () => {
    updateSettings({ cpuPptW: 300 });
    // The Advisor page writes its calibration on its own path (loadSettings + saveSettings).
    saveSettings({ ...loadSettings(), calibrationFactor: 1.25 });
    updateSettings({ panelNames: { '/nvml/0': 'ROG Astral LC RTX 5090' } });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, cpuPptW: 300, calibrationFactor: 1.25, panelNames: { '/nvml/0': 'ROG Astral LC RTX 5090' } });
    // And the other way round: the Monitor's fields survive the Advisor's write.
    saveSettings({ ...loadSettings(), calibrationFactor: 0.5 });
    expect(loadSettings().cpuPptW).toBe(300);
    expect(loadSettings().panelNames).toEqual({ '/nvml/0': 'ROG Astral LC RTX 5090' });
  });

  it('a patch of null returns a field to its default', () => {
    updateSettings({ cpuPptW: 250, monitorLayout: [{ id: 'gpu', span: 6 }] });
    updateSettings({ monitorLayout: null });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, cpuPptW: 250 });
  });
});
