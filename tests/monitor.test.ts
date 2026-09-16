import { describe, expect, it } from 'vitest';
import type { SensorMeta, Tick } from '../src/collector-types';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring, RING } from '../src/components/monitor/history';
import { decodeReasons } from '../src/components/monitor/reasons';
import { hasAny, hasBit, IDLE_HINT, SLOWDOWN, THERMAL_OR_BRAKE } from '../src/analysis/nvmlBits';
import { cpuLimits } from '../src/components/monitor/cpuLimits';
import { toneByBand, toneByLimit, toneByThresholds } from '../src/components/monitor/Bar';
import { analysePins } from '../src/components/monitor/pins';
import { cpuLayout, groupCores, mapLoads } from '../src/components/monitor/cpuLayout';
import { gpuLayout } from '../src/components/monitor/gpuLayout';
import { fanState } from '../src/components/monitor/fans';
import { boardRails, railTone, socTone } from '../src/components/monitor/rails';
import { UNKNOWN_VENDOR, vendorOf, vendorsOf } from '../src/components/monitor/vendors';
import { systemPower } from '../src/analysis/power';
import { devbox, devboxMeta, devboxTick } from './fixtures';

const index = new SensorIndex(devboxMeta());
const tick = devboxTick();
const RYZEN = 'AMD Ryzen 9 9950X 16-Core Processor';
const RAPTOR = '13th Gen Intel(R) Core(TM) i9-13900K';

describe('SensorIndex over the dev box tree (379 sensors, names not ids)', () => {
  it('finds hardware by type, narrowed by name, LHM nodes before the synthetic ones', () => {
    expect(index.hardware(/^cpu$/i)).toEqual(['/amdcpu/0']);
    expect(index.hardware(/^(SuperIO|EmbeddedController)$/i)).toEqual(['/lpc/nct6687dr/0']);
    expect(index.hardware(/^Gpu/i)).toEqual(['/gpu-amd/0', '/gpu-nvidia/0', '/nvml/0']);
    expect(index.hardware(/^Gpu/i, (n) => n === 'NVIDIA GeForce RTX 5090')[0]).toBe('/gpu-nvidia/0');
    expect(index.hardwareName('/lpc/nct6687dr/0')).toBe('Nuvoton NCT6687D-R');
  });

  it('finds the named sensors the panels depend on', () => {
    const cpu = index.hardware(/^cpu$/i);
    expect(index.find(cpu, 'Temperature', /Tctl/)?.id).toBe('/amdcpu/0/temperature/2');
    expect(index.find(cpu, 'Power', /^(?:CPU )?Package$/)?.id).toBe('/amdcpu/0/power/0');
    expect(index.findAll(cpu, 'Temperature', /^CCD(\d+) \(Tdie\)$/).map((f) => f.match[1])).toEqual(['1', '2']);
    expect(index.find(['/gpu-nvidia/0'], 'Current', /^12VHPWR Connector$/)?.id).toBe('/gpu-nvidia/0/current/0');
    expect(index.find(cpu, 'Temperature', /Hot ?Spot/i)).toBeUndefined();
  });

  it('keeps the collector\'s "#n" suffix for the two repeated identifiers', () => {
    const pin1 = index.find(['/gpu-nvidia/0'], 'Voltage', /^12VHPWR Pin 1$/);
    expect(pin1?.id).toBe('/gpu-nvidia/0/voltage/0#1');
    expect(index.find(['/gpu-nvidia/0'], 'Voltage', /^GPU Core Voltage$/)?.id).toBe('/gpu-nvidia/0/voltage/0');
    expect(index.find(['/gpu-nvidia/0'], 'Load', /^GPU Bus$/)?.id).toBe('/gpu-nvidia/0/load/3');
    expect(index.find(['/gpu-nvidia/0'], 'Load', /^GPU Memory$/)?.id).toBe('/gpu-nvidia/0/load/3#1');
  });
});

