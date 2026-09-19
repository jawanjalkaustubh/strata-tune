import type { Tick } from '../../collector-types';

/** 60 s at the collector's 2 Hz. */
export const RING = 120;

/** Fixed-size ring of the last ticks; every sparkline is a projection of it. */
export class Ring {
  private slots: (Tick | undefined)[] = new Array(RING);
  private next = 0;
  private count = 0;

  push(t: Tick) {
    this.slots[this.next] = t;
    this.next = (this.next + 1) % RING;
    this.count = Math.min(this.count + 1, RING);
  }

  /** Oldest first, left-padded while the window fills so new samples enter at the right edge. */
  series(pick: (t: Tick) => number | undefined): (number | undefined)[] {
    const out = new Array<number | undefined>(RING);
    const pad = RING - this.count;
    for (let i = 0; i < RING; i++) {
      if (i < pad) {
        out[i] = undefined;
        continue;
      }
      out[i] = pick(this.slots[(this.next - this.count + (i - pad) + RING) % RING]!);
    }
    return out;
  }

  /** Session high-water mark of a value, for bars whose natural scale is "the most seen so far". */
  high(pick: (t: Tick) => number | undefined): number {
    let h = 0;
    for (let i = 0; i < this.count; i++) {
      const v = pick(this.slots[(this.next - this.count + i + RING) % RING]!);
      if (v !== undefined && v > h) h = v;
    }
    return h;
  }
}
