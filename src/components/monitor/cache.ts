import { api } from '../../api';
import type { SensorMeta, StaticSnapshot } from '../../collector-types';

let snapshot: Promise<StaticSnapshot> | null = null;
let meta: Promise<SensorMeta[]> | null = null;

/** The snapshot walks WMI and the sensor list is fixed per collector run: fetch each once per connection. */
export function cachedSnapshot(): Promise<StaticSnapshot> {
  if (!snapshot) {
    snapshot = api!.collector.snapshot()
      .then((s) => {
        rememberSnapshot(s);
        return s;
      })
      .catch((e) => {
        snapshot = null;
        throw e;
      });
  }
  return snapshot;
}

const REMEMBERED_KEY = 'strata-tune.lastSnapshot';

/**
 * The panels take their vendor colours and names from the snapshot, and the collector
 * answers it a second or so after connecting (WMI). Without this the CPU and board panels
 * open slate and turn red once it lands — the user saw the flip (2026-09-16). The machine is
 * the same one as last launch nearly always, so the last snapshot paints the first frame and
 * the live one replaces it when it arrives; a changed part still corrects itself in that
 * second. Storage can be missing or refuse (private window, cleared data): then nothing.
 */
export function rememberedSnapshot(): StaticSnapshot | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    return raw ? (JSON.parse(raw) as StaticSnapshot) : null;
  } catch {
    return null;
  }
}

function rememberSnapshot(s: StaticSnapshot) {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(s));
  } catch {
    /* a full disk or a blocked store only costs the next launch its early colours */
  }
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
