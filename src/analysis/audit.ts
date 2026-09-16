/**
 * The system audit (master plan §8): pure rules over the collector's static
 * snapshot, its idle process sample and two optional GPU load runs. Nothing
 * here touches hardware. The Audit page shows rankTop(runAudit(inputs), 5) and
 * keeps the rest under "show all".
 *
 * A check whose inputs are missing answers 'unknown', never 'warn' or 'bad'
 * (plan risk R5: an unrecognised memory kit or a load run that has not
 * happened is not a fault). Every sentence is written for someone who has
 * never opened a BIOS.
 */
import type { HogsResult, LoadRun, StaticSnapshot } from '../collector-types';
import { cleanPartNumber, ratedSpeedFor } from './kits';
import { hasAny, hasBit, SW_POWER_CAP, THERMAL_OR_BRAKE } from './nvmlBits';

export type AuditState = 'ok' | 'warn' | 'bad' | 'info' | 'unknown';
export type FixWhere = 'bios' | 'windows' | 'game' | 'hardware' | 'none' | 'app';

export interface AuditFinding {
  id: string;
  title: string;
  state: AuditState;
  /** 0 nothing to do, 3 fix this first. */
  severity: 0 | 1 | 2 | 3;
  /** Fraction of game performance at stake, 0..1; ranked together with severity. */
  costEstimate: number;
  costText: string;
  detail: string;
  fix: string;
  fixWhere: FixWhere;
}

export interface AuditInputs {
  snapshot: StaticSnapshot;
  hogs: HogsResult | null;
  pcieUnderLoad: LoadRun | null;
  thermalRamp: LoadRun | null;
  nowIso: string;
}

type Base = Pick<AuditFinding, 'id' | 'title' | 'costText' | 'fixWhere'>;
type Verdict = Pick<AuditFinding, 'state' | 'severity' | 'costEstimate' | 'detail' | 'fix'> & Partial<Pick<AuditFinding, 'costText' | 'fixWhere'>>;

function finding(base: Base, v: Verdict): AuditFinding {
  return {
    id: base.id, title: base.title, state: v.state, severity: v.severity, costEstimate: v.costEstimate,
    costText: v.costText ?? base.costText, detail: v.detail, fix: v.fix, fixWhere: v.fixWhere ?? base.fixWhere
  };
}

const ok = (detail: string): Verdict => ({ state: 'ok', severity: 0, costEstimate: 0, detail, fix: 'Nothing to change.' });
const info = (detail: string, fix = 'Nothing to change.'): Verdict => ({ state: 'info', severity: 0, costEstimate: 0, detail, fix });
const unknown = (detail: string, fix = 'Nothing to change; there is not enough information to judge this yet.'): Verdict =>
  ({ state: 'unknown', severity: 0, costEstimate: 0, detail, fix });

const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const ULTIMATE_PERFORMANCE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const POWER_SAVER = 'a1841308-3541-4fab-bc81-f71556f20b4a';
/** Windows 10/11 power-mode overlays: the Settings slider, which PowerGetActiveScheme never reports. */
const OVERLAY_BEST_PERFORMANCE = 'ded574b5-45a0-4f42-8737-46345c09c238';
const OVERLAY_BETTER_PERFORMANCE = '3af9b8d9-7c97-431d-ad78-34a8bfea439f';
const OVERLAY_BEST_EFFICIENCY = '961cc777-2547-4f9d-8174-7d86181b8a7a';

/**
 * Thermal headroom (plan §8): the worker's start-up and the boost governor's first
 * seconds are not the measurement, so the verdict comes from the steady window;
 * the load must have engaged (power at half the limit or more) for any of it to
 * mean anything; and clocks that sag while the card is warm, without a driver
 * flag, are worth a warning, not hardware advice.
 */
const STEADY_FROM_S = 3;
const ENGAGED_FRACTION = 0.5;
const SAG_WARN = 0.08;
const WARM_C = 75;

/** Per-lane transfer rate by PCIe generation, GT/s, to size a downgraded link. */
const PCIE_GT_PER_LANE = [0, 2.5, 5, 8, 16, 32, 64];
const laneRate = (gen: number) => PCIE_GT_PER_LANE[Math.min(gen, PCIE_GT_PER_LANE.length - 1)];

