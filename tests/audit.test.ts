import { describe, expect, it } from 'vitest';
import { parseSlot, rankFindings, rankTop, runAudit, type AuditFinding, type AuditInputs } from '../src/analysis/audit';
import type { HogsResult, PhysicalDisk, StaticSnapshot, Volume } from '../src/collector-types';
import { NOW, devbox, loadRun } from './fixtures';

const inputs = (snapshot: StaticSnapshot, extra: Partial<AuditInputs> = {}): AuditInputs =>
  ({ snapshot, hogs: null, pcieUnderLoad: null, thermalRamp: null, nowIso: NOW, ...extra });
const byId = (findings: AuditFinding[]) => Object.fromEntries(findings.map(f => [f.id, f]));
const audit = (snapshot: StaticSnapshot, extra: Partial<AuditInputs> = {}) => byId(runAudit(inputs(snapshot, extra)));
const score = (f: AuditFinding) => f.severity * f.costEstimate;

const quietHogs: HogsResult = { seconds: 5, logicalCpus: 32, processes: [{ pid: 1234, name: 'explorer.exe', cpuPercent: 0.4, workingSetMiB: 180 }] };
const busyHogs: HogsResult = {
  seconds: 5, logicalCpus: 32,
  processes: [{ pid: 4321, name: 'OneDrive.exe', cpuPercent: 40, workingSetMiB: 900 }, ...quietHogs.processes]
};
const flatRuns = { pcieUnderLoad: loadRun('light', 2), thermalRamp: loadRun('heavy', 20) };
/** 15 % sag with HwThermalSlowdown from t = 15 s, the card at 84 °C: the true positive. */
const throttlingRamp = loadRun('heavy', 20, t => ({ smMhz: t < 10 ? 2800 : 2380, temperatureC: t < 10 ? 70 : 84, clocksEventReasons: t >= 15 ? 0x40 : 0 }));
const x8Link = loadRun('light', 2, () => ({ pcieWidth: 8 }));

const ALL_IDS = [
  'expo', 'ram-channels', 'pcie-link', 'rebar', 'power-plan', 'boot-drive-space', 'game-on-hdd',
  'thermal-headroom', 'gpu-driver-age', 'background-hogs', 'power-limit-headroom', 'ai-model-resident'
];

describe('devbox fixture (plan §24: a tuned machine, nothing to fix)', () => {
  it('without load runs the static checks pass and the load checks stay unknown', () => {
    const f = audit(devbox());
    expect(f.expo.state).toBe('ok');
    expect(f.expo.detail).toContain('6200 MT/s, rated 6000 MT/s');
    expect(f['ram-channels'].state).toBe('ok');
    expect(f.rebar.state).toBe('ok');
    expect(f['power-plan'].state).toBe('ok');
    expect(f['power-plan'].detail).toMatch(/AMD recommends/);
    expect(f['boot-drive-space'].state).toBe('ok');
    expect(f['boot-drive-space'].detail).toBe('C: has 720 GB free of 1081 GB (67 %).');
    expect(f['gpu-driver-age'].state).toBe('ok');
    expect(f['power-limit-headroom'].state).toBe('info');
    expect(f['power-limit-headroom'].costText).toMatch(/^No headroom to raise/);
    expect(f['ai-model-resident'].state).toBe('info');
    expect(f['ai-model-resident'].detail).toBe('qwen3-vl:30b holds 24 GB of VRAM; fine for AI work, costs games headroom.');
    expect(f['ai-model-resident'].fix).toContain('ollama stop qwen3-vl:30b');
    expect(f['pcie-link'].state).toBe('unknown');
    expect(f['thermal-headroom'].state).toBe('unknown');
    expect(f['background-hogs'].state).toBe('unknown');
    expect(f['game-on-hdd'].state).toBe('unknown');
    expect(f['game-on-hdd'].detail).toBe('Checked when a game is captured.');
    expect(f['hdd-present']).toBeUndefined();
    expect(Object.keys(f).sort()).toEqual([...ALL_IDS].sort());
  });

  it('with flat load runs and a quiet idle sample every check is ok or info', () => {
    const findings = runAudit(inputs(devbox(), { ...flatRuns, hogs: quietHogs }));
    const f = byId(findings);
    expect(f['pcie-link'].state).toBe('ok');
    expect(f['pcie-link'].detail).toContain('PCIe 5.0 x16');
    expect(f['thermal-headroom'].state).toBe('ok');
    expect(f['thermal-headroom'].detail).toContain('heavy load');
    expect(f['background-hogs'].state).toBe('ok');
    expect(findings.filter(x => x.state === 'bad' || x.state === 'warn')).toEqual([]);
    expect(findings.map(x => x.state).filter(s => s === 'unknown')).toEqual(['unknown']);
  });

  it('every finding carries sentences a non-expert can read', () => {
    for (const f of runAudit(inputs(devbox(), { ...flatRuns, hogs: quietHogs }))) {
      expect(f.title.length).toBeGreaterThan(3);
      expect(f.costText.length).toBeGreaterThan(3);
      expect(f.detail.length).toBeGreaterThan(10);
      expect(f.fix.length).toBeGreaterThan(10);
      expect(f.costEstimate).toBeGreaterThanOrEqual(0);
      expect(f.costEstimate).toBeLessThanOrEqual(1);
    }
  });
});