describe('Ring', () => {
  const at = (n: number): Tick => ({ ...tick, qpc: n, sensors: { a: n } });

  it('left-pads the series while the window fills so new samples enter at the right edge', () => {
    const r = new Ring();
    [1, 2, 3].forEach((n) => r.push(at(n)));
    const s = r.series((t) => t.sensors.a);
    expect(s).toHaveLength(RING);
    expect(s.slice(0, RING - 3).every((v) => v === undefined)).toBe(true);
    expect(s.slice(-3)).toEqual([1, 2, 3]);
    expect(r.high((t) => t.sensors.a)).toBe(3);
  });

  it('wraps at 120 and keeps the newest 120 in order', () => {
    const r = new Ring();
    for (let n = 1; n <= RING + 5; n++) r.push(at(n));
    const s = r.series((t) => t.sensors.a);
    expect(s[0]).toBe(6);
    expect(s[RING - 1]).toBe(RING + 5);
    expect(r.high((t) => t.sensors.a)).toBe(RING + 5);
  });
});

describe('perf-limit reasons', () => {
  it('names the header bits, the 0x400 idle marker, and leaves the rest as hex in its own case', () => {
    expect(decodeReasons(0)).toEqual([{ label: 'none', tone: 'ok' }]);
    expect(decodeReasons(0x400)).toEqual([{ label: 'idle (0x400)', tone: 'idle', mono: true }]);
    expect(decodeReasons(0x404).map((r) => r.label)).toEqual(['power cap', 'idle (0x400)']);
    expect(decodeReasons(0x21).map((r) => [r.label, r.tone])).toEqual([['idle', 'idle'], ['thermal', 'bad']]);
    expect(decodeReasons(0x800)).toEqual([{ label: '0x800', tone: 'idle', mono: true }]);
    expect(decodeReasons(0xc4).map((r) => r.label)).toEqual(['power cap', 'thermal (hw)', 'power brake']);
  });

  it('bit tests hold past 32 bits and over the grouped masks', () => {
    expect(hasBit(2 ** 40 + 0x4, 0x4)).toBe(true);
    expect(hasBit(0x400, IDLE_HINT)).toBe(true);
    expect(hasAny(0x404, THERMAL_OR_BRAKE)).toBe(false);
    expect(hasAny(0x404, SLOWDOWN)).toBe(true);
    expect(hasAny(0x80, THERMAL_OR_BRAKE)).toBe(true);
  });
});

describe('cpuLimits from src/data/cpus.json', () => {
  it.each([
    [RYZEN, { tjmax: 95, powerW: 230, powerName: 'PPT', ccds: 2 }],
    ['AMD Ryzen 9 9950X3D 16-Core Processor', { tjmax: 95, powerW: 230, powerName: 'PPT', ccds: 2 }],
    ['AMD Ryzen 9 9900X 12-Core Processor', { tjmax: 95, powerW: 162, powerName: 'PPT', ccds: 2 }],
    ['AMD Ryzen 7 9800X3D 8-Core Processor', { tjmax: 95, powerW: 162, powerName: 'PPT', ccds: 1 }],
    ['AMD Ryzen 7 7700X 8-Core Processor', { tjmax: 95, powerW: 142, powerName: 'PPT', ccds: 1 }],
    ['AMD Ryzen 9 7950X3D 16-Core Processor', { tjmax: 89, powerW: 162, powerName: 'PPT', ccds: 2 }],
    ['AMD Ryzen 5 9600X 6-Core Processor', { tjmax: 95, powerW: 88, powerName: 'PPT', ccds: 1 }],
    [RAPTOR, { tjmax: 100, powerW: 253, powerName: 'PL2', ccds: undefined }],
    ['13th Gen Intel(R) Core(TM) i9-13900KF', { tjmax: 100, powerW: 253, powerName: 'PL2', ccds: undefined }],
    ['Intel(R) Core(TM) Ultra 9 285K', { tjmax: 105, powerW: 250, powerName: 'PL2', ccds: undefined }]
  ])('%s', (name, expected) => {
    expect(cpuLimits(name)).toEqual(expected);
  });

  it('an unknown part gets no tick, never a guess', () => {
    expect(cpuLimits('AMD Ryzen 7 8700G w/ Radeon 780M Graphics')).toEqual({});
    expect(cpuLimits('Intel(R) Core(TM) i5-10400')).toEqual({});
    expect(cpuLimits('')).toEqual({});
    expect(cpuLimits(undefined)).toEqual({});
  });
});

