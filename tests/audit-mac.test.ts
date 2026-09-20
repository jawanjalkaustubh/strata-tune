import { describe, expect, it } from 'vitest';
import { runAudit, type AuditFinding, type AuditInputs } from '../src/analysis/audit';
import { isMacSnapshot } from '../src/analysis/audit-mac';
import type { HogsResult, StaticSnapshot } from '../src/collector-types';
import { NOW, cpuRun, devbox, loadRun } from './fixtures';

/**
 * The audit on a Mac (src/analysis/audit-mac.ts): the macOS collector's snapshot of the M5 Max
 * MacBook Pro (2026-09-20) gets its own rule set, with no BIOS or Windows advice anywhere and
 * the Apple GPU judged from the heavy Metal load.
 */
const mac = (over: Partial<StaticSnapshot> = {}): StaticSnapshot => ({
  capturedAt: NOW,
  os: { caption: 'macOS 26.5.1', build: '25F80' },
  chassis: { isLaptop: true, chassisTypes: [] },
  cpu: { name: 'Apple M5 Max', family: 0, model: 0, cores: 18, logical: 18, maxClockMhz: 4608 },
  motherboard: { manufacturer: 'Apple', product: 'MacBook Pro (Mac17,6)', biosVersion: '18000.120.36', biosDate: '' },
  ram: { totalMiB: 49152, modules: [{ slot: 'Unified', partNumber: '', manufacturer: 'Apple', capacityMiB: 49152, configuredMts: 0, reportedMts: 0 }] },
  gpus: [],
  gpuDriver: { version: 'Metal (macOS 26.5.1)', date: null },
  powerPlan: { guid: 'macos-powermode-0', name: 'Automatic', overlayGuid: null },
  disks: [{ deviceId: 'disk0', friendlyName: 'APPLE SSD AP2048Z', mediaType: 'SSD', busType: 'Apple Fabric', sizeBytes: 2001111162880 }],
  volumes: [{ letter: '/', label: 'Macintosh HD', fileSystem: 'APFS', sizeBytes: 1995165736960, freeBytes: 1859641053184, isBoot: true, diskDeviceId: 'disk0' }],
  ollama: [],
  adapters: [{ name: 'Apple M5 Max (40-core GPU)', vendor: 'apple', dedicatedMiB: 38339, driverVersion: 'Metal (macOS 26.5.1)', driverDate: null, integrated: false, cores: 40, maxClockMhz: 1620 }],
  battery: { present: true, onAc: true, percent: 99 },
  ...over
});
const inputs = (snapshot: StaticSnapshot, extra: Partial<AuditInputs> = {}): AuditInputs =>
  ({ snapshot, hogs: null, pcieUnderLoad: null, thermalRamp: null, cpuLoad: null, cpuPptW: null, curveOptimizer: { coAllCore: null }, nowIso: NOW, ...extra });
