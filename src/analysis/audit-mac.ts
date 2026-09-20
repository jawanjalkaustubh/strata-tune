/**
 * The audit on a Mac (docs/MACOS.md). The Windows rules read EXPO, ReBAR, the PCIe link, the
 * Windows power plan, NVIDIA's driver and the timer resolution; none of that exists on Apple
 * Silicon, and the advice would send someone to a BIOS a Mac does not have. This rule set
 * judges what the macOS collector can measure - the energy mode, the unified memory, the boot
 * volume, the GPU and CPU under the Metal worker's loads, the background programs - and one
 * card says what a Mac has no equivalent of. Same contract as audit.ts: a missing input is
 * 'unknown', never a fault; every sentence is written for someone new to macOS.
 */
import type { LoadRun, StaticSnapshot } from '../collector-types';
import {
  CPU_RUN_MISSING, CPU_SAG_WARN, SAG_WARN, checkAiModel, checkCpuIdleClock, checkHogs, cpuSteady, doneSamples, endsOf, finding, finite, ghz, gib, info, list, mean, ok, pct,
  rankFindings, steadyWindow, unknown, type AuditFinding, type AuditInputs, type Base
} from './audit';
import { discreteAdapter } from './adapters';

/** The macOS collector names the OS and lists the Apple GPU as an adapter (electron/mac/snapshot.ts); either says this is a Mac. */
export function isMacSnapshot(s: Pick<StaticSnapshot, 'os' | 'adapters'>): boolean {
  return /^macOS\b/i.test(s.os.caption) || (s.adapters ?? []).some((a) => a.vendor === 'apple');
}

/** pmset's power mode as the snapshot encodes it (electron/mac/snapshot.ts powerModeOf). */
const POWER_MODE = /^macos-powermode-(\d)$/;
/** The GPU load engaged when the clocks held this share of the chip's top state, or drew this much power where no clock table is known. */
const GPU_ENGAGED_CLOCK = 0.7;
const GPU_ENGAGED_W = 5;
/** Apple Silicon paces itself near these; a sag with the package this warm is the cooler, below it the chip's own budget. */
const GPU_WARM_C = 85;
const CPU_WARM_C = 90;
const MIB = 1024 ** 2;

const macCoverage = (s: StaticSnapshot): AuditFinding => {
  const base: Base = { id: 'mac-coverage', title: 'What is checked on a Mac', costText: 'Nothing at stake: what this version can and cannot check on Apple Silicon.', fixWhere: 'none' };
  const gpu = discreteAdapter(s);
  return finding(base, info(
    `${gpu ? `${gpu.name}${gpu.cores ? '' : ''} with ${gib(s.ram.totalMiB * MIB)} GB of unified memory` : 'This Mac'}: the audit reads the energy mode, the boot volume, the memory pool, the GPU and CPU under the Metal worker's loads and the background programs. A Mac has no BIOS, no EXPO/XMP, no Resizable BAR, no PCIe graphics link, no Windows power plan, no separate GPU driver and no timer-resolution setting, so those checks do not exist here rather than reading "unknown".`
  ));
};