describe('tones', () => {
  it('by limit, by band, by thresholds', () => {
    expect(toneByLimit(50, 95)).toBe('ok');
    expect(toneByLimit(86, 95)).toBe('warn');
    expect(toneByLimit(95, 95)).toBe('bad');
    expect(toneByLimit(95, undefined)).toBe('ok');
    expect(toneByLimit(95, 0, 0.9, 'idle')).toBe('idle');
    expect(toneByBand(12.2, [11.4, 12.6])).toBe('ok');
    expect(toneByBand(11.3, [11.4, 12.6])).toBe('warn');
    expect(toneByThresholds(69, 70, 90)).toBe('ok');
    expect(toneByThresholds(70, 70, 90)).toBe('warn');
    expect(toneByThresholds(90, 70, 90)).toBe('bad');
  });
});

describe('12V-2x6 pin analysis (plan 17a: spread and max/mean)', () => {
  const pins = (amps: (number | undefined)[]) => amps.map((a, i) => ({ n: i + 1, amps: a }));

  it('flags the 590 W mock (7.9–9.0 A, 13 % spread) amber and points at the highest pin', () => {
    const a = analysePins(pins([7.9, 8.2, 8.5, 8.8, 9.0, 8.4]));
    expect(a.tone).toBe('warn');
    expect(a.spreadA).toBeCloseTo(1.1, 5);
    expect(a.spreadPct).toBeCloseTo(12.99, 1);
    expect(a.maxOverMean).toBeCloseTo(1.063, 3);
    expect(a.maxIndex).toBe(4);
  });

  it('an even 600 W (8.3 A per pin) is emerald, not red', () => {
    expect(analysePins(pins([8.3, 8.3, 8.3, 8.3, 8.3, 8.3])).tone).toBe('ok');
  });

  it('a pin at its 9.5 A rating, or a spread past 20 %, is red', () => {
    expect(analysePins(pins([8.0, 8.0, 8.0, 8.0, 8.0, 9.5])).tone).toBe('bad');
    expect(analysePins(pins([6.5, 8.0, 8.0, 8.0, 8.0, 8.9])).tone).toBe('bad');
  });

  it('the dev box idle (0.9 A per pin) is slate: spread there is ADC noise', () => {
    const a = analysePins(pins([0.86, 0.9, 0.9, 0.88, 0.86, 0.86]));
    expect(a.tone).toBe('idle');
    expect(a.live).toBe(6);
    expect(analysePins(pins([undefined, undefined])).live).toBe(0);
  });
});

