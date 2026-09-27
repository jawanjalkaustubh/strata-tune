import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tickPainter, type Visibility } from '../src/components/monitor/paint';
import type { Tick } from '../src/collector-types';

/**
 * macOS leaves background throttling on (electron/main.ts setLiveSession), so a covered Monitor
 * reads as hidden, and main tells the page when the window is minimised (Chromium there leaves a
 * minimised page visible): the ticks keep landing in the ring buffer while the render waits for
 * the window to show again (src/components/monitor/paint.ts).
 */
const t = (qpc: number): Tick => ({ qpc, sensors: {}, gpu: [], warming: false });

function fakeVisibility() {
  const listeners = new Set<() => void>();
  const v = {
    hidden: false,
    onChange(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(hidden: boolean) {
      v.hidden = hidden;
      for (const l of listeners) l();
    },
    get listeners() {
      return listeners.size;
    }
  };
  return v satisfies Visibility;
}

describe('the Monitor out of sight on macOS', () => {
  it('holds the render while hidden or minimised and draws the last tick once shown', () => {
    const v = fakeVisibility();
    const drawn: number[] = [];
    const p = tickPainter((x) => drawn.push(x.qpc), 'darwin', v);
    p.tick(t(1));
    v.set(true);
    p.tick(t(2));
    p.tick(t(3));
    expect(drawn).toEqual([1]);
    v.set(false);
    expect(drawn).toEqual([1, 3]);
    v.set(true);
    v.set(false);
    expect(drawn).toEqual([1, 3]);
    p.dispose();
    expect(v.listeners).toBe(0);
  });

  it('Windows draws every tick whatever the visibility', () => {
    const v = fakeVisibility();
    const win: number[] = [];
    const w = tickPainter((x) => win.push(x.qpc), 'win32', v);
    v.set(true);
    w.tick(t(1));
    w.tick(t(2));
    expect(win).toEqual([1, 2]);
    expect(v.listeners).toBe(0);
  });

  it('main tells the page on macOS when the window is minimised and restored', () => {
    const main = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
    const block = main.slice(main.indexOf("if (process.platform === 'darwin') {\n    win.on('minimize'"));
    expect(block).toContain("win.on('minimize', () => win.webContents.send('window:minimized', true));");
    expect(block).toContain("win.on('restore', () => win.webContents.send('window:minimized', false));");
    expect(readFileSync(join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')).toContain("onMinimized: on('window:minimized')");
  });
});
