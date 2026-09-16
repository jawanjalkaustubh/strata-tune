import type { LoadKind, LoadRun, SensorMeta, StaticSnapshot, Tick } from '../src/collector-types';
import devboxJson from './fixtures/devbox.snapshot.json';
import devboxMetaJson from './fixtures/devbox.meta.json';
import devboxTickJson from './fixtures/devbox.tick.json';

/** A month after the fixture's driver date, so the driver-age check reads ok. */
export const NOW = '2026-09-15T18:00:00Z';

/** The dev box from docs/phase0-probe.txt, a fresh copy each time so a test can bend its own variant. */
export const devbox = (): StaticSnapshot => structuredClone(devboxJson as StaticSnapshot);

/** Every sensor the collector enumerates on the dev box (LHM with the "#n" suffix rule, NVML, PDH), from the same probe. */
export const devboxMeta = (): SensorMeta[] => structuredClone(devboxMetaJson as SensorMeta[]);

/** One tick with the probe's second-pass values and the snapshot's GPU facts. */
export const devboxTick = (): Tick => structuredClone(devboxTickJson as Tick);

type Sample = LoadRun['gpuSamples'][number];

/**
 * A finished 2 Hz load run on the 10 MHz QPC clock; `shape(t)` overrides any sample field at
 * t seconds. The default sample is a 5090 flat out: 550 W of its 600 W limit, so the thermal
 * check's engagement gate passes unless a test says otherwise.
 */
export function loadRun(kind: LoadKind, seconds: number, shape: (t: number) => Partial<Sample> = () => ({})): LoadRun {
  const hz = 10_000_000;
  const qpcStart = 5_000_000_000;
  const gpuSamples: Sample[] = [];
  for (let i = 0; i < seconds * 2; i++) {
    const t = i / 2;
    gpuSamples.push({
      qpc: qpcStart + t * hz, smMhz: 2800, memMhz: 14000, powerMw: 550_000, temperatureC: 70,
      clocksEventReasons: 0, pcieGen: 5, pcieWidth: 16, ...shape(t)
    });
  }
  return { id: `${kind}-${seconds}`, kind, seconds, state: 'done', exitCode: 0, qpcStart, qpcEnd: qpcStart + seconds * hz, gpuSamples, error: null };
}
