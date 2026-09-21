import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { IDS, Ring, chipFacts, parseBattery, parseGpuMemoryUsed, sensorsOf, type MacmonSample } from '../electron/mac/sensors';
import { excludedPids, hogsFrom, parseCpuTime, parsePs } from '../electron/mac/hogs';
import { parseDf, parseDiskutil, powerModeOf } from '../electron/mac/snapshot';
import { SensorIndex } from '../src/components/monitor/sensors';
import { cpuLayout, groupCores } from '../src/components/monitor/cpuLayout';
import { igpuLayout } from '../src/components/monitor/gpuLayout';
import { batteryLayout } from '../src/components/monitor/BatteryPanel';
import { freeRamBytes, libraryVram } from '../src/components/advisor/hardware';

/**
 * The macOS collector's sensor rows (electron/mac/sensors.ts) against the Monitor's own layouts:
 * the panels match by hardware type and LibreHardwareMonitor's names, so a macmon sample from an
 * M5 Max (2026-09-20) must resolve through cpuLayout, igpuLayout and batteryLayout unchanged.
 */
const sample = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mac', 'macmon.sample.json'), 'utf8')) as MacmonSample;

const BATTERY_IOREG = `
      "CurrentCapacity" = 97
      "TimeRemaining" = 17
      "Amperage" = 18446744073709550397
      "AppleRawCurrentCapacity" = 8205
      "ExternalConnected" = No
      "BatteryInstalled" = Yes
      "MaxCapacity" = 100
      "InstantAmperage" = 18446744073709550397
      "Temperature" = 3050
      "IsCharging" = No
      "DesignCapacity" = 8579
      "Voltage" = 13137
      "AppleRawMaxCapacity" = 8546
`;

