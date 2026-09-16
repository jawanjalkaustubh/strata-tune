import { api } from '../../api';
import type { SensorMeta, StaticSnapshot } from '../../collector-types';

let snapshot: Promise<StaticSnapshot> | null = null;
let meta: Promise<SensorMeta[]> | null = null;

/** The snapshot walks WMI and the sensor list is fixed per collector run: fetch each once per connection. */
export function cachedSnapshot(): Promise<StaticSnapshot> {
  if (!snapshot) {
    snapshot = api!.collector.snapshot().catch((e) => {
      snapshot = null;
      throw e;
    });
  }
  return snapshot;
}

export function cachedSensorMeta(): Promise<SensorMeta[]> {
  if (!meta) {
    meta = api!.collector.sensorsMeta().catch((e) => {
      meta = null;
      throw e;
    });
  }
  return meta;
}

/**
 * The collector answers from its first moment and opens the sensor groups behind
 * Tick.warming (phase1-polish item 8), so the list fetched at connect is the CPU group
 * and little else; this takes the complete list once warming has ended.
 */
export function refreshSensorMeta(): Promise<SensorMeta[]> {
  meta = null;
  return cachedSensorMeta();
}

/** A restarted collector may number its sensors differently. */
export function clearStaticCache() {
  snapshot = null;
  meta = null;
}