describe('memory speed', () => {
  it('EXPO off: configured 4800 on a 6000 kit is bad and a BIOS fix', () => {
    const s = devbox();
    s.ram.modules.forEach(m => { m.configuredMts = 4800; });
    const f = audit(s).expo;
    expect(f.state).toBe('bad');
    expect(f.severity).toBe(3);
    expect(f.costEstimate).toBe(0.15);
    expect(f.fixWhere).toBe('bios');
    expect(f.detail).toContain('4800 MT/s but rated for 6000 MT/s');
  });

  it('within 5 % of rated is info, not a flag', () => {
    const s = devbox();
    s.ram.modules.forEach(m => { m.configuredMts = 5800; });
    expect(audit(s).expo.state).toBe('info');
  });

  it('a JEDEC part below its rating is info at zero severity: there is no profile to enable', () => {
    const s = devbox();
    s.ram.modules.forEach(m => { m.partNumber = 'CT16G56C46U5.M8D1'; m.configuredMts = 5200; });
    const f = audit(s).expo;
    expect(f.state).toBe('info');
    expect(f.severity).toBe(0);
    expect(f.detail).toContain('5200 MT/s, below its JEDEC rating of 5600 MT/s');
    expect(f.detail).toContain('no EXPO/XMP profile to enable');
    s.ram.modules.forEach(m => { m.partNumber = 'KVR56U46BS8-16'; m.configuredMts = 4800; });
    expect(audit(s).expo.state).toBe('info');
    // The same layout with the Pro prefix carries a profile, so the same shortfall is a fault.
    s.ram.modules.forEach(m => { m.partNumber = 'CP2K16G60C36U5B'; m.configuredMts = 4800; });
    expect(audit(s).expo.state).toBe('bad');
  });

  it('an unknown kit says so and never flags', () => {
    const s = devbox();
    s.ram.modules.forEach(m => { m.partNumber = 'M378A1K43EB2-CWE'; m.configuredMts = 3200; });
    const f = audit(s).expo;
    expect(f.state).toBe('unknown');
    expect(f.detail).toMatch(/could not determine the rated speed for M378A1K43EB2-CWE/i);
    expect(f.severity).toBe(0);
  });

  it('the DIMM that returns SPD junk after its part number still resolves', () => {
    const s = devbox();
    s.ram.modules[1].partNumber = 'F5-6000J2836G16G��A�A�A�}';
    expect(audit(s).expo.state).toBe('ok');
  });

  it('no modules or no configured speed is unknown', () => {
    const s = devbox();
    s.ram.modules.forEach(m => { m.configuredMts = 0; });
    expect(audit(s).expo.state).toBe('unknown');
    s.ram.modules = [];
    expect(audit(s).expo.state).toBe('unknown');
  });
});