const GIB = 1024 ** 3;
const gib = (bytes: number) => Math.round(bytes / GIB);
const pct = (fraction: number) => Math.round(fraction * 100);
const watts = (mw: number) => Math.round(mw / 1000);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const doneSamples = (run: LoadRun | null) => run && run.state === 'done' && run.gpuSamples.length > 0 ? run.gpuSamples : null;
/** Windows keeps WSL 2 and Hyper-V guest memory in these; they are not background programs to close. */
const isVmHost = (name: string) => /^vmmem(WSL)?(\.exe)?$/i.test(name);

function checkExpo(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'expo', title: 'Memory speed (EXPO/XMP)', costText: '10–15 % in CPU-bound games.', fixWhere: 'bios' };
  const modules = s.ram.modules;
  if (modules.length === 0) return finding(base, unknown('Windows reported no memory modules.'));
  const rated: number[] = [];
  let vendor = '';
  let jedec = false;
  for (const m of modules) {
    const kit = ratedSpeedFor(m.partNumber);
    if (!kit) {
      const part = cleanPartNumber(m.partNumber) || 'an unlabelled module';
      return finding(base, unknown(`Could not determine the rated speed for ${part}; this kit is not in the table yet.`));
    }
    rated.push(kit.ratedMts);
    vendor = kit.vendor;
    jedec ||= kit.profile === 'jedec';
  }
  const ratedMts = Math.min(...rated);
  const configured = Math.min(...modules.map(m => m.configuredMts));
  if (configured <= 0) return finding(base, unknown('Windows did not report the speed the memory is running at.'));
  if (configured >= ratedMts) return finding(base, ok(`Running at ${configured} MT/s, rated ${ratedMts} MT/s (${vendor}).`));
  if (jedec) {
    // A JEDEC module has no profile to switch on: the CPU's memory controller sets the speed.
    return finding(base, info(`The platform runs this ${vendor} module at ${configured} MT/s, below its JEDEC rating of ${ratedMts} MT/s; there is no EXPO/XMP profile to enable.`, 'Nothing to change: this is the speed the CPU supports for this module.'));
  }
  if (configured >= ratedMts * 0.95) {
    return finding(base, info(`Running at ${configured} MT/s, just under the rated ${ratedMts} MT/s; not worth changing.`));
  }
  return finding(base, {
    state: 'bad', severity: 3, costEstimate: 0.15,
    detail: `Running at ${configured} MT/s but rated for ${ratedMts} MT/s: the EXPO/XMP profile is off, so the memory runs at its slow default.`,
    fix: 'Restart and press Delete at power-on to enter the BIOS, find EXPO or XMP on the overclocking or memory page, choose profile 1, then save and exit.'
  });
}

export interface SlotName {
  channel: string | null;
  slot: number | null;
}

/**
 * DeviceLocator is free text per board vendor: "DIMMA2" (MSI), "DIMM_A2"
 * (ASUS), "DDR5_A2" (Gigabyte, ASRock), "ChannelA-DIMM0" (some OEMs),
 * "DIMM 2" (channel unnamed). Strip the filler and read whatever channel
 * letter and slot number remain.
 */