describe('CPU layout', () => {
  it('maps the 9950X: 16 cores with nominal, effective, SMU and VID ids, two loads each, two CCDs', () => {
    const l = cpuLayout(index, devbox().cpu);
    expect(l.cores).toHaveLength(16);
    expect(l.hybrid).toBe(false);
    expect(l.cores[0]).toMatchObject({ n: 1, nominal: '/amdcpu/0/clock/3', effective: '/amdcpu/0/clock/4', smu: '/amdcpu/0/power/1', vid: '/amdcpu/0/voltage/2' });
    expect(l.cores[0].loads).toEqual(['/amdcpu/0/load/2', '/amdcpu/0/load/3']);
    expect(l.cores[15].loads).toEqual(['/amdcpu/0/load/32', '/amdcpu/0/load/33']);
    expect(l.ccds.map((m) => m.name)).toEqual(['CCD1 (Tdie)', 'CCD2 (Tdie)']);
    expect(l.tctl).toBe('/amdcpu/0/temperature/2');
    expect(l.packageW).toBe('/amdcpu/0/power/0');
    expect(l.avgEffective).toBe('/amdcpu/0/clock/2');
    const groups = groupCores(l, 2);
    expect(groups.map((g) => [g.label, g.cores.length, g.tdie])).toEqual([['CCD1 (Tdie)', 8, '/amdcpu/0/temperature/3'], ['CCD2 (Tdie)', 8, '/amdcpu/0/temperature/4']]);
  });

  it('falls back to the parts table for the die split when the tree has no CCD temperatures', () => {
    const l = cpuLayout(index, devbox().cpu);
    const noCcd = { ...l, ccds: [] };
    expect(groupCores(noCcd, 2).map((g) => [g.label, g.cores.length, g.tdie])).toEqual([['CCD1', 8, undefined], ['CCD2', 8, undefined]]);
    expect(groupCores(noCcd).map((g) => [g.label, g.cores.length])).toEqual([['Cores', 16]]);
  });

  it('mapLoads: SMT pairs, hybrid P-cores first, one-to-one, and a uniform fold without the counts', () => {
    expect(mapLoads(32, 16, { cores: 16, logical: 32 })[0]).toEqual([0, 1]);
    expect(mapLoads(32, 16, { cores: 16, logical: 32 })[15]).toEqual([30, 31]);
    const hybrid = mapLoads(32, 24, { cores: 24, logical: 32 });
    expect(hybrid[0]).toEqual([0, 1]);
    expect(hybrid[7]).toEqual([14, 15]);
    expect(hybrid[8]).toEqual([16]);
    expect(hybrid[23]).toEqual([31]);
    expect(mapLoads(16, 16)[3]).toEqual([3]);
    expect(mapLoads(32, 16)[1]).toEqual([2, 3]);
    expect(mapLoads(0, 16)).toEqual([]);
  });

  it('an Intel hybrid: P/E clusters from the library\'s naming, nominal clock as the big figure, loads by logical index', () => {
    const hw = '/intelcpu/0';
    const meta: SensorMeta[] = [];
    const add = (id: string, name: string, sensorType: SensorMeta['sensorType'], unit = '') =>
      meta.push({ id, hardware: hw, hardwareName: RAPTOR, hardwareType: 'Cpu', name, sensorType, unit });
    for (let n = 1; n <= 24; n++) {
      const type = n <= 8 ? 'P' : 'E';
      add(`${hw}/clock/${n}`, `${type}-Core #${n}`, 'Clock', 'MHz');
      add(`${hw}/temperature/${n}`, `${type}-Core #${n}`, 'Temperature', '°C');
    }
    for (let t = 1; t <= 32; t++) add(`${hw}/load/${t}`, `CPU Core #${t}`, 'Load', '%');
    add(`${hw}/temperature/0`, 'CPU Package', 'Temperature', '°C');
    add(`${hw}/power/0`, 'CPU Package', 'Power', 'W');
    const l = cpuLayout(new SensorIndex(meta), { cores: 24, logical: 32 });
    expect(l.hybrid).toBe(true);
    expect(l.cores).toHaveLength(24);
    expect(l.cores[0]).toMatchObject({ n: 1, type: 'P', nominal: `${hw}/clock/1`, loads: [`${hw}/load/1`, `${hw}/load/2`] });
    expect(l.cores[0].effective).toBeUndefined();
    expect(l.cores[8]).toMatchObject({ n: 9, type: 'E', loads: [`${hw}/load/17`] });
    expect(l.cores[23].loads).toEqual([`${hw}/load/32`]);
    expect(l.tctl).toBe(`${hw}/temperature/0`);
    expect(l.packageW).toBe(`${hw}/power/0`);
    expect(groupCores(l).map((g) => [g.label, g.cores.length])).toEqual([['P-cores', 8], ['E-cores', 16]]);
  });

  it('loads spelled per thread ("P-Core #1 Thread #2") go to their named core', () => {
    const hw = '/intelcpu/0';
    const meta: SensorMeta[] = [];
    const add = (id: string, name: string, sensorType: SensorMeta['sensorType']) =>
      meta.push({ id, hardware: hw, hardwareName: RAPTOR, hardwareType: 'Cpu', name, sensorType, unit: '' });
    add(`${hw}/clock/1`, 'P-Core #1', 'Clock');
    add(`${hw}/clock/2`, 'E-Core #2', 'Clock');
    add(`${hw}/load/1`, 'P-Core #1 Thread #1', 'Load');
    add(`${hw}/load/2`, 'P-Core #1 Thread #2', 'Load');
    add(`${hw}/load/3`, 'E-Core #2', 'Load');
    const l = cpuLayout(new SensorIndex(meta), { cores: 2, logical: 3 });
    expect(l.cores[0].loads).toEqual([`${hw}/load/1`, `${hw}/load/2`]);
    expect(l.cores[1].loads).toEqual([`${hw}/load/3`]);
  });
});

