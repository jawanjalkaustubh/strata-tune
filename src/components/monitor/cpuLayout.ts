import type { SensorMeta } from '../../collector-types';
import type { SensorIndex } from './sensors';

export type CoreType = 'P' | 'E';

export interface CoreIds {
  /** 1-based, as LibreHardwareMonitor numbers them. */
  n: number;
  /** Set on Intel hybrid parts, where the library names cores "P-Core #n" / "E-Core #n". */
  type?: CoreType;
  nominal?: string;
  effective?: string;
  smu?: string;
  vid?: string;
  /** Per-thread load sensors that belong to this core. */
  loads: string[];
}

export interface CpuLayout {
  cores: CoreIds[];
  /** "CCDn (Tdie)" temperature sensors, in order. */
  ccds: SensorMeta[];
  tctl?: string;
  packageW?: string;
  avgEffective?: string;
  hybrid: boolean;
}

export interface CoreGroupIds {
  label: string;
  tdie?: string;
  cores: CoreIds[];
}

interface CoreName {
  type?: CoreType;
  n: number;
}

// "Core #7", "CPU Core #7", "P-Core #7", "E-Core #17": the library's spelling depends on
// the vendor and, on Intel hybrids, on the core type. `suffix` is what may follow.
const CORE = /^(?:CPU )?(?:([PE])-)?Core #(\d+)/i;
function cored(name: string, suffix: RegExp): CoreName | null {
  const m = CORE.exec(name);
  if (!m || !suffix.test(name.slice(m[0].length))) return null;
  return { type: m[1] ? (m[1].toUpperCase() as CoreType) : undefined, n: +m[2] };
}

/**
 * Which per-thread load sensors belong to which core. With an SMT part every core has two
 * threads, so consecutive pairs fold; on an Intel hybrid only the P-cores do, and Windows
 * numbers those threads first, so the first 2 × (logical − cores) loads pair up and the
 * rest map one per core. Without the snapshot's counts a uniform fold is the best guess.
 */
export function mapLoads(loadCount: number, coreCount: number, cpu?: { cores: number; logical: number }): number[][] {
  if (coreCount === 0 || loadCount === 0) return [];
  const perCore: number[][] = Array.from({ length: coreCount }, () => []);
  if (loadCount === coreCount) {
    for (let i = 0; i < loadCount; i++) perCore[i].push(i);
    return perCore;
  }
  const smt = cpu && cpu.logical === loadCount && cpu.cores === coreCount ? cpu.logical - cpu.cores : -1;
  if (smt >= 0 && smt <= coreCount) {
    for (let i = 0; i < loadCount; i++) {
      const core = i < 2 * smt ? Math.floor(i / 2) : i - smt;
      if (core < coreCount) perCore[core].push(i);
    }
    return perCore;
  }
  const fold = Math.max(1, Math.round(loadCount / coreCount));
  for (let i = 0; i < loadCount; i++) perCore[Math.min(Math.floor(i / fold), coreCount - 1)].push(i);
  return perCore;
}

export function cpuLayout(index: SensorIndex, cpu?: { cores: number; logical: number }): CpuLayout {
  const hw = index.hardware(/^cpu$/i);
  const byCore = new Map<number, CoreIds>();
  const core = (c: CoreName) => {
    let ids = byCore.get(c.n);
    if (!ids) byCore.set(c.n, (ids = { n: c.n, loads: [] }));
    if (c.type) ids.type = c.type;
    return ids;
  };
  for (const f of index.findAll(hw, 'Clock', CORE)) {
    const nominal = cored(f.meta.name, /^$/);
    if (nominal) core(nominal).nominal = f.meta.id;
    const effective = cored(f.meta.name, /^ \(Effective\)$/i);
    if (effective) core(effective).effective = f.meta.id;
  }
  for (const f of index.findAll(hw, 'Power', CORE)) {
    const c = cored(f.meta.name, /^(?: \(SMU\))?$/i);
    if (c) core(c).smu = f.meta.id;
  }
  for (const f of index.findAll(hw, 'Voltage', CORE)) {
    const c = cored(f.meta.name, /^ VID$/i);
    if (c) core(c).vid = f.meta.id;
  }

  // Loads are per logical CPU. Named with a core type or a thread suffix they say which
  // core they belong to; the plain "CPU Core #n" run is mapped by position.
  const loads: { id: string; name: string; core: CoreName }[] = [];
  for (const f of index.findAll(hw, 'Load', CORE)) {
    const c = cored(f.meta.name, /^(?: Thread #\d+)?$/i);
    if (c) loads.push({ id: f.meta.id, name: f.meta.name, core: c });
  }
  const named = loads.length > 0 && loads.every((l) => l.core.type !== undefined || /Thread #/i.test(l.name));
  if (named) {
    for (const l of loads) core(l.core).loads.push(l.id);
  } else {
    const cores = [...byCore.values()].sort((a, b) => a.n - b.n);
    const ordered = loads.sort((a, b) => a.core.n - b.core.n);
    mapLoads(ordered.length, cores.length, cpu).forEach((idx, c) => idx.forEach((i) => cores[c].loads.push(ordered[i].id)));
  }

  const cores = [...byCore.values()].sort((a, b) => a.n - b.n);
  const ccds = index.findAll(hw, 'Temperature', /^CCD(\d+) \(Tdie\)$/).map((f) => f.meta);
  const tctl = index.find(hw, 'Temperature', /Tctl/) ?? index.find(hw, 'Temperature', /^CPU Package$/) ?? index.find(hw, 'Temperature', /^Core Average$/);
  return {
    cores,
    ccds,
    tctl: tctl?.id,
    packageW: index.find(hw, 'Power', /^(?:CPU )?Package$/)?.id,
    avgEffective: index.find(hw, 'Clock', /^Cores \(Average Effective\)$/)?.id,
    hybrid: cores.some((c) => c.type !== undefined)
  };
}

/** Dies for the chip diagram: P/E clusters on a hybrid, CCDs when the tree (or the parts table) says so, else one block. */
export function groupCores(layout: CpuLayout, ccdCount?: number): CoreGroupIds[] {
  const { cores, ccds } = layout;
  if (layout.hybrid) {
    const groups: CoreGroupIds[] = [];
    const p = cores.filter((c) => c.type === 'P');
    const e = cores.filter((c) => c.type === 'E');
    const rest = cores.filter((c) => c.type === undefined);
    if (p.length) groups.push({ label: 'P-cores', cores: p });
    if (e.length) groups.push({ label: 'E-cores', cores: e });
    if (rest.length) groups.push({ label: 'Cores', cores: rest });
    return groups;
  }
  const bySensor = ccds.length >= 2 && cores.length % ccds.length === 0 ? ccds.length : 0;
  const byTable = !bySensor && ccdCount && ccdCount >= 2 && cores.length % ccdCount === 0 ? ccdCount : 0;
  const split = bySensor || byTable;
  if (!split) return [{ label: 'Cores', tdie: ccds[0]?.id, cores }];
  const per = cores.length / split;
  return Array.from({ length: split }, (_, g) => ({
    label: bySensor ? ccds[g].name : `CCD${g + 1}`,
    tdie: bySensor ? ccds[g].id : undefined,
    cores: cores.slice(g * per, (g + 1) * per)
  }));
}
