import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Phase 8 follow-up item 6 (user agreed 2026-09-16): "Strata Tune never changes voltage, power
 * limits or fan curves, and writes nothing to the CPU; it only adds small clock offsets under
 * the driver's own limits". The sentence stays true only while the collector's one hardware
 * write is NvAPI_GPU_SetPstates20, so this test greps every C# source for any other write
 * export and fails the moment one appears.
 */
const ROOT = join(__dirname, '..', 'collector');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'bin' || name === 'obj') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.cs')) out.push(p);
  }
  return out;
}

/** The names a write to the card, the CPU or the cooler goes by in NVML, NVAPI, LHM and the AMD SMU; `Id...Set...` is how this codebase names a private NVAPI id, so a write resolved by id is caught too. */
const WRITE_EXPORTS = /\b(nvmlDeviceSet\w*|nvmlDeviceReset\w*|NvAPI_GPU_Set\w*|NvAPI_\w*Set\w*|SetPowerManagementLimit|SetPower\w*Limit\w*|\w*LockedClocks\w*|SetCooler\w*|SetFan\w*|SetClockBoost\w*|Set\w*Volt\w*|Volt\w*Set\w*|SetCurve\w*|SetPstate\w*|SetPerfState\w*|SetCoreVoltage\w*|WriteMsr\w*|Wrmsr\w*|SmuWrite\w*|SetPboLimits?\w*|SetCpuPowerLimit\w*|Id\w*Set\w*|Id\w*(Cooler|Fan|Power|Volt|Clock)\w*)\b/g;

/** The one write the plan allows (plan section 16 'write path'): the P0 core and memory clock deltas. */
const ALLOWED = new Set(['NvAPI_GPU_SetPstates20', 'SetPstates20', 'IdSetPstates20']);

describe('the collector writes nothing but P0 clock deltas (phase 8 follow-up item 6)', () => {
  const files = sources(ROOT);

  it('reads the collector, worker and shared sources', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('NvapiPstates.cs'))).toBe(true);
  });

  it('no NVML, NVAPI, MSR or SMU write export other than NvAPI_GPU_SetPstates20 appears in any source', () => {
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(WRITE_EXPORTS)) {
        if (!ALLOWED.has(m[1])) found.push(`${f.slice(ROOT.length + 1)}: ${m[1]}`);
      }
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  /**
   * Every private NVAPI interface this codebase resolves, by id (the way GPU-Z and the OC tools
   * reach them). A new write would arrive as a new id constant and a new Resolve<...>(...) call
   * rather than by name, so the set is enumerated and held to an allow-list of read-only ids
   * plus the one write.
   */
  const READ_ONLY_IDS: Record<string, string> = {
    '0x0150E828': 'NvAPI_Initialize',
    '0xD22BDD7E': 'NvAPI_Unload',
    '0xE5AC921F': 'NvAPI_EnumPhysicalGPUs',
    '0x6C2D048C': 'NvAPI_GetErrorMessage',
    '0x1BE0B8E5': 'NvAPI_GPU_GetBusId',
    '0xC7026A87': 'NvAPI_GPU_GetGpuCoreCount',
    '0x0BE17923': 'NvAPI_GPU_GetShaderSubPipeCount',
    '0xAE5FBCFE': 'NvAPI_GPU_GetTotalSMCount',
    '0xFDC129FA': 'NvAPI_GPU_GetROPCount',
    '0xD8265D24': 'NvAPI_GPU_GetArchInfo',
    '0x6FF81213': 'NvAPI_GPU_GetPstates20'
  };
  const THE_WRITE = '0x0F4DAE6B';

  it('every NVAPI id the collector declares or resolves is a read-only interface or the one P0 delta write', () => {
    const nvapi = files.filter((f) => /Nvapi[A-Za-z]*\.cs$/.test(f));
    expect(nvapi.length).toBeGreaterThanOrEqual(3);
    const declared = new Map<string, string>();
    const resolved: string[] = [];
    for (const f of nvapi) {
      const text = readFileSync(f, 'utf8');
      // `IdName = 0x...` inside any const declaration, single or comma-joined.
      for (const m of text.matchAll(/\b(Id\w+)\s*=\s*(0x[0-9A-Fa-f]{8})\b/g)) declared.set(m[1], m[2].toUpperCase().replace(/^0X/, '0x'));
      for (const m of text.matchAll(/Resolve<[^>]+>\(\s*(?:NvapiInterface\.)?(\w+)\s*\)/g)) resolved.push(m[1]);
    }
    expect(declared.size).toBeGreaterThanOrEqual(12);
    expect(resolved.length).toBeGreaterThanOrEqual(12);
    const allowed = new Set([...Object.keys(READ_ONLY_IDS), THE_WRITE]);
    for (const [name, id] of declared) expect(allowed.has(id), `${name} = ${id} is not a read-only NVAPI id nor the P0 delta write`).toBe(true);
    for (const name of resolved) expect(declared.has(name) || name === 'id', `Resolve<>(${name}) resolves an id that is not declared as a constant`).toBe(true);
    expect([...declared.values()].filter((id) => id === THE_WRITE)).toHaveLength(1);
    expect([...declared.entries()].filter(([name, id]) => /Set/.test(name) && id !== THE_WRITE)).toEqual([]);
  });

  it('the one write is resolved by its NVAPI id and applies clock deltas only, never a voltage entry', () => {
    const pstates = readFileSync(files.find((f) => f.endsWith('NvapiPstates.cs'))!, 'utf8');
    expect(pstates).toContain('IdSetPstates20 = 0x0F4DAE6B');
    // The voltage entries of the pstates struct are read to keep the layout; no code path writes into them.
    expect(pstates).not.toMatch(/VoltDeltaUv\s*=\s*[^=]/);
    expect(pstates).not.toMatch(/OvVoltages\s*\[?[^\]]*\]?\s*=\s*[^=]/);
    expect(pstates).not.toMatch(/OvNumVoltages\s*=\s*[^=0]/);
    // No P/Invoke into a power-limit, locked-clock or fan entry point anywhere in the collector.
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const imports = [...text.matchAll(/\[DllImport\("([^"]+)"[^\]]*\]\s*[^;]*?\s(\w+)\s*\(/g)].map((m) => `${m[1]}:${m[2]}`);
      for (const i of imports) expect(i).not.toMatch(/nvml\.dll:.*Set|nvapi.*:.*Set|SetPower|Locked|Cooler|Fan/i);
    }
  });
});