describe('GPU layout', () => {
  it('finds the 5090\'s pins with A, V and W, the connector totals, the fans and the bus load', () => {
    const l = gpuLayout(index, 'NVIDIA GeForce RTX 5090');
    expect(l.pins).toHaveLength(6);
    expect(l.pins[0]).toEqual({ n: 1, ampsId: '/gpu-nvidia/0/current/1', voltsId: '/gpu-nvidia/0/voltage/0#1', wattsId: '/gpu-nvidia/0/power/2' });
    expect(l.connectorA).toBe('/gpu-nvidia/0/current/0');
    expect(l.connectorW).toBe('/gpu-nvidia/0/power/1');
    expect(l.fans.map((f) => f.name)).toEqual(['Fan 1', 'Fan 2']);
    expect(l.fans[0].duty).toBe('/gpu-nvidia/0/control/1');
    expect(l.bus).toBe('/gpu-nvidia/0/load/3');
    expect(l.memJunction).toBe('/gpu-nvidia/0/temperature/3');
    expect(l.hotSpot).toBeUndefined();
  });

  it('without a matching name falls back to the NVIDIA node, never the iGPU', () => {
    expect(gpuLayout(index, undefined).pins).toHaveLength(6);
  });
});

describe('fans and rails', () => {
  it('fanState: unused headers collapse, a stopped fan at high duty is amber with "no tacho"', () => {
    expect(fanState(3053, 80)).toEqual({ unused: false, tone: 'ok' });
    expect(fanState(0, 0)).toEqual({ unused: true, tone: 'idle' });
    expect(fanState(0, 50)).toEqual({ unused: true, tone: 'idle' });
    expect(fanState(0, undefined)).toEqual({ unused: true, tone: 'idle' });
    expect(fanState(undefined, 100)).toEqual({ unused: true, tone: 'idle' });
    expect(fanState(0, 100)).toEqual({ unused: false, tone: 'warn', note: 'no tacho at 100 %' });
  });

  it('the dev box: nine of ten headers read 0 rpm; one (CPU Fan at 100 %) is the amber row', () => {
    const io = index.hardware(/^(SuperIO|EmbeddedController)$/i);
    const fans = index.findAll(io, 'Fan', /./).map((f) => {
      const duty = index.find(io, 'Control', new RegExp(`^${f.meta.name.replace(/\s#\d+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: #\\d+)?$`));
      return fanState(tick.sensors[f.meta.id], duty ? tick.sensors[duty.id] : undefined);
    });
    expect(fans.filter((f) => f.unused)).toHaveLength(8);
    expect(fans.filter((f) => f.tone === 'warn')).toHaveLength(1);
    expect(fans.filter((f) => f.tone === 'ok')).toHaveLength(1);
  });

  it('SoC: the AGESA cap is a tolerance band, and only on Ryzen', () => {
    expect(socTone(1.304)).toBe('ok');
    expect(socTone(1.305)).toBe('ok');
    expect(socTone(1.312)).toBe('warn');
    expect(socTone(1.36)).toBe('bad');
    const io = index.hardware(/^(SuperIO|EmbeddedController)$/i);
    const ryzen = boardRails(index, io, RYZEN);
    expect(ryzen.map((r) => r.label)).toEqual(['+12 V', '+5 V', '+3.3 V', 'Vcore', 'SoC', 'DIMM']);
    const soc = ryzen.find((r) => r.label === 'SoC')!;
    expect(soc.limit).toBe(1.3);
    expect(railTone(soc, tick.sensors[soc.id])).toBe('ok');
    const intel = boardRails(index, io, RAPTOR).find((r) => r.label === 'SoC')!;
    expect(intel.limit).toBeUndefined();
    expect(railTone(intel, 1.35)).toBe('ok');
    const twelve = ryzen[0];
    expect(twelve.band).toEqual([12 * 0.95, 12 * 1.05]);
    expect(railTone(twelve, tick.sensors[twelve.id])).toBe('ok');
  });
});

