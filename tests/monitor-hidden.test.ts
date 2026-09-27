import { describe, expect, it } from 'vitest';
import { tickPainter } from '../src/components/monitor/paint';
import type { Tick } from '../src/collector-types';

/**
 * macOS leaves background throttling on (electron/main.ts setLiveSession), so a minimised or
 * covered Monitor reads as hidden: its ticks keep landing in the ring buffer while the render
 * waits for the window to show again (src/components/monitor/paint.ts).
 */
describe('the Monitor while hidden on macOS', () => {
  const fakeDoc = () => {
    const target = new EventTarget();
    const doc = {
      hidden: false,
      addEventListener: (type: 'visibilitychange', h: () => void) => target.addEventListener(type, h),
      removeEventListener: (type: 'visibilitychange', h: () => void) => target.removeEventListener(type, h),
      show(hidden: boolean) {
        doc.hidden = hidden;
        target.dispatchEvent(new Event('visibilitychange'));
      }
    };
    return doc;
  };
  const t = (qpc: number): Tick => ({ qpc, sensors: {}, gpu: [], warming: false });

  it('holds the render while hidden and draws the last tick once shown; Windows draws every tick', () => {
    const doc = fakeDoc();
    const drawn: number[] = [];
    const p = tickPainter((x) => drawn.push(x.qpc), 'darwin', doc);
    p.tick(t(1));
    doc.show(true);
    p.tick(t(2));
    p.tick(t(3));
    expect(drawn).toEqual([1]);
    doc.show(false);
    expect(drawn).toEqual([1, 3]);
    doc.show(true);
    doc.show(false);
    expect(drawn).toEqual([1, 3]);
    p.dispose();
    const win: number[] = [];
    const w = tickPainter((x) => win.push(x.qpc), 'win32', doc);
    doc.show(true);
    w.tick(t(1));
    w.tick(t(2));
    expect(win).toEqual([1, 2]);
  });
});