function checkEnergyMode(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'power-mode', title: 'Energy mode', costText: 'Low Power holds the CPU and GPU back; on battery macOS trims peak power by design.', fixWhere: 'macos' };
  const m = POWER_MODE.exec(s.powerPlan.guid.trim());
  if (!m) return finding(base, unknown('macOS did not report the energy mode.'));
  const mode = Number(m[1]);
  const onBattery = !!s.battery?.present && !s.battery.onAc;
  const settings = 'System Settings > Battery > Energy Mode (on the power adapter and on battery separately)';
  if (mode === 1) {
    if (onBattery) {
      return finding(base, {
        state: 'info', severity: 1, costEstimate: 0.1, costText: 'Large while unplugged: Low Power trims the CPU and GPU to stretch the battery.',
        detail: `Low Power Mode on battery${s.battery?.percent !== null && s.battery?.percent !== undefined ? ` (${s.battery.percent} %)` : ''}: macOS holds the CPU and GPU back to save charge, which is what it is for unplugged.`,
        fix: `Plug in for heavy work, or set the battery side of ${settings} to Automatic.`
      });
    }
    return finding(base, { state: 'warn', severity: 2, costEstimate: 0.2, detail: 'Low Power Mode while plugged in: the CPU and GPU are held back for no battery gain.', fix: `Set ${settings} to Automatic, or High Power on a MacBook Pro that offers it.` });
  }
  if (mode === 2) return finding(base, ok(`High Power: the fans run earlier so sustained loads keep their clocks${onBattery ? '; on battery macOS still trims peak power' : ''}.`));
  if (mode === 0) {
    if (onBattery) {
      return finding(base, {
        state: 'info', severity: 1, costEstimate: 0.05, costText: 'Small: on battery macOS trims peak power for long loads.',
        detail: `Automatic, on battery${s.battery?.percent !== null && s.battery?.percent !== undefined ? ` (${s.battery.percent} %)` : ''}: macOS scales the chip itself and trims sustained power unplugged.`,
        fix: 'Plug in before a long render or a model run; nothing to change in settings.'
      });
    }
    return finding(base, ok('Automatic: macOS scales the CPU and GPU itself; High Power, where the Mac offers it, only spins the fans earlier for sustained loads.'));
  }
  return finding(base, unknown(`Energy mode ${mode} is not one this version knows.`));
}

function checkUnifiedMemory(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'unified-memory', title: 'Unified memory', costText: 'Nothing at stake: how the one pool is shared, and what the GPU may hold of it.', fixWhere: 'none' };
  const gpu = discreteAdapter(s);
  const total = gib(s.ram.totalMiB * MIB);
  if (!gpu || !(gpu.dedicatedMiB > 0)) return finding(base, info(`${total} GB of unified memory, shared by the CPU, the GPU and the Neural Engine.`));
  const working = Math.round(gpu.dedicatedMiB / 1024);
  return finding(base, info(`${total} GB of unified memory; Metal lets the GPU hold up to ${working} GB of it (the working set), the rest stays with the CPU and the system. A model or a scene larger than ${working} GB spills to the CPU side and slows down.`));
}

function checkBootVolume(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'boot-drive-space', title: 'Startup disk free space', costText: 'Severe: macOS swaps to the startup disk, and a nearly full one stutters, cannot update and cannot hold a model download.', fixWhere: 'macos' };
  const boot = s.volumes.find((v) => v.isBoot);
  if (!boot || boot.sizeBytes <= 0) return finding(base, unknown('macOS did not report the startup disk.'));
  const free = boot.freeBytes / boot.sizeBytes;
  const detail = `${boot.label || 'Macintosh HD'} has ${gib(boot.freeBytes)} GB free of ${gib(boot.sizeBytes)} GB (${pct(free)} %).`;
  const fix = 'Free space with System Settings > General > Storage (its recommendations), empty the Trash, and move large folders to an external drive.';
  if (free < 0.1) return finding(base, { state: 'bad', severity: 3, costEstimate: 0.3, detail, fix });
  if (free < 0.15) return finding(base, { state: 'warn', severity: 2, costEstimate: 0.1, detail, fix });
  return finding(base, ok(detail));
}

/** An external spinning disk is not a fault; it says where not to keep what needs speed. */
function checkSpinningDisk(s: StaticSnapshot): AuditFinding | null {
  const base: Base = { id: 'hdd-present', title: 'Spinning disk attached', costText: 'Slow loads and stutter for anything that streams from a spinning disk.', fixWhere: 'hardware' };
  const spinning = s.volumes.flatMap((v) => {
    const disk = s.disks.find((d) => d.deviceId === v.diskDeviceId);
    return disk && disk.mediaType === 'HDD' ? [`${v.label || v.letter} (${disk.friendlyName})`] : [];
  });
  if (spinning.length === 0) return null;
  return finding(base, { state: 'info', severity: 1, costEstimate: 0.05, detail: `${list(spinning)} ${spinning.length === 1 ? 'is a spinning disk' : 'are spinning disks'}: fine for archives, slow for photo libraries, models and games.`, fix: 'Keep what needs speed on the internal SSD.' });
}