describe('vendors', () => {
  it.each([
    [RYZEN, 'AMD', '#ED1C24'],
    ['NVIDIA GeForce RTX 5090', 'NVIDIA', '#76B900'],
    ['Micro-Star International Co., Ltd.', 'MSI', '#C8102E'],
    ['ASUSTeK COMPUTER INC.', 'ASUS', '#00539B'],
    ['Gigabyte Technology Co., Ltd.', 'Gigabyte', '#F58220'],
    ['ASRock', 'ASRock', '#00A651'],
    [RAPTOR, 'Intel', '#0071C5'],
    ['Intel(R) Arc(TM) A770 Graphics', 'Intel', '#0071C5'],
    ['Snapdragon(R) X Elite - X1E80100', 'Qualcomm', '#3253DC'],
    ['AMD Radeon RX 7900 XTX', 'AMD', '#ED1C24']
  ])('%s → %s', (name, vendor, colour) => {
    expect(vendorOf(name)).toEqual({ vendor, colour });
  });

  it('unknown or empty is slate, and the snapshot maps to three accents', () => {
    expect(vendorOf('')).toBe(UNKNOWN_VENDOR);
    expect(vendorOf('Some Board Co.')).toEqual({ vendor: '', colour: '#64748b' });
    const v = vendorsOf(devbox());
    expect([v.cpu.vendor, v.gpu.vendor, v.board.vendor]).toEqual(['AMD', 'NVIDIA', 'MSI']);
    expect(vendorsOf(null).cpu).toBe(UNKNOWN_VENDOR);
  });
});

describe('system power estimate (plan 13, the headline number)', () => {
  it('sums the measured package and board power and tags the flat estimates', () => {
    const p = systemPower({ cpuPackageW: 52, gpuBoardW: 63, dimmCount: 2, diskQueues: [0, 0, 1], spinningFans: 3 });
    expect(p.measuredW).toBe(115);
    expect(p.estimatedW).toBeCloseTo(25 + 7 + (0.5 + 0.5 + 6) + 6, 5);
    expect(p.totalW).toBeCloseTo(160, 5);
    expect(p.parts.map((x) => [x.label, x.tag])).toEqual([
      ['CPU package', 'measured'], ['GPU board', 'measured'], ['Board', 'estimated'], ['RAM (2 DIMM)', 'estimated'], ['Drives (3)', 'estimated'], ['Fans (3)', 'estimated']
    ]);
  });

  it('a missing measurement is left out rather than counted as zero', () => {
    const p = systemPower({ gpuBoardW: 63, dimmCount: 0, diskQueues: [], spinningFans: 0 });
    expect(p.measuredW).toBe(63);
    expect(p.parts.map((x) => x.label)).toEqual(['GPU board', 'Board']);
  });
});