const byId = (findings: AuditFinding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const audit = (snapshot: StaticSnapshot, extra: Partial<AuditInputs> = {}) => byId(runAudit(inputs(snapshot, extra)));

/** The M5 Max under the heavy Metal load: 1,620 MHz held, 48 W, 80 °C; and the same with the clocks sagging while hot. */
const macHeavy = loadRun('heavy', 20, () => ({ smMhz: 1620, memMhz: 0, powerMw: 48_000, temperatureC: 80, pcieGen: 0, pcieWidth: 0 }));
const macHeavyHot = loadRun('heavy', 20, (t) => ({ smMhz: t < 10 ? 1620 : 1380, memMhz: 0, powerMw: 50_000, temperatureC: t < 10 ? 80 : 96, pcieGen: 0, pcieWidth: 0 }));
const macIdleGpu = loadRun('heavy', 20, () => ({ smMhz: 400, memMhz: 0, powerMw: 800, temperatureC: 45, pcieGen: 0, pcieWidth: 0 }));
const macCpu = cpuRun(20, (t) => ({ packageW: t === 0 ? 4 : 42, tctlC: t === 0 ? 45 : 78, avgEffectiveMhz: t === 0 ? 900 : 4100, maxCoreMhz: 4608 }));
const macCpuHot = cpuRun(20, (t) => ({ packageW: t === 0 ? 4 : 44, tctlC: t === 0 ? 45 : t < 10 ? 88 : 97, avgEffectiveMhz: t === 0 ? 900 : t < 10 ? 4200 : 3700, maxCoreMhz: 4608 }));
const macHogs: HogsResult = { seconds: 5, logicalCpus: 18, processes: [{ pid: 1, name: 'Google Chrome Helper', cpuPercent: 12, workingSetMiB: 900 }] };

describe('the audit on a Mac', () => {
  it('recognises the macOS collector\'s snapshot, and not a Windows one', () => {
    expect(isMacSnapshot(mac())).toBe(true);
    expect(isMacSnapshot(mac({ os: { caption: 'Darwin', build: '' } }))).toBe(true);
    expect(isMacSnapshot(devbox())).toBe(false);
  });

  it('runs its own rule set: no BIOS, no Windows power plan, no NVIDIA rows, and a card that says so', () => {
    const f = audit(mac());
    for (const id of ['expo', 'ram-channels', 'pcie-link', 'rebar', 'gpu-driver-age', 'gpu-power-limit', 'gpu-oc-offsets', 'gpu-units', 'cpu-smt', 'timer-resolution', 'game-on-hdd', 'gpu-coverage']) expect(f[id]).toBeUndefined();
    expect(f['mac-coverage'].state).toBe('info');
    expect(f['mac-coverage'].detail).toContain('no BIOS');
    expect(f['mac-coverage'].detail).toContain('48 GB of unified memory');
    // The coverage card is the one place the Windows words appear, to say they do not apply.
    for (const x of Object.values(f).filter((x) => x.id !== 'mac-coverage')) {
      expect(x.fixWhere).not.toBe('bios');
      expect(x.fixWhere).not.toBe('windows');
      expect(`${x.detail} ${x.fix}`).not.toMatch(/\bBIOS\b|Windows|PBO|Ryzen Master/);
    }
  });

  it('energy mode: Automatic plugged in is fine, Low Power plugged in is the finding, on battery it is by design', () => {
    expect(audit(mac())['power-mode']).toMatchObject({ state: 'ok', fixWhere: 'macos' });
    const low = audit(mac({ powerPlan: { guid: 'macos-powermode-1', name: 'Low Power', overlayGuid: null } }))['power-mode'];
    expect(low.state).toBe('warn');
    expect(low.fix).toContain('System Settings > Battery > Energy Mode');
    const lowOnBattery = audit(mac({ powerPlan: { guid: 'macos-powermode-1', name: 'Low Power', overlayGuid: null }, battery: { present: true, onAc: false, percent: 40 } }))['power-mode'];
    expect(lowOnBattery.state).toBe('info');
    expect(lowOnBattery.detail).toContain('40 %');
    expect(audit(mac({ powerPlan: { guid: 'macos-powermode-2', name: 'High Power', overlayGuid: null } }))['power-mode'].state).toBe('ok');
    expect(audit(mac({ battery: { present: true, onAc: false, percent: 80 } }))['power-mode']).toMatchObject({ state: 'info', severity: 1 });
    expect(audit(mac({ powerPlan: { guid: '', name: '', overlayGuid: null } }))['power-mode'].state).toBe('unknown');
  });

  it('the unified memory card names the working set, the startup disk reads in macOS words, and an external spinning disk is an observation', () => {
    const f = audit(mac());
    expect(f['unified-memory'].detail).toContain('48 GB of unified memory');
    expect(f['unified-memory'].detail).toContain('up to 37 GB');
    expect(f['boot-drive-space']).toMatchObject({ state: 'ok', fixWhere: 'macos' });
    expect(f['boot-drive-space'].detail).toBe('Macintosh HD has 1732 GB free of 1858 GB (93 %).');
    expect(f['hdd-present']).toBeUndefined();
    const full = audit(mac({ volumes: [{ letter: '/', label: 'Macintosh HD', fileSystem: 'APFS', sizeBytes: 1000e9, freeBytes: 50e9, isBoot: true, diskDeviceId: 'disk0' }] }))['boot-drive-space'];
    expect(full.state).toBe('bad');
    expect(full.fix).toContain('System Settings > General > Storage');
    const spinning = audit(mac({
      disks: [...mac().disks, { deviceId: 'disk5', friendlyName: 'WD Elements', mediaType: 'HDD', busType: 'USB', sizeBytes: 4e12 }],
      volumes: [...mac().volumes, { letter: '/Volumes/Archive', label: 'Archive', fileSystem: 'ExFAT', sizeBytes: 4e12, freeBytes: 1e12, isBoot: false, diskDeviceId: 'disk5' }]
    }))['hdd-present'];
    expect(spinning).toMatchObject({ state: 'info' });
    expect(spinning.detail).toContain('Archive (WD Elements)');
  });

  it('GPU thermal headroom is judged from the heavy Metal load against the chip\'s top clock', () => {
    expect(audit(mac())['thermal-headroom'].state).toBe('unknown');
    const held = audit(mac(), { thermalRamp: macHeavy })['thermal-headroom'];
    expect(held.state).toBe('ok');
    expect(held.detail).toContain('1620 to 1620 MHz');
    const hot = audit(mac(), { thermalRamp: macHeavyHot })['thermal-headroom'];
    expect(hot.state).toBe('warn');
    expect(hot.detail).toContain('running out of cooling');
    expect(hot.fix).toContain('hard flat surface');
    const idle = audit(mac(), { thermalRamp: macIdleGpu })['thermal-headroom'];
    expect(idle.state).toBe('unknown');
    expect(idle.detail).toContain('did not engage');
  });

  it('the CPU rules read the all-core load without a parts table: temperature and clocks with no limit invented, power as an observation', () => {
    const f = audit(mac(), { cpuLoad: macCpu });
    expect(f['cpu-thermal'].state).toBe('ok');
    expect(f['cpu-thermal'].detail).toContain('78 °C');
    expect(f['cpu-allcore-clock'].state).toBe('info');
    expect(f['cpu-allcore-clock'].detail).toContain('4.1 GHz effective');
    expect(f['cpu-allcore-clock'].detail).toContain('4.6 GHz');
    expect(f['cpu-package-power']).toMatchObject({ state: 'info', fixWhere: 'none' });
    expect(f['cpu-package-power'].detail).toContain('42 W under the all-core load, from 4.0 W at rest');
    expect(f['cpu-idle-clock'].state).toBe('info');
    const hot = audit(mac(), { cpuLoad: macCpuHot })['cpu-thermal'];
    expect(hot.state).toBe('warn');
    expect(hot.detail).toContain('97 °C');
    const missing = audit(mac())['cpu-thermal'];
    expect(missing.state).toBe('unknown');
  });

  it('background programs and a resident model use macOS words', () => {
    const f = audit(mac({ ollama: [{ name: 'qwen3.8:27b', sizeBytes: 17e9, sizeVramBytes: 17e9 }] }), { hogs: macHogs });
    expect(f['background-hogs']).toMatchObject({ state: 'warn', fixWhere: 'macos' });
    expect(f['background-hogs'].fix).toContain('Login Items');
    expect(f['ai-model-resident'].detail).toContain('17 GB of unified memory');
    expect(f['ai-model-resident'].title).toBe('AI model in unified memory');
  });
});