export function parseSlot(locator: string): SlotName {
  const core = locator.toUpperCase().replace(/DIMM|DDR[45]|CHANNEL|SLOT|[\s_\-#]/g, '');
  const m = /^([A-H])?(\d+)$/.exec(core);
  if (!m) return { channel: null, slot: null };
  return { channel: m[1] ?? null, slot: Number(m[2]) };
}

function checkChannels(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'ram-channels', title: 'Memory channels', costText: 'Up to 20 %: one stick, or two on the same channel, halves memory bandwidth.', fixWhere: 'hardware' };
  const modules = s.ram.modules;
  const slots = list(modules.map(m => m.slot));
  const laptop = s.chassis.isLaptop;
  if (modules.length === 0) return finding(base, unknown('Windows reported no memory modules.'));
  if (modules.length === 1) {
    return finding(base, {
      state: 'bad', severity: 3, costEstimate: 0.2,
      detail: `One memory module (${slots}): the CPU can use only one of its two memory channels.`,
      fix: laptop
        ? 'If the laptop has a free SO-DIMM slot, add a second module of the same kind; soldered memory cannot be changed.'
        : 'Add a second module of the same kind in the matching slot of the other channel (A2 and B2 on most boards; the board manual shows the pair).'
    });
  }
  if (modules.length === 3) {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: 0.1,
      detail: `Three modules (${slots}): the channels are uneven, so part of the memory runs single-channel.`,
      fix: 'Use two or four matched modules.'
    });
  }
  if (modules.length >= 4) return finding(base, ok(`${modules.length} modules (${slots}): both channels populated.`));
  const [a, b] = modules.map(m => parseSlot(m.slot));
  if (!a.channel || !b.channel) {
    return finding(base, unknown(
      `The slot names (${slots}) do not say which channel each module is in.`,
      laptop ? 'Laptops normally wire their two slots to separate channels; nothing to do unless the manual says otherwise.' : 'Check the board manual: two modules belong in A2 and B2.'
    ));
  }
  if (a.channel === b.channel) {
    return finding(base, {
      state: 'bad', severity: 3, costEstimate: 0.2,
      detail: `Both modules sit in channel ${a.channel} (${slots}), so the second channel is empty.`,
      fix: 'Move one module to the same-numbered slot of the other channel (A2 and B2 on most boards).'
    });
  }
  const pairNote = a.slot === 2 && b.slot === 2 ? '' : ' On a four-slot board the manual\'s pair is A2 and B2; a two-slot board has only these.';
  return finding(base, ok(`Two modules in ${slots}: one per channel.${pairNote}`));
}

function checkPcie(s: StaticSnapshot, run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'pcie-link', title: 'GPU PCIe link', costText: '2–8 %.', fixWhere: 'hardware' };
  const gpu = s.gpus[0];
  if (!gpu) return finding(base, unknown('No NVIDIA GPU was found.'));
  const samples = doneSamples(run);
  if (!samples) return finding(base, unknown('Measured under a short GPU load, because the link slows down while the card idles.', 'Run the audit; the load test is part of it.'));
  const gen = Math.max(...samples.map(x => x.pcieGen));
  const width = Math.max(...samples.map(x => x.pcieWidth));
  const { maxGen, maxWidth } = gpu.pcie;
  if (gen <= 0 || width <= 0 || maxGen <= 0 || maxWidth <= 0) return finding(base, unknown('The driver did not report the link speed.'));
  if (gen >= maxGen && width >= maxWidth) return finding(base, ok(`PCIe ${gen}.0 x${width} under load, the most this card and slot can do.`));
  const share = (width / maxWidth) * (laneRate(gen) / laneRate(maxGen));
  const detail = `PCIe ${gen}.0 x${width} under load, but the card and slot can do PCIe ${maxGen}.0 x${maxWidth}: the link has about ${pct(share)} % of its bandwidth.`;
  const grade = share < 0.5 ? { state: 'bad', severity: 3, costEstimate: 0.08 } as const : { state: 'warn', severity: 2, costEstimate: 0.05 } as const;
  if (width < maxWidth) {
    return finding(base, {
      ...grade, detail,
      fix: s.chassis.isLaptop
        ? 'A laptop\'s graphics slot is fixed; a narrow link there is by design or a driver fault, so update the graphics driver and the BIOS.'
        : 'Power off, reseat the graphics card (and any riser cable) firmly, and check the manual: an M.2 drive in some slots takes lanes away from the graphics slot.'
    });
  }
  return finding(base, {
    ...grade, detail, fixWhere: 'bios',
    fix: `In the BIOS find the graphics slot's link speed (often under Advanced, PCIe or PCI Subsystem Settings) and set it to Auto or Gen ${maxGen}.`
  });
}

