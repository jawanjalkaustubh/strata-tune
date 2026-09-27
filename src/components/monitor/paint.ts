import type { Tick } from '../../collector-types';

/** The slice of `document` the painter reads; a test passes its own. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', handler: () => void): void;
  removeEventListener(type: 'visibilitychange', handler: () => void): void;
}

export interface TickPainter {
  /** A tick has arrived (it is in the ring already): drawn now, or held while the window is hidden. */
  tick(t: Tick): void;
  dispose(): void;
}

/**
 * macOS (electron/main.ts setLiveSession): background throttling stays on there, so a minimised
 * or covered window reads as document.hidden. The ticks still reach the page's ring buffer, but
 * the render each would cost waits: the last one is drawn once the window shows again, so the
 * panels come back current with their history intact. Windows draws every tick as before, where
 * a live session keeps pace with a game in front.
 */
export function tickPainter(paint: (t: Tick) => void, platform: string | undefined, doc: Visibility = document): TickPainter {
  if (platform !== 'darwin') return { tick: paint, dispose: () => {} };
  let last: Tick | null = null;
  let behind = false;
  const onVisibility = () => {
    if (doc.hidden || !behind || !last) return;
    behind = false;
    paint(last);
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    tick(t) {
      last = t;
      if (doc.hidden) {
        behind = true;
        return;
      }
      behind = false;
      paint(t);
    },
    dispose: () => doc.removeEventListener('visibilitychange', onVisibility)
  };
}