describe('memory channels', () => {
  it('a single stick is bad, up to 20 %; a laptop gets the SO-DIMM wording', () => {
    const s = devbox();
    s.ram.modules = [s.ram.modules[0]];
    const f = audit(s)['ram-channels'];
    expect(f.state).toBe('bad');
    expect(f.costEstimate).toBe(0.2);
    expect(f.fixWhere).toBe('hardware');
    expect(f.detail).toContain('DIMMA2');
    expect(f.fix).toContain('A2 and B2');
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    expect(audit(s)['ram-channels'].fix).toContain('SO-DIMM');
  });

  it('two sticks in one channel is bad', () => {
    const s = devbox();
    s.ram.modules[1].slot = 'DIMMA1';
    const f = audit(s)['ram-channels'];
    expect(f.state).toBe('bad');
    expect(f.detail).toContain('channel A (DIMMA2 and DIMMA1)');
  });

  it('two sticks across channels is ok on ASUS and Gigabyte names too, with a note off the A2/B2 pair', () => {
    const s = devbox();
    s.ram.modules[0].slot = 'DIMM_A2';
    s.ram.modules[1].slot = 'DIMM_B2';
    expect(audit(s)['ram-channels'].state).toBe('ok');
    expect(audit(s)['ram-channels'].detail).not.toContain('four-slot');
    s.ram.modules[0].slot = 'DDR5_A1';
    s.ram.modules[1].slot = 'DDR5_B1';
    const f = audit(s)['ram-channels'];
    expect(f.state).toBe('ok');
    expect(f.detail).toContain('four-slot board');
  });

  it('three sticks warn, four are ok', () => {
    const s = devbox();
    const [a2, b2] = s.ram.modules;
    s.ram.modules = [{ ...a2, slot: 'DIMMA1' }, a2, b2];
    expect(audit(s)['ram-channels'].state).toBe('warn');
    s.ram.modules = [{ ...a2, slot: 'DIMMA1' }, a2, { ...b2, slot: 'DIMMB1' }, b2];
    expect(audit(s)['ram-channels'].state).toBe('ok');
  });

  it('slot names without a channel letter are unknown, not a flag', () => {
    const s = devbox();
    s.ram.modules[0].slot = 'DIMM 1';
    s.ram.modules[1].slot = 'DIMM 2';
    expect(audit(s)['ram-channels'].state).toBe('unknown');
    expect(audit(s)['ram-channels'].fix).toContain('A2 and B2');
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    expect(audit(s)['ram-channels'].fix).not.toContain('A2 and B2');
  });
});

describe('parseSlot', () => {
  it.each([
    ['DIMMA2', 'A', 2],
    ['DIMM_B2', 'B', 2],
    ['DDR5_A1', 'A', 1],
    ['DIMM A2', 'A', 2],
    ['ChannelA-DIMM0', 'A', 0],
    ['A2', 'A', 2],
    ['DIMM 2', null, 2],
    ['DIMM1', null, 1],
    ['Node0_Dimm1', null, null],
    ['', null, null]
  ])('%s → channel %s, slot %s', (locator, channel, slot) => {
    expect(parseSlot(locator)).toEqual({ channel, slot });
  });
});

describe('PCIe link under load', () => {
  it('x8 of x16 is a warning with a reseat fix; a laptop is told to update instead', () => {
    const f = audit(devbox(), { pcieUnderLoad: x8Link })['pcie-link'];
    expect(f.state).toBe('warn');
    expect(f.fixWhere).toBe('hardware');
    expect(f.detail).toContain('PCIe 5.0 x8');
    expect(f.detail).toContain('50 %');
    expect(f.fix).toContain('reseat');
    const s = devbox();
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    expect(audit(s, { pcieUnderLoad: x8Link })['pcie-link'].fix).not.toContain('reseat');
  });

  it('gen 3 x16 on a gen 5 slot is bad with a BIOS fix', () => {
    const f = audit(devbox(), { pcieUnderLoad: loadRun('light', 2, () => ({ pcieGen: 3 })) })['pcie-link'];
    expect(f.state).toBe('bad');
    expect(f.fixWhere).toBe('bios');
    expect(f.fix).toContain('Gen 5');
  });

  it('takes the best link seen, so idle-downclocked samples do not count', () => {
    const run = loadRun('light', 2, t => (t < 1 ? { pcieGen: 1, pcieWidth: 16 } : {}));
    expect(audit(devbox(), { pcieUnderLoad: run })['pcie-link'].state).toBe('ok');
  });

  it('is unknown without a finished run or without a GPU', () => {
    const running = { ...x8Link, state: 'running' as const, qpcEnd: null };
    expect(audit(devbox(), { pcieUnderLoad: running })['pcie-link'].state).toBe('unknown');
    const s = devbox();
    s.gpus = [];
    expect(audit(s, { pcieUnderLoad: x8Link })['pcie-link'].state).toBe('unknown');
  });
});