function checkRebar(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'rebar', title: 'Resizable BAR', costText: '0–10 %, depending on the game.', fixWhere: 'bios' };
  const gpu = s.gpus[0];
  if (!gpu) return finding(base, unknown('No NVIDIA GPU was found.'));
  const bar = gpu.bar1TotalMiB;
  const vram = gpu.vram.totalMiB;
  if (!(bar > 0) || !(vram > 0)) return finding(base, unknown('The driver did not report the BAR size.'));
  const vramGb = Math.round(vram / 1024);
  if (bar >= vram * 0.9) return finding(base, ok(`On: the CPU can address all ${vramGb} GB of video memory at once (BAR ${bar} MiB).`));
  const fix = s.chassis.isLaptop
    ? 'Laptops rarely expose this setting: update the BIOS and the graphics driver from the laptop maker, which is where it is enabled when it can be.'
    : 'In the BIOS turn on Above 4G Decoding and Re-Size BAR Support (usually under Advanced, PCI Subsystem Settings), then save and exit. Windows must be installed in UEFI mode for it to take.';
  if (bar <= 512) {
    return finding(base, { state: 'bad', severity: 2, costEstimate: 0.1, detail: `Off: the CPU reaches video memory through a ${bar} MiB window instead of all ${vramGb} GB.`, fix });
  }
  return finding(base, { state: 'warn', severity: 1, costEstimate: 0.05, detail: `Partly on: ${bar} MiB of ${vram} MiB is addressable.`, fix: `${fix} A BIOS update can help when the setting is already on.` });
}

function checkPowerPlan(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'power-plan', title: 'Windows power plan', costText: 'Large on laptops; small on desktops.', fixWhere: 'windows' };
  const guid = s.powerPlan.guid.trim().toLowerCase();
  const overlay = s.powerPlan.overlayGuid?.trim().toLowerCase() || null;
  if (!guid && !overlay) return finding(base, unknown('Windows did not report the active power plan.'));
  const name = s.powerPlan.name.trim() || 'The current plan';
  const performance = guid === HIGH_PERFORMANCE || guid === ULTIMATE_PERFORMANCE;
  if (s.chassis.isLaptop) {
    const fix = 'Plug in, open Settings > System > Power & battery and set Power mode to Best performance; or in Control Panel > Power Options choose High performance.';
    // Windows 11 laptops expose only Balanced; the performance choice is the power-mode
    // slider, an overlay on top of the scheme, so that is what gets judged when it is set.
    if (overlay === OVERLAY_BEST_PERFORMANCE || overlay === OVERLAY_BETTER_PERFORMANCE) {
      return finding(base, ok(`Power mode ${overlay === OVERLAY_BEST_PERFORMANCE ? 'Best performance' : 'Better performance'}: the CPU and GPU are allowed full speed.`));
    }
    if (overlay === OVERLAY_BEST_EFFICIENCY) {
      return finding(base, { state: 'bad', severity: 3, costEstimate: 0.25, detail: 'Power mode Best power efficiency holds the CPU at low clocks even when plugged in.', fix });
    }
    if (performance) return finding(base, ok(`${name}: the CPU and GPU are allowed full speed.`));
    if (guid === POWER_SAVER) {
      return finding(base, { state: 'bad', severity: 3, costEstimate: 0.25, detail: 'Power saver on a laptop holds the CPU at low clocks even when plugged in.', fix });
    }
    return finding(base, { state: 'warn', severity: 2, costEstimate: 0.2, detail: `${name} on a laptop can hold back the CPU and GPU while gaming.`, fix });
  }
  if (performance) return finding(base, ok(`${name}.`));
  if (guid === BALANCED) {
    return /ryzen/i.test(s.cpu.name)
      ? finding(base, ok('Balanced: AMD recommends the Balanced plan for Ryzen, because it lets idle cores sleep and boosts faster than High performance.'))
      : finding(base, ok('Balanced: fine on a desktop, Windows 11 boosts the CPU fully under load.'));
  }
  if (guid === POWER_SAVER) {
    return finding(base, { state: 'info', severity: 1, costEstimate: 0.05, detail: 'Power saver caps the CPU clock on a desktop.', fix: 'Open Control Panel > Power Options and choose Balanced.' });
  }
  return finding(base, info(`${name} is a custom plan; Strata Tune does not judge it.`, 'Nothing to change unless games feel slow; Balanced is a safe choice.'));
}

