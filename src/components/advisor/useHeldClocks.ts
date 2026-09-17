import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { HardwareFacts } from './hardware';
import { loadHeldClocks, saveHeldClocks } from './heldClocks';
import { loadedClocks, raise, type HeldClocks } from './thisCard';

/** The bandwidth sweep reaches P0 within its first pass; 4 Hz sees it many times over in a 3 s run. */
const POLL_MS = 250;
/** Between runs the card is read at a walking pace: one loopback GET, no load on the card (plan section 20). */
const PASSIVE_MS = 2000;

export interface Held {
  /** The highest clocks ever seen held under load on this card and driver: its record. */
  held: HeldClocks | null;
  /** The most recent loaded reading, which falls below the record when a tune is no longer applied (the vendor tool closed). */
  latest: HeldClocks | null;
}

/**
 * The clocks this card holds under load (plan section 10: ceilings come from live clocks,
 * not tables). Only a loaded reading counts (thisCard.ts loadedClocks): the snapshot's
 * clocks seed the value when the page opens on a busy card, what earlier runs stored seeds
 * it otherwise. While the page is open /gpu is read every two seconds, so whatever loads the
 * card meanwhile (a game, a sibling app's render) shows the clock it holds without a run of
 * our own; while the page itself loads the card (Measure, Calibrate) `watch()` polls at 4 Hz
 * and, when the run succeeds, its high-water becomes the latest reading and raises the
 * record. The record is never lowered: a run that holds less than it is the "not applied
 * now" line on the stats card, not a new ceiling.
 */
export function useHeldClocks(facts: HardwareFacts): Held & { watch: () => (keep: boolean) => void } {
  const [state, setState] = useState<Held>({ held: null, latest: null });
  const { gpu, gpuName, driver } = facts;
  // The passive poll compares against the latest value without re-arming on every rise.
  const current = useRef<Held>(state);
  current.current = state;

  const see = useCallback(
    (reading: HeldClocks) => {
      const seen = current.current.held;
      const record = raise(seen, reading)!;
      setState({ held: record, latest: reading });
      if (!seen || record.smMhz > seen.smMhz || record.memMhz > seen.memMhz) saveHeldClocks(gpuName, driver, record);
    },
    [gpuName, driver]
  );

  useEffect(() => {
    const seed = gpu ? loadedClocks(gpu) : null;
    setState({ held: gpu ? raise(loadHeldClocks(gpuName, driver), seed) : null, latest: seed });
  }, [gpu, gpuName, driver]);

  useEffect(() => {
    if (!api || !gpu) return;
    const id = setInterval(() => {
      api!.collector
        .gpu()
        .then((g) => {
          const reading = g[0] ? loadedClocks(g[0]) : null;
          if (reading) see(reading);
        })
        .catch(() => {
          /* the collector went away; the status pill says so */
        });
    }, PASSIVE_MS);
    return () => clearInterval(id);
  }, [gpu, see]);

  const watch = useCallback(() => {
    if (!api || !gpu) return () => {};
    let run: HeldClocks | null = null;
    const id = setInterval(() => {
      api!.collector
        .gpu()
        .then((g) => {
          // Every sample counts here: the run is our own load, and its high-water is what the card held.
          if (g[0]) run = raise(run, g[0].clocks);
        })
        .catch(() => {
          /* the collector went away mid-run; the run's result says so itself */
        });
    }, POLL_MS);
    return (keep: boolean) => {
      clearInterval(id);
      if (keep && run) see(run);
    };
  }, [gpu, see]);

  return { ...state, watch };
}