describe('macOS sensor rows resolve through the Monitor layouts', () => {
  const built = sensorsOf('Apple M5 Max', sample, { usedMiB: 847, totalMiB: 38338 }, parseBattery(BATTERY_IOREG));
  const index = new SensorIndex(built.meta);

  it('the CPU node is a hybrid with the P and E cores macmon lists, clocks and loads paired per core', () => {
    const layout = cpuLayout(index, { cores: 18, logical: 18 });
    expect(layout.hybrid).toBe(true);
    expect(layout.cores).toHaveLength(sample.pcpu_cores!.length + sample.ecpu_cores!.length);
    expect(layout.cores.every((c) => c.nominal && c.loads.length === 1)).toBe(true);
    expect(groupCores(layout).map((g) => [g.label, g.cores.length])).toEqual([
      ['P-cores', sample.pcpu_cores!.length],
      ['E-cores', sample.ecpu_cores!.length]
    ]);
    expect(layout.packageW).toBe(IDS.cpuPackageW);
    expect(layout.tctl).toBe(IDS.cpuTempC);
    expect(layout.avgEffective).toBe(IDS.cpuAvgEffectiveMhz);
    expect(built.values[IDS.cpuPackageW]).toBeCloseTo(sample.cpu_power);
  });

  it('the GPU is a library-only node (no NVML): clock, load, power, temperature and the memory rows', () => {
    const gpu = igpuLayout(index, undefined, 'Apple M5 Max');
    expect(gpu).not.toBeNull();
    expect(gpu!.name).toBe('Apple M5 Max');
    expect(gpu!.clock).toBe(IDS.gpuClockMhz);
    expect(gpu!.load).toBe(IDS.gpuLoad);
    expect(gpu!.power).toBe(IDS.gpuPowerW);
    expect(gpu!.temperature).toBe(IDS.gpuTempC);
    expect(gpu!.vramUsed).toBe(IDS.gpuMemUsedMiB);
    expect(gpu!.vramTotal).toBe(IDS.gpuMemTotalMiB);
    expect(libraryVram(built.meta, { qpc: 0, values: built.values }, 'Apple M5 Max')).toEqual({ usedMiB: 847, totalMiB: 38338 });
  });

  it('fans and system power sit on an embedded-controller node; memory available feeds the advisor', () => {
    const io = index.hardware(/^(SuperIO|EmbeddedController)$/i);
    expect(index.findAll(io, 'Fan', /./)).toHaveLength(sample.fans!.length);
    expect(index.find(io, 'Power', /^System Total$/)?.id).toBe(IDS.systemW);
    const free = freeRamBytes(built.meta, { qpc: 0, values: built.values });
    expect(free).toBeCloseTo(sample.memory!.ram_total - sample.memory!.ram_usage, -6);
  });

  it('the battery node carries the rows BatteryPanel reads, with the discharge rate positive and the time left in seconds', () => {
    const b = batteryLayout(index)!;
    expect(b.charge).toBeDefined();
    expect(b.dischargeRate).toBeDefined();
    expect(b.chargeRate).toBeUndefined();
    expect(built.values[b.dischargeRate!]).toBeCloseTo((13.137 * 1219) / 1000, 2);
    expect(built.values[b.timeLeft!]).toBe(17 * 60);
    expect(built.values[b.degradation!]).toBeCloseTo((1 - 8546 / 8579) * 100, 3);
  });

  it("Apple's own cluster names: macmon's S/P labels become super and performance cores, numbered across both, with the core counts as factors", () => {
    const m5 = sensorsOf(chipFacts('Apple M5 Max', { gpuName: 'Apple M5 Max (40-core GPU)', coreLabels: { high: 'S', low: 'P' }, gpuCores: 40 }), sample, null, null);
    const idx = new SensorIndex(m5.meta);
    const layout = cpuLayout(idx, { cores: 18, logical: 18 });
    expect(groupCores(layout).map((g) => [g.label, g.cores.length])).toEqual([
      ['Super cores', sample.pcpu_cores!.length],
      ['Performance cores', sample.ecpu_cores!.length]
    ]);
    expect(layout.cores.map((c) => c.n)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(idx.hardwareName(idx.hardware(/^GpuApple$/)[0])).toBe('Apple M5 Max (40-core GPU)');
    expect(m5.values[IDS.gpuCores]).toBe(40);
    expect(m5.values[IDS.aneCores]).toBe(16);
    expect(m5.values[IDS.anePowerW]).toBeCloseTo(sample.ane_power ?? 0);
    // Labels macmon does not use fall back to P/E.
    const odd = sensorsOf(chipFacts('Apple', { coreLabels: { high: 'X', low: 'P' } }), sample, null, null);
    expect(odd.meta.some((r) => r.name === 'P-Core #1')).toBe(true);
  });

  it('nothing reads as zero for a source that has not answered: no macmon, no battery, no GPU memory', () => {
    const empty = sensorsOf(chipFacts('Apple M5 Max', { neuralEngineCores: null }), null, null, null);
    expect(empty.meta).toEqual([]);
    expect(Object.keys(empty.values)).toEqual([]);
  });
});

describe('the IOKit and shell parsers', () => {
  it('parseBattery reads a charging pack with a positive rate and no time left', () => {
    const b = parseBattery(BATTERY_IOREG.replace('"IsCharging" = No', '"IsCharging" = Yes').replace(/18446744073709550397/g, '2219').replace('"ExternalConnected" = No', '"ExternalConnected" = Yes'))!;
    expect(b.charging).toBe(true);
    expect(b.onAc).toBe(true);
    expect(b.watts).toBeCloseTo((13.137 * 2219) / 1000, 2);
    expect(b.percent).toBe(97);
    expect(parseBattery('nothing here')).toBeNull();
  });

  it('parseGpuMemoryUsed takes the driver-independent figure', () => {
    expect(parseGpuMemoryUsed('"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=2263449600,"In use system memory"=1001078784}')).toBeCloseTo(1001078784 / 1024 ** 2);
    expect(parseGpuMemoryUsed('')).toBeNull();
  });

  it('ps times fold correctly and the app\'s own tree is excluded from the hogs', () => {
    expect(parseCpuTime('0:01.23')).toBeCloseTo(1.23);
    expect(parseCpuTime('10:42.68')).toBeCloseTo(642.68);
    expect(parseCpuTime('1:02:03.50')).toBeCloseTo(3723.5);
    expect(parseCpuTime('2-01:00:00.00')).toBe(2 * 86400 + 3600);
    const text = ['  PID  PPID      TIME    RSS COMM', '    1     0   0:13.99  31328 /sbin/launchd', '  100     1   0:00.00   1024 /Apps/Strata/Electron', '  101   100   0:05.00   2048 /Apps/Strata/Electron Helper', '  200     1   0:10.00   4096 /usr/bin/hog'].join('\n');
    const procs = parsePs(text);
    expect(procs).toHaveLength(4);
    expect([...excludedPids(procs, [100])].sort()).toEqual([100, 101]);
    const after = parsePs(text.replace('0:10.00', '0:20.00').replace('0:05.00', '0:09.00'));
    const hogs = hogsFrom(procs, after, 5, 4, excludedPids(after, [100]));
    expect(hogs[0]).toMatchObject({ pid: 200, name: 'hog', cpuPercent: 50, workingSetMiB: 4 });
    expect(hogs.some((h) => h.pid === 101)).toBe(false);
  });

  it('diskutil, df and pmset outputs parse', () => {
    const info = parseDiskutil('   Device Identifier:         disk3s1s1\n   Volume Name:               Macintosh HD\n   Disk Size:                 2.0 TB (1995165736960 Bytes) (exactly 3896808080 512-Byte-Units)\n   APFS Physical Store:       disk0s2\n');
    expect(info['Volume Name']).toBe('Macintosh HD');
    expect(info['APFS Physical Store']).toBe('disk0s2');
    const df = parseDf('Filesystem     1024-blocks      Used  Available Capacity  Mounted on\n/dev/disk3s1s1  1948404040  12275304 1825038688     1%    /\ndevfs 199 199 0 100% /dev\n/dev/disk3s6    1948404040        20 1825038688     1%    /System/Volumes/VM\n/dev/disk5s1 1000 500 500 50% /Volumes/Photos SD\n');
    expect(df.map((v) => v.mount)).toEqual(['/', '/Volumes/Photos SD']);
    expect(powerModeOf(' powermode            2\n')).toEqual({ guid: 'macos-powermode-2', name: 'High Power' });
    expect(powerModeOf('')).toEqual({ guid: '', name: 'Unknown' });
  });

  it('the ring keeps ten minutes of rows and folds the rest into 1 s summaries', () => {
    const ring = new Ring(600, 3600);
    const start = 1_000_000_000;
    for (let i = 0; i < 1300 * 2; i++) ring.push({ qpc: start + i * 500_000, values: { a: i % 10 } });
    const now = start + 1300 * 2 * 500_000;
    const short = ring.window(60, now);
    expect(short.rows.length).toBeGreaterThanOrEqual(119);
    expect(ring.rows.length).toBeLessThanOrEqual(1201);
    expect(short.summaries).toEqual([]);
    const long = ring.window(1200, now);
    expect(long.rows).toEqual([]);
    expect(long.summaries.length).toBeGreaterThan(1150);
    expect(long.summaries.length).toBeLessThanOrEqual(1201);
    expect(long.summaries[0].min.a).toBeLessThanOrEqual(long.summaries[0].mean.a);
  });
});