function checkGpuThermal(s: StaticSnapshot, run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'thermal-headroom', title: 'GPU thermal headroom', costText: 'Throttling: the chip slows itself down when it runs out of cooling.', fixWhere: 'hardware' };
  const samples = doneSamples(run);
  if (!samples || !run) return finding(base, unknown('Measured with a 20-second heavy Metal load.', 'Run the audit; the load test is part of it.'));
  const steady = steadyWindow(run, samples);
  if (steady.length < 4) return finding(base, unknown('The load run was too short to judge: the steady window needs a few seconds.'));
  const gpu = discreteAdapter(s);
  const top = gpu?.maxClockMhz ?? null;
  const clocks = steady.map((x) => x.smMhz);
  const meanMhz = mean(clocks);
  const meanW = mean(steady.map((x) => x.powerMw)) / 1000;
  const engaged = top ? meanMhz >= GPU_ENGAGED_CLOCK * top : meanW >= GPU_ENGAGED_W;
  if (!engaged) {
    return finding(base, unknown(
      `The load did not engage: the GPU averaged ${Math.round(meanMhz)} MHz${top ? ` of its ${top} MHz top state` : ''} and ${meanW.toFixed(1)} W, so there was no heat to measure.`,
      'Close anything else using the GPU and run the audit again.'
    ));
  }
  const ends = endsOf(clocks);
  const startMhz = Math.round(ends.start);
  const endMhz = Math.round(ends.end);
  const sag = startMhz > 0 ? (startMhz - endMhz) / startMhz : 0;
  const peakC = Math.round(Math.max(...samples.map((x) => x.temperatureC)));
  const held = `${startMhz} to ${endMhz} MHz`;
  const fix = 'Give the Mac air: a hard flat surface, the vents clear, no sleeve or bed. A MacBook Pro that offers High Power (System Settings > Battery > Energy Mode) spins its fans earlier; on battery macOS trims power by design.';
  if (sag >= SAG_WARN && peakC >= GPU_WARM_C) {
    return finding(base, { state: 'warn', severity: 2, costEstimate: Number(sag.toFixed(2)), detail: `GPU clocks fell ${pct(sag)} % under the heavy load (${held}, peak ${peakC} °C): the chip is running out of cooling.`, fix });
  }
  if (sag >= SAG_WARN) {
    return finding(base, info(`Clocks settled from ${held} under the heavy load at a peak of ${peakC} °C: the chip pacing its own power budget, not heat.`));
  }
  return finding(base, ok(`Clocks held under the heavy load (${held}, peak ${peakC} °C, ${meanW.toFixed(1)} W).`));
}

