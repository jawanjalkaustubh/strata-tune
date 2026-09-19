import type { SensorMeta, SensorType } from '../../collector-types';

export interface Found {
  meta: SensorMeta;
  match: RegExpMatchArray;
}

/**
 * Lookups by hardware type and sensor name, never by id: ids are stable per
 * machine but differ between boards, and on the dev box they are not even
 * unique. Names are LibreHardwareMonitor's own and the same across machines.
 */
export class SensorIndex {
  constructor(readonly meta: SensorMeta[]) {}

  /** Hardware ids whose type matches, optionally narrowed by hardware name. */
  hardware(type: RegExp, name?: (hardwareName: string) => boolean): string[] {
    const ids: string[] = [];
    for (const m of this.meta) {
      if (!type.test(m.hardwareType) || (name && !name(m.hardwareName))) continue;
      if (!ids.includes(m.hardware)) ids.push(m.hardware);
    }
    return ids;
  }

  hardwareName(id: string): string | undefined {
    return this.meta.find((m) => m.hardware === id)?.hardwareName;
  }

  find(hardware: string | string[] | undefined, type: SensorType, name: RegExp): SensorMeta | undefined {
    return this.findAll(hardware, type, name)[0]?.meta;
  }

  /** In tree order, each with the regex match so numbered names ("Core #7") can be indexed. */
  findAll(hardware: string | string[] | undefined, type: SensorType, name: RegExp): Found[] {
    const wanted = hardware === undefined ? undefined : Array.isArray(hardware) ? hardware : [hardware];
    const out: Found[] = [];
    for (const m of this.meta) {
      if (m.sensorType !== type) continue;
      if (wanted && !wanted.includes(m.hardware)) continue;
      const match = name.exec(m.name);
      if (match) out.push({ meta: m, match });
    }
    return out;
  }
}