describe('Resizable BAR', () => {
  it('256 MiB is off and bad; a laptop is not sent into a BIOS it does not have', () => {
    const s = devbox();
    s.gpus[0].bar1TotalMiB = 256;
    const f = audit(s).rebar;
    expect(f.state).toBe('bad');
    expect(f.fixWhere).toBe('bios');
    expect(f.costEstimate).toBe(0.1);
    expect(f.detail).toContain('256 MiB window');
    expect(f.fix).toContain('Above 4G Decoding');
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    expect(audit(s).rebar.fix).toContain('Laptops rarely expose');
  });

  it('a BAR between 512 MiB and 90 % of VRAM is a warning', () => {
    const s = devbox();
    s.gpus[0].bar1TotalMiB = 8192;
    expect(audit(s).rebar.state).toBe('warn');
  });

  it('is unknown when the driver reports no BAR', () => {
    const s = devbox();
    s.gpus[0].bar1TotalMiB = 0;
    expect(audit(s).rebar.state).toBe('unknown');
  });
});

describe('power plan', () => {
  it('laptop on Balanced warns; on Power saver is bad; on High performance is ok', () => {
    const s = devbox();
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    const balanced = audit(s)['power-plan'];
    expect(balanced.state).toBe('warn');
    expect(balanced.costEstimate).toBe(0.2);
    expect(balanced.fixWhere).toBe('windows');
    s.powerPlan = { guid: 'a1841308-3541-4fab-bc81-f71556f20b4a', name: 'Power saver', overlayGuid: null };
    expect(audit(s)['power-plan'].state).toBe('bad');
    s.powerPlan = { guid: '8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C', name: 'High performance', overlayGuid: null };
    expect(audit(s)['power-plan'].state).toBe('ok');
    s.powerPlan = { guid: 'e9a42b02-d5df-448d-aa00-03f14749eb61', name: 'Ultimate Performance', overlayGuid: null };
    expect(audit(s)['power-plan'].state).toBe('ok');
  });

  it('a Windows 11 laptop is judged by its power-mode overlay, not the Balanced scheme it has to keep', () => {
    const s = devbox();
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    s.powerPlan = { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', overlayGuid: 'DED574B5-45A0-4F42-8737-46345C09C238' };
    const best = audit(s)['power-plan'];
    expect(best.state).toBe('ok');
    expect(best.detail).toContain('Best performance');
    s.powerPlan.overlayGuid = '3af9b8d9-7c97-431d-ad78-34a8bfea439f';
    expect(audit(s)['power-plan'].state).toBe('ok');
    s.powerPlan.overlayGuid = '961cc777-2547-4f9d-8174-7d86181b8a7a';
    const saver = audit(s)['power-plan'];
    expect(saver.state).toBe('bad');
    expect(saver.detail).toContain('Best power efficiency');
    // A desktop keeps the desktop rule whatever the slider says.
    s.chassis = { isLaptop: false, chassisTypes: [3] };
    expect(audit(s)['power-plan'].state).toBe('ok');
  });

  it('desktop Intel: Balanced ok, Power saver info, custom plan info at zero cost', () => {
    const s = devbox();
    s.cpu.name = '13th Gen Intel(R) Core(TM) i9-13900K';
    expect(audit(s)['power-plan'].state).toBe('ok');
    expect(audit(s)['power-plan'].detail).not.toMatch(/AMD/);
    s.powerPlan = { guid: 'a1841308-3541-4fab-bc81-f71556f20b4a', name: 'Power saver', overlayGuid: null };
    const saver = audit(s)['power-plan'];
    expect(saver.state).toBe('info');
    expect(saver.severity).toBe(1);
    s.powerPlan = { guid: '11111111-2222-3333-4444-555555555555', name: 'MSI Gaming', overlayGuid: null };
    const custom = audit(s)['power-plan'];
    expect(custom.state).toBe('info');
    expect(custom.severity).toBe(0);
  });

  it('is unknown without a plan GUID', () => {
    const s = devbox();
    s.powerPlan = { guid: '', name: '', overlayGuid: null };
    expect(audit(s)['power-plan'].state).toBe('unknown');
  });
});

describe('boot drive', () => {
  it('95 % full is bad and severe', () => {
    const s = devbox();
    const c = s.volumes.find(v => v.isBoot)!;
    c.freeBytes = Math.round(c.sizeBytes * 0.05);
    const f = audit(s)['boot-drive-space'];
    expect(f.state).toBe('bad');
    expect(f.severity).toBe(3);
    expect(f.costEstimate).toBe(0.3);
    expect(f.costText).toMatch(/^Severe/);
    expect(f.fixWhere).toBe('windows');
  });

  it('12 % free is a warning; no boot volume is unknown', () => {
    const s = devbox();
    const c = s.volumes.find(v => v.isBoot)!;
    c.freeBytes = Math.round(c.sizeBytes * 0.12);
    expect(audit(s)['boot-drive-space'].state).toBe('warn');
    s.volumes = [];
    expect(audit(s)['boot-drive-space'].state).toBe('unknown');
  });
});

describe('hard drives', () => {
  const hdd: PhysicalDisk = { deviceId: '3', friendlyName: 'WDC WD40EZAZ-00SF3B0', mediaType: 'HDD', busType: 'SATA', sizeBytes: 4000787030016 };
  const h: Volume = { letter: 'H', label: 'Archive', fileSystem: 'NTFS', sizeBytes: 4000787030016, freeBytes: 1e12, isBoot: false, diskDeviceId: '3' };

  it('a fixed HDD volume adds an info finding naming it; the game check stays unknown', () => {
    const s = devbox();
    s.disks.push(hdd);
    s.volumes.push(h);
    const f = audit(s);
    expect(f['hdd-present'].state).toBe('info');
    expect(f['hdd-present'].detail).toContain('H: (WDC WD40EZAZ-00SF3B0) is a spinning hard drive');
    expect(f['game-on-hdd'].state).toBe('unknown');
  });

  it('a USB hard drive is not a game drive and is left alone', () => {
    const s = devbox();
    s.disks.push({ ...hdd, busType: 'USB' });
    s.volumes.push(h);
    expect(audit(s)['hdd-present']).toBeUndefined();
  });
});

describe('thermal headroom (plan §8: heavy load, engagement gate, verdict from the steady window)', () => {
  it('a 15 % sag with HwThermalSlowdown set is bad', () => {
    const f = audit(devbox(), { thermalRamp: throttlingRamp })['thermal-headroom'];
    expect(f.state).toBe('bad');
    expect(f.severity).toBe(3);
    expect(f.costEstimate).toBe(0.15);
    expect(f.fixWhere).toBe('hardware');
    expect(f.detail).toContain('thermal throttling under the heavy load');
    expect(f.detail).toContain('15 %');
    expect(f.detail).toContain('84 °C');
  });

  it('SwThermalSlowdown, HwSlowdown and HwPowerBrake count as throttling too', () => {
    for (const bit of [0x20, 0x8, 0x80]) {
      const run = loadRun('heavy', 20, t => ({ clocksEventReasons: t > 18 ? bit : 0 }));
      expect(audit(devbox(), { thermalRamp: run })['thermal-headroom'].state).toBe('bad');
    }
  });

  it('a 15 % sag at 82 °C with no bit warns at the sag', () => {
    const warm = loadRun('heavy', 20, t => ({ smMhz: t < 10 ? 2800 : 2380, temperatureC: t < 10 ? 70 : 82 }));
    const f = audit(devbox(), { thermalRamp: warm })['thermal-headroom'];
    expect(f.state).toBe('warn');
    expect(f.severity).toBe(2);
    expect(f.costEstimate).toBe(0.15);
    expect(f.detail).toContain('running out of thermal headroom');
  });

  it('worker start-up samples at idle clocks do not dilute the verdict', () => {
    const late = loadRun('heavy', 20, t => ({ smMhz: t < 3 ? 1200 : t < 10 ? 2800 : 2380, temperatureC: 82 }));
    expect(audit(devbox(), { thermalRamp: late })['thermal-headroom'].state).toBe('warn');
  });

  it('a sag on a cool card with no bit is info, never hardware advice; 5 % is ok', () => {
    const cool = loadRun('heavy', 20, t => ({ smMhz: t < 10 ? 2800 : 2464, temperatureC: 58 }));
    const f = audit(devbox(), { thermalRamp: cool })['thermal-headroom'];
    expect(f.state).toBe('info');
    expect(f.severity).toBe(0);
    expect(f.detail).toContain('nothing points to heat');
    const five = loadRun('heavy', 20, t => ({ smMhz: t < 10 ? 2800 : 2660 }));
    expect(audit(devbox(), { thermalRamp: five })['thermal-headroom'].state).toBe('ok');
  });

  it('the power cap with steady clocks is normal: power-limited at N W (dev box: 599 W, 51 °C, 0x4)', () => {
    const capped = loadRun('heavy', 20, t => ({ smMhz: 3215, temperatureC: 51, powerMw: 599_000, clocksEventReasons: t >= 1 ? 0x4 : 0x400 }));
    const f = audit(devbox(), { thermalRamp: capped })['thermal-headroom'];
    expect(f.state).toBe('ok');
    expect(f.detail).toContain('Power-limited at 599 W, normal');
  });

  it('unknown unless the load engaged (dev box light ramp: 65 W of 600 W, 2878 to 2432 MHz at 29 °C)', () => {
    const light = loadRun('light', 20, t => ({ smMhz: t < 10 ? 2878 : 2432, temperatureC: 29, powerMw: 65_000, clocksEventReasons: 0x400 }));
    const f = audit(devbox(), { thermalRamp: light })['thermal-headroom'];
    expect(f.state).toBe('unknown');
    expect(f.severity).toBe(0);
    expect(f.detail).toContain('did not engage');
    expect(f.detail).toContain('65 W of its 600 W limit');
  });

  it('a card pre-warmed by a game that settles its boost in the first seconds is not a warning', () => {
    const settling = loadRun('heavy', 20, t => ({ smMhz: t < 5 ? 2878 : 2432, temperatureC: t < 5 ? 72 : 60, clocksEventReasons: 0x400 }));
    const f = audit(devbox(), { thermalRamp: settling })['thermal-headroom'];
    expect(['ok', 'info']).toContain(f.state);
    expect(f.severity).toBe(0);
  });

  it('an unfinished or too-short run, or a card with no power limit, is unknown', () => {
    const running = { ...throttlingRamp, state: 'running' as const, qpcEnd: null };
    expect(audit(devbox(), { thermalRamp: running })['thermal-headroom'].state).toBe('unknown');
    expect(audit(devbox(), { thermalRamp: loadRun('heavy', 2) })['thermal-headroom'].state).toBe('unknown');
    const s = devbox();
    s.gpus[0].powerLimitMw = 0;
    expect(audit(s, { thermalRamp: throttlingRamp })['thermal-headroom'].state).toBe('unknown');
  });
});

describe('driver age', () => {
  it('older than 180 days is info; no date is unknown; the fix names the maker', () => {
    const s = devbox();
    s.gpuDriver.date = '2025-12-01';
    const f = audit(s)['gpu-driver-age'];
    expect(f.state).toBe('info');
    expect(f.detail).toMatch(/616\.92 is \d+ days old/);
    expect(f.fix).toContain('NVIDIA');
    s.gpus = [];
    expect(audit(s)['gpu-driver-age'].fix).not.toContain('NVIDIA');
    s.gpuDriver.date = null;
    expect(audit(s)['gpu-driver-age'].state).toBe('unknown');
  });
});

describe('background hogs', () => {
  it('a process at 40 % CPU is a warning that names it', () => {
    const f = audit(devbox(), { hogs: busyHogs })['background-hogs'];
    expect(f.state).toBe('warn');
    expect(f.detail).toContain('OneDrive.exe (40 % CPU');
    expect(f.detail).not.toContain('explorer.exe');
  });

  it('names at most three and counts the rest; a 3 GB working set counts too', () => {
    const many: HogsResult = {
      seconds: 5, logicalCpus: 32,
      processes: ['a.exe', 'b.exe', 'c.exe', 'd.exe'].map((name, i) => ({ pid: i, name, cpuPercent: 10 - i, workingSetMiB: 100 }))
        .concat([{ pid: 9, name: 'chrome.exe', cpuPercent: 1, workingSetMiB: 3072 }])
    };
    const f = audit(devbox(), { hogs: many })['background-hogs'];
    expect(f.detail).toContain('a.exe');
    expect(f.detail).toContain('c.exe');
    expect(f.detail).not.toContain('d.exe');
    expect(f.detail).toContain('and 2 more');
  });

  it('WSL or Hyper-V guest memory (vmmem) is information with its own wording, not a program to close', () => {
    const wsl: HogsResult = { seconds: 5, logicalCpus: 32, processes: [{ pid: 77, name: 'vmmemWSL', cpuPercent: 0.2, workingSetMiB: 6144 }, ...quietHogs.processes] };
    const f = audit(devbox(), { hogs: wsl })['background-hogs'];
    expect(f.state).toBe('info');
    expect(f.severity).toBe(1);
    expect(f.detail).toContain('vmmemWSL holds 6.0 GB');
    expect(f.fix).toContain('VM');
    const both = { ...wsl, processes: [...busyHogs.processes, ...wsl.processes] };
    const w = audit(devbox(), { hogs: both })['background-hogs'];
    expect(w.state).toBe('warn');
    expect(w.detail).toContain('OneDrive.exe');
    expect(w.detail).toContain('vmmemWSL holds');
  });
});

describe('power limit and AI model', () => {
  it('a limit below the maximum is info with the headroom in watts', () => {
    const s = devbox();
    s.gpus[0].powerLimitMw = 450000;
    const f = audit(s)['power-limit-headroom'];
    expect(f.state).toBe('info');
    expect(f.costText).toBe('150 W of headroom.');
    s.gpus[0].powerMaxLimitMw = 0;
    expect(audit(s)['power-limit-headroom'].state).toBe('unknown');
  });

  it('Ollama absent or empty is ok', () => {
    const s = devbox();
    s.ollama = null;
    expect(audit(s)['ai-model-resident'].state).toBe('ok');
    s.ollama = [];
    expect(audit(s)['ai-model-resident'].state).toBe('ok');
  });
});

describe('ranking', () => {
  const brokenBox = () => {
    const s = devbox();
    s.ram.modules = [{ ...s.ram.modules[0], configuredMts: 4800 }];
    s.gpus[0].bar1TotalMiB = 256;
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    const c = s.volumes.find(v => v.isBoot)!;
    c.freeBytes = Math.round(c.sizeBytes * 0.05);
    return runAudit(inputs(s, { pcieUnderLoad: x8Link, thermalRamp: throttlingRamp, hogs: busyHogs }));
  };

  it('orders by severity × cost, BIOS fixes first on a tie, check order after that', () => {
    const findings = brokenBox();
    expect(findings).toHaveLength(12);
    expect(findings.slice(0, 9).map(f => f.id)).toEqual([
      'boot-drive-space',   // 3 × 0.30
      'ram-channels',       // 3 × 0.20
      'expo',               // 3 × 0.15, bios
      'thermal-headroom',   // 3 × 0.15, hardware
      'power-plan',         // 2 × 0.20
      'rebar',              // 2 × 0.10, bios
      'background-hogs',    // 2 × 0.10, windows
      'pcie-link',          // 2 × 0.05, earlier check
      'ai-model-resident'   // 1 × 0.10
    ]);
    for (let i = 1; i < findings.length; i++) expect(score(findings[i - 1])).toBeGreaterThanOrEqual(score(findings[i]));
  });

  it('rankTop returns five, in the same order, without touching its input', () => {
    const findings = brokenBox();
    const reversed = [...findings].reverse();
    const top = rankTop(reversed, 5);
    expect(top).toHaveLength(5);
    expect(top.map(f => f.id)).toEqual(findings.slice(0, 5).map(f => f.id));
    expect(reversed[0].id).toBe(findings[findings.length - 1].id);
    expect(rankFindings(reversed)).not.toBe(reversed);
    expect(rankTop(runAudit(inputs(devbox())), 5)).toHaveLength(5);
  });
});

describe('missing inputs never flag', () => {
  it('an empty snapshot with no runs yields only ok and unknown at zero cost', () => {
    const empty: StaticSnapshot = {
      capturedAt: NOW,
      os: { caption: '', build: '' },
      chassis: { isLaptop: false, chassisTypes: [] },
      cpu: { name: '', family: 0, model: 0, cores: 0, logical: 0, maxClockMhz: 0 },
      motherboard: { manufacturer: '', product: '', biosVersion: '', biosDate: '' },
      ram: { totalMiB: 0, modules: [] },
      gpus: [],
      gpuDriver: { version: '', date: null },
      powerPlan: { guid: '', name: '', overlayGuid: null },
      disks: [],
      volumes: [],
      ollama: null
    };
    const findings = runAudit(inputs(empty));
    expect(findings).toHaveLength(12);
    for (const f of findings) {
      expect(['ok', 'unknown']).toContain(f.state);
      expect(f.severity).toBe(0);
      expect(f.costEstimate).toBe(0);
    }
  });

  it('a laptop with an empty snapshot still does not flag its power plan', () => {
    const s = devbox();
    s.chassis = { isLaptop: true, chassisTypes: [10] };
    s.powerPlan = { guid: '', name: '', overlayGuid: null };
    expect(audit(s)['power-plan'].state).toBe('unknown');
  });
});