function checkCpuThermalMac(s: StaticSnapshot, run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'cpu-thermal', title: 'CPU thermal headroom', costText: 'Throttling: the chip drops its clocks when it runs out of cooling.', fixWhere: 'hardware' };
  const steady = cpuSteady(run);
  if (!steady) return finding(base, CPU_RUN_MISSING);
  const temps = finite(steady.map((x) => x.tctlC));
  if (temps.length === 0) return finding(base, unknown('The CPU temperature was not readable during the load run (macmon reports it; brew install macmon).'));
  const sustained = Math.round(mean(temps));
  const peak = Math.round(Math.max(...temps));
  const clocks = finite(steady.map((x) => x.avgEffectiveMhz));
  const ends = clocks.length >= 4 ? endsOf(clocks) : null;
  const sag = ends && ends.start > 0 ? (ends.start - ends.end) / ends.start : 0;
  const held = ends ? `${Math.round(ends.start)} to ${Math.round(ends.end)} MHz effective` : '';
  const fix = 'Give the Mac air: a hard flat surface and clear vents. High Power mode, where the Mac offers it, spins the fans earlier; Apple publishes no temperature limit, the chip paces itself.';
  if (sag >= CPU_SAG_WARN && peak >= CPU_WARM_C) {
    return finding(base, { state: 'warn', severity: 2, costEstimate: Number(sag.toFixed(2)), detail: `The CPU reached ${peak} °C under the all-core load and its clocks fell ${pct(sag)} % (${held}): it is running out of cooling.`, fix });
  }
  if (sag >= CPU_SAG_WARN) {
    return finding(base, info(`Clocks settled ${held} under the all-core load (sustained ${sustained} °C, peak ${peak} °C): the chip pacing its own power budget, not heat.`));
  }
  return finding(base, ok(`Held ${sustained} °C under the all-core load (peak ${peak} °C)${held ? `, clocks holding (${held})` : ''}.`));
}

function checkCpuAllCoreMac(s: StaticSnapshot, run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'cpu-allcore-clock', title: 'All-core clock under load', costText: 'What the CPU really runs at when every core is busy.', fixWhere: 'none' };
  const steady = cpuSteady(run);
  if (!steady) return finding(base, CPU_RUN_MISSING);
  const clocks = finite(steady.map((x) => x.avgEffectiveMhz));
  if (clocks.length === 0) return finding(base, unknown('The core clocks were not readable during the load run (macmon reports them; brew install macmon).'));
  const eff = Math.round(mean(clocks));
  const top = s.cpu.maxClockMhz;
  return finding(base, info(`All cores ran at ${ghz(eff)} effective under the load${top > 0 ? ` (the chip's top single-core state is ${ghz(top)})` : ''}; Apple publishes no base clock, the chip sets its own.`));
}

function checkCpuPowerMac(run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'cpu-package-power', title: 'CPU package power', costText: 'Nothing at stake: what the CPU draws flat out; the chip manages its own budget.', fixWhere: 'none' };
  const steady = cpuSteady(run);
  if (!steady) return finding(base, CPU_RUN_MISSING);
  const power = finite(steady.map((x) => x.packageW));
  if (power.length === 0) return finding(base, unknown('The package power was not readable during the load run (macmon reports it; brew install macmon).'));
  const idle = run?.cpuSamples[0]?.packageW;
  const measured = Math.round(mean(power));
  return finding(base, info(`${measured} W under the all-core load${idle !== null && idle !== undefined && Number.isFinite(idle) ? `, from ${idle.toFixed(1)} W at rest` : ''}. Apple publishes no limit and there is no setting to raise; the energy mode and the power source shift what the chip allows itself.`));
}

const MAC_HOGS = { fixWhere: 'macos' as const, startup: 'stop it opening at login (System Settings > General > Login Items & Extensions)' };

export function runMacAudit(inputs: AuditInputs): AuditFinding[] {
  const s = inputs.snapshot;
  const findings = [
    macCoverage(s),
    checkEnergyMode(s),
    checkUnifiedMemory(s),
    checkBootVolume(s),
    checkSpinningDisk(s),
    checkGpuThermal(s, inputs.thermalRamp),
    checkHogs(inputs.hogs, s, MAC_HOGS),
    checkCpuThermalMac(s, inputs.cpuLoad),
    checkCpuAllCoreMac(s, inputs.cpuLoad),
    checkCpuPowerMac(inputs.cpuLoad),
    checkCpuIdleClock(inputs.cpuLoad, inputs.cpuSensors),
    checkAiModel(s, 'unified memory')
  ];
  return rankFindings(findings.filter((f): f is AuditFinding => f !== null));
}