function checkBootDrive(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'boot-drive-space', title: 'Boot drive free space', costText: 'Severe: Windows and the page file need room, and a nearly full boot drive stutters and can fail to update.', fixWhere: 'windows' };
  const boot = s.volumes.find(v => v.isBoot);
  if (!boot || boot.sizeBytes <= 0) return finding(base, unknown('Windows did not report the boot drive.'));
  const free = boot.freeBytes / boot.sizeBytes;
  const detail = `${boot.letter}: has ${gib(boot.freeBytes)} GB free of ${gib(boot.sizeBytes)} GB (${pct(free)} %).`;
  const fix = `Free space on ${boot.letter}: with Settings > System > Storage > Cleanup recommendations, uninstall games you are not playing, and move large folders to another drive.`;
  if (free < 0.10) return finding(base, { state: 'bad', severity: 3, costEstimate: 0.3, detail, fix });
  if (free < 0.15) return finding(base, { state: 'warn', severity: 2, costEstimate: 0.1, detail, fix });
  return finding(base, ok(detail));
}

const HDD_COST = 'Traversal stutter and long loads when a game lives on a spinning disk.';

function checkGameOnHdd(): AuditFinding {
  const base: Base = { id: 'game-on-hdd', title: 'Game on a hard drive', costText: HDD_COST, fixWhere: 'game' };
  return finding(base, unknown('Checked when a game is captured.', 'Capture a game from the Capture page; the audit then checks which drive it runs from.'));
}

/** Not a fault by itself; it tells the user which drive letters to keep games off. */
function checkHddPresent(s: StaticSnapshot): AuditFinding | null {
  const base: Base = { id: 'hdd-present', title: 'Hard drive in the system', costText: HDD_COST, fixWhere: 'game' };
  const onHdd = s.volumes.flatMap(v => {
    const disk = s.disks.find(d => d.deviceId === v.diskDeviceId);
    return disk && disk.mediaType === 'HDD' && disk.busType !== 'USB' ? [`${v.letter}: (${disk.friendlyName})`] : [];
  });
  if (onHdd.length === 0) return null;
  return finding(base, {
    state: 'info', severity: 1, costEstimate: 0.05,
    detail: `${list(onHdd)} ${onHdd.length === 1 ? 'is a spinning hard drive' : 'are spinning hard drives'}. Games installed there load slowly and can stutter while streaming.`,
    fix: 'Keep games on an SSD; use the hard drive for files that do not need speed.'
  });
}

function checkThermal(s: StaticSnapshot, run: LoadRun | null): AuditFinding {
  const base: Base = { id: 'thermal-headroom', title: 'GPU thermal headroom', costText: 'Throttling: the card slows itself down when it runs hot.', fixWhere: 'hardware' };
  const gpu = s.gpus[0];
  if (!gpu) return finding(base, unknown('No NVIDIA GPU was found.'));
  const samples = doneSamples(run);
  if (!samples || !run || run.qpcEnd === null || run.qpcEnd <= run.qpcStart) {
    return finding(base, unknown('Measured with a 20-second heavy GPU load.', 'Run the audit; the load test is part of it.'));
  }
  // Seconds into the run without needing the QPC frequency: the run's own span is its length.
  const span = run.qpcEnd - run.qpcStart;
  const at = (qpc: number) => (qpc - run.qpcStart) / span * run.seconds;
  const steady = samples.filter(x => at(x.qpc) >= STEADY_FROM_S);
  if (steady.length < 4) return finding(base, unknown('The load run was too short to judge: the steady window needs a few seconds.'));
  const load = run.kind === 'heavy' ? 'heavy load' : 'light load';
  if (!(gpu.powerLimitMw > 0)) return finding(base, unknown('The driver did not report a power limit, so whether the load engaged cannot be judged.'));
  const meanPowerMw = mean(steady.map(x => x.powerMw));
  if (meanPowerMw < ENGAGED_FRACTION * gpu.powerLimitMw) {
    return finding(base, unknown(
      `The load did not engage: the card averaged ${watts(meanPowerMw)} W of its ${watts(gpu.powerLimitMw)} W limit over the ${load}, so there was no heat to measure.`,
      'Close anything else using the GPU and run the audit again.'
    ));
  }
  const third = Math.max(1, Math.floor(steady.length / 3));
  const startMhz = Math.round(mean(steady.slice(0, third).map(x => x.smMhz)));
  const endMhz = Math.round(mean(steady.slice(-third).map(x => x.smMhz)));
  const sag = startMhz > 0 ? (startMhz - endMhz) / startMhz : 0;
  const peakC = Math.max(...samples.map(x => x.temperatureC));
  const throttled = steady.some(x => hasAny(x.clocksEventReasons, THERMAL_OR_BRAKE));
  const powerCapped = steady.some(x => hasBit(x.clocksEventReasons, SW_POWER_CAP));
  const clocks = `${startMhz} to ${endMhz} MHz`;
  const fix = 'Improve airflow: clear dust from the card and the case filters, check that every fan spins, and raise the GPU fan curve. On a card a few years old, fresh thermal paste and pads help.';
  if (throttled) {
    return finding(base, {
      state: 'bad', severity: 3, costEstimate: Math.max(0.15, Number(Math.max(sag, 0).toFixed(2))),
      detail: `The GPU reported thermal throttling under the ${load} (peak ${peakC} °C); clocks fell ${pct(Math.max(sag, 0))} % from ${clocks}.`,
      fix
    });
  }
  if (sag >= SAG_WARN && peakC >= WARM_C) {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: Number(sag.toFixed(2)),
      detail: `GPU clocks fell ${pct(sag)} % under the ${load} (${clocks}, peak ${peakC} °C) without a throttle flag; the card is running out of thermal headroom.`,
      fix
    });
  }
  if (sag >= SAG_WARN) {
    return finding(base, info(`Clocks settled from ${clocks} under the ${load} at a peak of ${peakC} °C, with no throttle flag${powerCapped ? ' beyond the power limit' : ''}; nothing points to heat.`));
  }
  if (powerCapped) {
    return finding(base, ok(`Power-limited at ${watts(meanPowerMw)} W, normal: clocks held (${clocks}) at a peak of ${peakC} °C with the card at its ${watts(gpu.powerLimitMw)} W limit.`));
  }
  return finding(base, ok(`Clocks held under the ${load} (${clocks}, peak ${peakC} °C, ${watts(meanPowerMw)} W).`));
}

