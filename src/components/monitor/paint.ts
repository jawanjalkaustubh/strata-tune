import type { Tick } from '../../collector-types';

/** Whether the page is out of sight, and word when that may have changed; a test passes its own. */
export interface Visibility {
  readonly hidden: boolean;
  /** Calls back whenever `hidden` may have changed; answers the unsubscribe. */
  onChange(cb: () => void): () => void;
}

/**
 * document.hidden, or the window minimised as the main process reports it (`onMinimized`, macOS
 * only): Chromium on macOS marks a covered page hidden but leaves a minimised one visible.
 */
export function windowVisibility(onMinimized?: (cb: (minimized: boolean) => void) => () => void): Visibility {
  let minimized = false;
  return {
    get hidden() {
      return document.hidden || minimized;
    },
    onChange(cb) {
      const h = () => cb();
      document.addEventListener('visibilitychange', h);
      const off = onMinimized?.((m) => {
        minimized = m;
        cb();
      });
      return () => {
        document.removeEventListener('visibilitychange', h);
        off?.();
      };
    }
  };
}

export interface TickPainter {
  /** A tick has arrived (it is in the ring already): drawn now, or held while the window is out of sight. */
  tick(t: Tick): void;
  dispose(): void;
}

/**
 * macOS (electron/main.ts setLiveSession): background throttling stays on there, so a covered
 * window reads as document.hidden, and main says when it is minimised. The ticks still reach the
 * page's ring buffer, but the render each would cost waits: the last one is drawn once the window
 * shows again, so the panels come back current with their history intact. Windows draws every tick
 * as before, where a live session keeps pace with a game in front.
 */
export function tickPainter(paint: (t: Tick) => void, platform: string | undefined, visibility?: Visibility): TickPainter {
  if (platform !== 'darwin' || !visibility) return { tick: paint, dispose: () => {} };
  let last: Tick | null = null;
  let behind = false;
  const off = visibility.onChange(() => {
    if (visibility.hidden || !behind || !last) return;
    behind = false;
    paint(last);
  });
  return {
    tick(t) {
      last = t;
      if (visibility.hidden) {
        behind = true;
        return;
      }
      behind = false;
      paint(t);
    },
    dispose: off
  };
}