function checkDriverAge(s: StaticSnapshot, nowIso: string): AuditFinding {
  const base: Base = { id: 'gpu-driver-age', title: 'GPU driver age', costText: 'Occasional title bugs: new games expect a recent driver.', fixWhere: 'windows' };
  if (!s.gpuDriver.date) return finding(base, unknown('The driver install date was not reported.'));
  const days = Math.floor((Date.parse(nowIso) - Date.parse(s.gpuDriver.date)) / 86_400_000);
  if (!Number.isFinite(days)) return finding(base, unknown('The driver date could not be read.'));
  const version = s.gpuDriver.version || 'The GPU driver';
  if (days > 180) {
    // The snapshot's gpus[] comes from NVML, so a card there is NVIDIA's; otherwise the first display driver was taken.
    const fix = s.gpus.length > 0
      ? 'Update from the NVIDIA app or nvidia.com/drivers; pick the Game Ready driver.'
      : 'Update from the GPU maker\'s app (AMD Software or Intel Graphics Software) or its website.';
    return finding(base, { state: 'info', severity: 1, costEstimate: 0.02, detail: `Driver ${version} is ${days} days old.`, fix });
  }
  return finding(base, ok(`Driver ${version}, ${days} days old.`));
}

function checkHogs(hogs: HogsResult | null): AuditFinding {
  const base: Base = { id: 'background-hogs', title: 'Background programs', costText: 'Whatever they take: a busy background program steals CPU time and memory from the game.', fixWhere: 'windows' };
  if (!hogs) return finding(base, unknown('Measured with a 5-second sample while the machine idles.', 'Run the audit with the machine idle.'));
  const heavy = hogs.processes.filter(p => p.cpuPercent > 5 || (p.workingSetMiB > 2048 && !isVmHost(p.name)));
  const vms = hogs.processes.filter(p => isVmHost(p.name) && p.workingSetMiB > 2048);
  const vmNote = vms.length ? ` ${vms[0].name} holds ${(vms[0].workingSetMiB / 1024).toFixed(1)} GB for WSL or a virtual machine; wsl --shutdown (or stopping the VM) returns it.` : '';
  if (heavy.length === 0) {
    if (vms.length) return finding(base, { state: 'info', severity: 1, costEstimate: 0.05, detail: `Nothing busy in the background over ${hogs.seconds} s.${vmNote}`, fix: 'Shut the VM down before gaming if the game needs the memory.' });
    return finding(base, ok(`Nothing heavy in the background over ${hogs.seconds} s.`));
  }
  const named = heavy.slice(0, 3).map(p => `${p.name} (${Math.round(p.cpuPercent)} % CPU, ${(p.workingSetMiB / 1024).toFixed(1)} GB)`);
  const more = heavy.length > 3 ? ` and ${heavy.length - 3} more` : '';
  return finding(base, {
    state: 'warn', severity: 2, costEstimate: 0.1,
    detail: `Busy while idle: ${list(named)}${more}.${vmNote}`,
    fix: 'Close what you do not need before gaming, or stop it from starting with Windows (Settings > Apps > Startup).'
  });
}

function checkPowerLimit(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'power-limit-headroom', title: 'GPU power limit', costText: 'A few percent at most; heat and noise go up with it.', fixWhere: 'app' };
  const gpu = s.gpus[0];
  if (!gpu) return finding(base, unknown('No NVIDIA GPU was found.'));
  if (!(gpu.powerLimitMw > 0) || !(gpu.powerMaxLimitMw > 0)) return finding(base, unknown('The driver did not report the power limits.'));
  if (gpu.powerLimitMw >= gpu.powerMaxLimitMw) {
    return finding(base, {
      state: 'info', severity: 0, costEstimate: 0, costText: 'No headroom to raise; an undervolt is the lever.',
      detail: `The power limit is already at the card's maximum (${watts(gpu.powerLimitMw)} W).`,
      fix: 'Nothing to raise. Tune will look for an undervolt that keeps the clocks at less power and heat.'
    });
  }
  const headroom = watts(gpu.powerMaxLimitMw - gpu.powerLimitMw);
  return finding(base, {
    state: 'info', severity: 0, costEstimate: 0, costText: `${headroom} W of headroom.`,
    detail: `The power limit is ${watts(gpu.powerLimitMw)} W; the card allows up to ${watts(gpu.powerMaxLimitMw)} W.`,
    fix: 'Raising it trades heat and noise for a few percent; Tune tests that safely.'
  });
}

/** Family-aware: this box keeps an Ollama model resident for Strata Photo and Code. */
function checkAiModel(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'ai-model-resident', title: 'AI model in video memory', costText: 'Games get less video memory while a model is loaded.', fixWhere: 'app' };
  if (s.ollama === null) return finding(base, ok('Ollama is not running.'));
  if (s.ollama.length === 0) return finding(base, ok('Ollama is running but holds no model.'));
  const held = s.ollama.map(m => `${m.name} holds ${Number((m.sizeVramBytes / 1e9).toFixed(1))} GB of VRAM`);
  return finding(base, {
    state: 'info', severity: 1, costEstimate: 0.1,
    detail: `${list(held)}; fine for AI work, costs games headroom.`,
    fix: `ollama stop ${s.ollama[0].name} to unload it; Ollama loads it again on the next request.`
  });
}

const score = (f: AuditFinding) => Math.round(f.severity * f.costEstimate * 1e6);
const biosFirst = (f: AuditFinding) => (f.fixWhere === 'bios' ? 0 : 1);

/** Plan §8: severity × cost, highest first; equal scores put the ten-minute BIOS fixes first. Stable, so equal findings keep check order. */
export function rankFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => score(b) - score(a) || biosFirst(a) - biosFirst(b));
}

export function rankTop(findings: AuditFinding[], n: number): AuditFinding[] {
  return rankFindings(findings).slice(0, n);
}

export function runAudit(inputs: AuditInputs): AuditFinding[] {
  const s = inputs.snapshot;
  const findings = [
    checkExpo(s),
    checkChannels(s),
    checkPcie(s, inputs.pcieUnderLoad),
    checkRebar(s),
    checkPowerPlan(s),
    checkBootDrive(s),
    checkGameOnHdd(),
    checkHddPresent(s),
    checkThermal(s, inputs.thermalRamp),
    checkDriverAge(s, inputs.nowIso),
    checkHogs(inputs.hogs),
    checkPowerLimit(s),
    checkAiModel(s)
  ];
  return rankFindings(findings.filter((f): f is AuditFinding => f !== null));
}
