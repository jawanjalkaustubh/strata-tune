/**
 * The system audit (master plan §8): pure rules over the collector's static
 * snapshot, its idle process sample, two optional GPU load runs and one
 * all-core CPU run (phase1-polish item 6). Nothing
 * here touches hardware. The Audit page shows rankTop(runAudit(inputs), 5) and
 * keeps the rest under "show all".
 *
 * A check whose inputs are missing answers 'unknown', never 'warn' or 'bad'
 * (plan risk R5: an unrecognised memory kit or a load run that has not
 * happened is not a fault). Every sentence is written for someone who has
 * never opened a BIOS.
 */
import type { HogsResult, LoadRun, StaticSnapshot, TimerRequester, Timers } from '../collector-types';
import type { Settings } from '../settings';
import { coText, curveOptimizerSet } from '../components/monitor/cpuTuning';
import { boardPartnerOf } from '../components/monitor/vendors';
import { nvmlMemOffsetMhz } from '../components/advisor/thisCard';
import { cpuSpec } from './cpuSpec';
import { fillRateEstimate } from './gpuUnits';
import { lookupGpu } from './hardware-tables';
import { cleanPartNumber, ratedSpeedFor } from './kits';
import { hasAny, hasBit, SW_POWER_CAP, THERMAL_OR_BRAKE } from './nvmlBits';
import { discreteAdapter, gpuSummary, integratedAdapter } from './adapters';

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

export type CurveOptimizer = Pick<Settings, 'coAllCore' | 'coPerCore'>;

export interface AuditInputs {
  snapshot: StaticSnapshot;
  hogs: HogsResult | null;
  pcieUnderLoad: LoadRun | null;
  thermalRamp: LoadRun | null;
  /** The 20 s all-core CPU run (kind 'cpu'); every CPU rule but SMT answers 'unknown' without it. */
  cpuLoad: LoadRun | null;
  /** Settings.cpuPptW: the socket power limit the user configured; null falls back to the stock value in cpus.json. */
  cpuPptW: number | null;
  /**
   * Settings.coAllCore / coPerCore: the Curve Optimizer the user set in the BIOS. No software
   * reads it on Zen 5 (no SMU access), so the CPU thermal advice takes it from here and never
   * recommends the undervolt the user already runs (polish 3 item 2).
   */
  curveOptimizer: CurveOptimizer;
  /** The optional 6 s fill-rate cross-check (kind 'fillrate'), the gpu-units rule's fallback when the direct NVAPI read is unavailable. */
  fillRate?: LoadRun | null;
  nowIso: string;
  /** GET /timers, traced when the timer is held raised (plan section 8's timer-resolution row); absent or null answers 'unknown'. */
  timers?: Timers | null;
  /**
   * Whether the sensor tree has a CPU node (the library reads the CPU through PawnIO). False
   * makes the four CPU rules say so in one sentence instead of "the sensor was not readable
   * during the load run" four times (the first laptop, 2026-09-19); absent means not checked.
   */
  cpuSensors?: boolean;
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

/** Package power this far over the stock limit means PBO or a raised PPT; the sensors cannot read the limit itself (dependencies.md). */
const PBO_OVER_STOCK = 1.05;
const AT_LIMIT_FRACTION = 0.95;
/**
 * Sustained this close to Tjmax under the all-core load is worth a card. Pinned at Tjmax with
 * the clocks holding is how Zen 4/5 boosts (info, by design; polish 3 item 1); the cooler is
 * only at fault when the clocks sag while pinned, or when Tctl is already this close to Tjmax
 * before the load starts (the run's first sample), which is what a game would see too.
 */
const CPU_WARM_BELOW_TJMAX_C = 5;
const CPU_PINNED_BELOW_TJMAX_C = 1;
const CPU_SAG_WARN = 0.05;
const CPU_REST_WARN_BELOW_TJMAX_C = 2;
const BELOW_BASE = 0.9;

const GIB = 1024 ** 3;
const gib = (bytes: number) => Math.round(bytes / GIB);
const pct = (fraction: number) => Math.round(fraction * 100);
const watts = (mw: number) => Math.round(mw / 1000);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const doneSamples = (run: LoadRun | null) => run && run.state === 'done' && run.gpuSamples.length > 0 ? run.gpuSamples : null;
const ghz = (mhz: number) => `${(mhz / 1000).toFixed(1)} GHz`;
const signed = (mhz: number) => (mhz >= 0 ? `+${mhz}` : `${mhz}`);
const finite = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null && Number.isFinite(x));
/** Mean of the first and last third of a series, for "did it sag" questions. */
const endsOf = (xs: number[]) => {
  const third = Math.max(1, Math.floor(xs.length / 3));
  return { start: mean(xs.slice(0, third)), end: mean(xs.slice(-third)) };
};

/**
 * Seconds into a finished run without needing the QPC frequency: the run's own span is its
 * length. The steady window (t >= 3 s) leaves the worker's start-up and the boost governor's
 * first seconds out of the verdict.
 */
function steadyWindow<T extends { qpc: number }>(run: LoadRun, samples: T[]): T[] {
  if (run.qpcEnd === null || run.qpcEnd <= run.qpcStart) return [];
  const span = run.qpcEnd - run.qpcStart;
  return samples.filter(x => (x.qpc - run.qpcStart) / span * run.seconds >= STEADY_FROM_S);
}

type CpuSample = LoadRun['cpuSamples'][number];

/** The finished CPU run's steady window, or null when there is no run to judge from. */
function cpuSteady(run: LoadRun | null): CpuSample[] | null {
  if (!run || run.kind !== 'cpu' || run.state !== 'done' || run.cpuSamples.length === 0) return null;
  const steady = steadyWindow(run, run.cpuSamples);
  return steady.length >= 4 ? steady : null;
}

const CPU_RUN_MISSING = unknown('Measured with a 20-second all-core CPU load.', 'Run the audit; the CPU load test is part of it.');
/** No CPU node in the tree: the library reads the CPU through PawnIO, so the driver is what is missing, and the fix is the same for every CPU rule. */
const CPU_SENSORS_MISSING = unknown('The CPU sensors need the PawnIO driver, which is not installed on this PC.', 'Install PawnIO from pawnio.eu (About shows its status), restart Strata Tune and run the audit again.');
/** The CPU rules' shared gate: the run, then the sensors it needs. */
const cpuRunOrWhy = (run: LoadRun | null, cpuSensors: boolean | undefined) => (cpuSensors === false ? CPU_SENSORS_MISSING : cpuSteady(run) ? null : CPU_RUN_MISSING);
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
      // Laptop memory (soldered or SO-DIMM) is a JEDEC part the platform sets the speed of;
      // an unknown module there is not a profile to enable, so it is a plain sentence, not a
      // question (the first laptop's Samsung DDR5-4800 read "not in the table yet").
      if (s.chassis.isLaptop) {
        const configured = Math.min(...modules.map(x => x.configuredMts).filter(x => x > 0));
        return finding(base, info(
          `Laptop memory runs at the speed the platform sets${Number.isFinite(configured) ? ` (${configured} MT/s here)` : ''}; there is no EXPO/XMP profile to enable. ${part} is not in the module table, so its rating is not checked.`,
          'Nothing to change.'
        ));
      }
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

/**
 * The six GPU rules read NVML and NVAPI, so on a machine without an NVIDIA card they have no
 * inputs at all. Plan 17d: they are omitted, never six "unknown" cards reading "No NVIDIA GPU
 * was found" (the first laptop, an RX 6700S, 2026-09-19), and this one card says what the
 * machine has and what is not checked on it, in one sentence each.
 */
function checkGpuCoverage(s: StaticSnapshot): AuditFinding | null {
  if (s.gpus.length > 0) return null;
  const base: Base = { id: 'gpu-coverage', title: 'GPU checks', costText: 'Nothing at stake: what this version can and cannot check on this card.', fixWhere: 'none' };
  const card = discreteAdapter(s);
  const igpu = integratedAdapter(s);
  const has = card ? `This PC's card is ${gpuSummary(s)}${igpu ? `, with ${igpu.name} beside it for the desktop` : ''}.` : igpu ? `This PC has no discrete graphics card: ${igpu.name} is the processor's own.` : 'Windows lists no graphics adapter.';
  const what = card
    ? `The PCIe link, Resizable BAR, thermal headroom, power limit, overclock and unit-count checks read NVIDIA's driver and are not run on ${card.vendor === 'amd' ? 'an AMD' : card.vendor === 'intel' ? 'an Intel' : 'this'} card in this version; the Monitor page shows what its driver reports.`
    : 'The GPU checks (PCIe link, Resizable BAR, thermal headroom, power limit, overclock, unit counts) need a discrete card and are not run.';
  return finding(base, info(`${has} ${what}`, card ? 'Nothing to change; AMD and Intel checks are planned.' : 'Nothing to change.'));
}

function checkPcie(s: StaticSnapshot, run: LoadRun | null): AuditFinding | null {
  const base: Base = { id: 'pcie-link', title: 'GPU PCIe link', costText: '2–8 %.', fixWhere: 'hardware' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
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

function checkRebar(s: StaticSnapshot): AuditFinding | null {
  const base: Base = { id: 'rebar', title: 'Resizable BAR', costText: '0–10 %, depending on the game.', fixWhere: 'bios' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
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

/** The app a laptop maker puts its performance modes in, by the board's manufacturer string; null for a maker without one the rule knows. */
export function laptopVendorApp(manufacturer: string): string | null {
  const m = manufacturer.toLowerCase();
  if (/asus/.test(m)) return 'Armoury Crate';
  if (/lenovo/.test(m)) return 'Lenovo Vantage';
  if (/\bhp\b|hewlett/.test(m)) return 'Omen Gaming Hub';
  if (/\bmsi\b|micro-star/.test(m)) return 'MSI Center';
  if (/acer/.test(m)) return 'Acer NitroSense or PredatorSense';
  if (/dell|alienware/.test(m)) return 'Alienware Command Center';
  if (/razer/.test(m)) return 'Razer Synapse';
  return null;
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
    // On battery an efficiency mode is what Windows does by design; the finding is that the
    // machine is unplugged, not a setting to change (plan 17c: the power page is battery-aware;
    // the first laptop read "holds the CPU at low clocks even when plugged in" while unplugged).
    if (s.battery?.present && !s.battery.onAc) {
      const mode = overlay === OVERLAY_BEST_EFFICIENCY ? 'Best power efficiency' : guid === POWER_SAVER ? 'Power saver' : name;
      return finding(base, {
        state: 'info', severity: 1, costEstimate: 0.1,
        costText: 'Large while unplugged: the CPU and GPU run slower on battery.',
        detail: `On battery (${s.battery.percent !== null ? `${s.battery.percent} %, ` : ''}${mode}): Windows holds the CPU and GPU back to save charge, which is what it should do unplugged.`,
        fix: 'Plug in before gaming; then set Power mode to Best performance in Settings > System > Power & battery.'
      });
    }
    if (overlay === OVERLAY_BEST_EFFICIENCY) {
      return finding(base, { state: 'bad', severity: 3, costEstimate: 0.25, detail: 'Power mode Best power efficiency holds the CPU at low clocks even when plugged in.', fix });
    }
    if (performance) return finding(base, ok(`${name}: the CPU and GPU are allowed full speed.`));
    if (guid === POWER_SAVER) {
      return finding(base, { state: 'bad', severity: 3, costEstimate: 0.25, detail: 'Power saver on a laptop holds the CPU at low clocks even when plugged in.', fix });
    }
    // The laptop maker's own plan ("ASUS Recommended" on the first laptop) with the slider at
    // Balanced: the performance modes live in the vendor app, so the advice names it rather
    // than calling the maker's default a fault.
    const vendorApp = laptopVendorApp(s.motherboard.manufacturer);
    if (guid !== BALANCED && vendorApp) {
      return finding(base, {
        state: 'info', severity: 1, costEstimate: 0.1,
        costText: 'Whatever the quiet mode holds back: the vendor app decides.',
        detail: `${name} is the laptop maker's plan with Windows' Power mode at Balanced; the performance modes on this laptop live in ${vendorApp}.`,
        fix: `Before gaming pick the performance mode in ${vendorApp} and set Power mode to Best performance in Settings > System > Power & battery.`
      });
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

function checkThermal(s: StaticSnapshot, run: LoadRun | null): AuditFinding | null {
  const base: Base = { id: 'thermal-headroom', title: 'GPU thermal headroom', costText: 'Throttling: the card slows itself down when it runs hot.', fixWhere: 'hardware' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
  const samples = doneSamples(run);
  if (!samples || !run) {
    return finding(base, unknown('Measured with a 20-second heavy GPU load.', 'Run the audit; the load test is part of it.'));
  }
  const steady = steadyWindow(run, samples);
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
  const ends = endsOf(steady.map(x => x.smMhz));
  const startMhz = Math.round(ends.start);
  const endMhz = Math.round(ends.end);
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

/** Ollama's runner: when a model is resident the AI-model finding already names it, so it is not a second card here. */
const isOllamaRunner = (name: string) => /^(ollama|llama-server|ollama_llama_server)(\.exe)?$/i.test(name);
const BUSY_CPU_PERCENT = 5;
const HOG_MIB = 2048;

function checkHogs(hogs: HogsResult | null, s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'background-hogs', title: 'Background programs', costText: 'Whatever they take: a busy background program steals CPU time from the game, a large one its memory.', fixWhere: 'windows' };
  if (!hogs) return finding(base, unknown('Measured with a 5-second sample while the machine idles.', 'Run the audit with the machine idle.'));
  const modelResident = (s.ollama?.length ?? 0) > 0;
  const heavy = hogs.processes.filter(p => (p.cpuPercent > BUSY_CPU_PERCENT || p.workingSetMiB > HOG_MIB) && !isVmHost(p.name) && !(modelResident && isOllamaRunner(p.name)));
  const vms = hogs.processes.filter(p => isVmHost(p.name) && p.workingSetMiB > HOG_MIB);
  const vmNote = vms.length ? ` ${vms[0].name} holds ${(vms[0].workingSetMiB / 1024).toFixed(1)} GB for WSL or a virtual machine; wsl --shutdown (or stopping the VM) returns it.` : '';
  if (heavy.length === 0) {
    if (vms.length) return finding(base, { state: 'info', severity: 1, costEstimate: 0.05, detail: `Nothing busy in the background over ${hogs.seconds} s.${vmNote}`, fix: 'Shut the VM down before gaming if the game needs the memory.' });
    return finding(base, ok(`Nothing heavy in the background over ${hogs.seconds} s.`));
  }
  // A process that qualified on its working set alone is holding memory, not stealing CPU time; the wording says which.
  const gb = (p: HogsResult['processes'][number]) => `${(p.workingSetMiB / 1024).toFixed(1)} GB`;
  const busy = heavy.filter(p => p.cpuPercent > BUSY_CPU_PERCENT);
  const holding = heavy.filter(p => p.cpuPercent <= BUSY_CPU_PERCENT);
  const busyText = busy.length ? `Busy while idle: ${list(busy.slice(0, 3).map(p => `${p.name} (${Math.round(p.cpuPercent)} % CPU, ${gb(p)})`))}${busy.length > 3 ? ` and ${busy.length - 3} more` : ''}.` : '';
  const holdingText = holding.length ? `${list(holding.slice(0, 3).map(p => `${p.name} holds ${gb(p)}`))}${holding.length > 3 ? ` and ${holding.length - 3} more` : ''} while idle.` : '';
  return finding(base, {
    state: 'warn', severity: 2, costEstimate: 0.1,
    detail: `${[busyText, holdingText].filter(Boolean).join(' ')}${vmNote}`,
    fix: 'Close what you do not need before gaming, or stop it from starting with Windows (Settings > Apps > Startup).'
  });
}

function checkPowerLimit(s: StaticSnapshot): AuditFinding | null {
  const base: Base = { id: 'gpu-power-limit', title: 'GPU power limit', costText: 'A few percent at most; heat and noise go up with it.', fixWhere: 'app' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
  if (!(gpu.powerLimitMw > 0) || !(gpu.powerMaxLimitMw > 0)) return finding(base, unknown('The driver did not report the power limits.'));
  if (gpu.powerLimitMw >= gpu.powerMaxLimitMw) {
    // The slider being at its stop says nothing about overclocking headroom: the user may
    // well run raised clock and memory offsets on top of it (the GPU overclock finding).
    return finding(base, {
      state: 'info', severity: 0, costEstimate: 0, costText: 'Nothing to raise there; clock and memory offsets are a separate lever.',
      detail: `Power limit slider is at its maximum (${watts(gpu.powerLimitMw)} W) — nothing to raise there. Clock and memory offsets are a separate lever.`,
      fix: 'Nothing to change. Tune will look for an undervolt that keeps the clocks at less power and heat.'
    });
  }
  const headroom = watts(gpu.powerMaxLimitMw - gpu.powerLimitMw);
  return finding(base, {
    state: 'info', severity: 0, costEstimate: 0, costText: `${headroom} W of headroom.`,
    detail: `The power limit is ${watts(gpu.powerLimitMw)} W; the card allows up to ${watts(gpu.powerMaxLimitMw)} W.`,
    fix: 'Raising it trades heat and noise for a few percent; Tune tests that safely.'
  });
}

/**
 * Item 7: the applied offsets are one route to an overclock and the driver reports them;
 * a vendor tool or a VF curve is another and it does not (the dev box reads 0 / 0 offsets
 * while holding 3226 / 16032 MHz against the driver's 3090 / 14001 MHz ceilings), so the
 * clocks held under load are judged against the ceilings too. One boost step of slack
 * keeps a card sitting exactly on its ceiling out of it.
 */
const BOOST_STEP_MHZ = 15;

function checkGpuOffsets(s: StaticSnapshot, run: LoadRun | null): AuditFinding | null {
  const base: Base = { id: 'gpu-oc-offsets', title: 'GPU overclock', costText: 'Whatever the overclock gives: a few percent, at the cost of stability if pushed.', fixWhere: 'app' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
  const offsets = gpu.clockOffsets;
  if (!offsets) return finding(base, unknown('This driver does not report clock offsets; NVML 12.5 or newer does.'));
  if (offsets.smMhz === null && offsets.memMhz === null) return finding(base, unknown('The card did not report its clock offsets.'));
  const samples = doneSamples(run);
  const steady = samples && run ? steadyWindow(run, samples) : [];
  const heldSm = steady.length >= 4 ? Math.round(mean(steady.map(x => x.smMhz))) : null;
  const heldMem = steady.length >= 4 ? Math.round(mean(steady.map(x => x.memMhz))) : null;
  const maxSm = offsets.maxClockSmMhz || null;
  const maxMem = offsets.maxClockMemMhz || null;
  const overSm = heldSm !== null && maxSm !== null && heldSm > maxSm + BOOST_STEP_MHZ;
  const overMem = heldMem !== null && maxMem !== null && heldMem > maxMem + BOOST_STEP_MHZ;
  const held = heldSm === null ? '' : `; held ${heldSm} MHz under load`;
  const ceiling = maxSm ? ` (driver max ${maxSm})` : '';
  const stableFix = 'Nothing to change while it is stable; if a game crashes or shows artifacts, lower the overclock first.';
  if (!offsets.smMhz && !offsets.memMhz) {
    if (overSm || overMem) {
      const clocks = `${heldSm} MHz core / ${heldMem} MHz memory`;
      const limits = `${maxSm ?? '?'} / ${maxMem ?? '?'} MHz maximums`;
      return finding(base, info(
        `The driver reports no clock offsets, yet the card held ${clocks} under load, above its ${limits}: an overclock is applied by another route (a vendor tool or a VF curve).`,
        stableFix
      ));
    }
    return finding(base, ok(`The driver reports no clock offsets${held}${ceiling}.`));
  }
  // The driver counts the memory offset on the effective rate, the slider's figure (thisCard.ts nvmlMemOffsetMhz).
  const memNvml = nvmlMemOffsetMhz(offsets);
  const parts = [offsets.smMhz !== null ? `Core ${signed(offsets.smMhz)} MHz` : '', memNvml !== null ? `memory ${signed(memNvml)} MHz${memNvml ? ` (${signed(offsets.memMhz!)} on the effective rate, the slider's figure)` : ''}` : ''].filter(Boolean);
  return finding(base, info(`${parts.join(', ')} offsets applied${held}${ceiling}.`, stableFix));
}

/** "−30 all-core Curve Optimizer": what the user set, in words for the advice; null when nothing is set. */
function curveOptimizerRun(co: CurveOptimizer): string | null {
  if (!curveOptimizerSet(co)) return null;
  return co.coAllCore ? `${coText(co.coAllCore)} all-core Curve Optimizer` : `a per-core Curve Optimizer (${co.coPerCore!.trim()})`;
}

/** The setting-side levers against Ryzen heat, minus the one the user already pulled (polish 3 item 2). */
function ryzenHeatLevers(co: CurveOptimizer): string {
  const run = curveOptimizerRun(co);
  return run ? `you already run ${run}, so the remaining levers are a lower PPT in the BIOS or better cooling.` : 'a lower PPT or a Curve Optimizer undervolt in the BIOS buys headroom at little cost.';
}

/** Tctl before the worker started: the run's first sample is the idle reference (LoadRunner), so it stands for what a light load sees. */
function restTctl(run: LoadRun | null): number | null {
  const t = run?.cpuSamples[0]?.tctlC;
  return t !== null && t !== undefined && Number.isFinite(t) ? Math.round(t) : null;
}

function checkCpuThermal(s: StaticSnapshot, run: LoadRun | null, co: CurveOptimizer, cpuSensors?: boolean): AuditFinding {
  const base: Base = { id: 'cpu-thermal', title: 'CPU thermal headroom', costText: 'Throttling: the CPU drops its clocks when it reaches its temperature limit.', fixWhere: 'hardware' };
  const why = cpuRunOrWhy(run, cpuSensors);
  if (why) return finding(base, why);
  const steady = cpuSteady(run)!;
  const temps = finite(steady.map(x => x.tctlC));
  if (temps.length === 0) return finding(base, unknown('The CPU temperature sensor was not readable during the load run.'));
  const sustained = Math.round(mean(temps));
  const peak = Math.round(Math.max(...temps));
  const spec = cpuSpec(s.cpu.name);
  if (!spec) return finding(base, info(`Peaked at ${peak} °C under the all-core load (sustained ${sustained} °C); this part's temperature limit is not in the table, so there is no verdict.`));
  const tjmax = spec.tjmaxC;
  const clocks = finite(steady.map(x => x.avgEffectiveMhz));
  const ends = clocks.length >= 4 ? endsOf(clocks) : null;
  const sag = ends && ends.start > 0 ? (ends.start - ends.end) / ends.start : 0;
  const held = ends ? `${Math.round(ends.start)} to ${Math.round(ends.end)} MHz effective` : '';
  const ryzen = /ryzen/i.test(s.cpu.name);
  const pinned = peak >= tjmax - CPU_PINNED_BELOW_TJMAX_C;
  const rest = restTctl(run);
  // The cooler branches name the settings lever last; on Ryzen it never repeats what the user already set.
  const levers = ryzen ? `; on Ryzen ${ryzenHeatLevers(co)}` : '.';
  if (pinned && sag >= CPU_SAG_WARN) {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: Number(sag.toFixed(2)),
      detail: `The CPU sat at its ${tjmax} °C limit under the all-core load and its clocks fell ${pct(sag)} % (${held}): it is thermally throttling.`,
      fix: `Improve CPU cooling: reseat the cooler with fresh paste, check the pump and fans, raise the fan curve${levers}`
    });
  }
  if (rest !== null && rest >= tjmax - CPU_REST_WARN_BELOW_TJMAX_C) {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: 0.05,
      costText: 'Little headroom: games will sit at the limit too, and throttle on a hot day.',
      detail: `The CPU was already at ${rest} °C before the all-core load started, ${tjmax - rest} °C from its ${tjmax} °C limit, and held ${sustained} °C under it${held ? ` (${held})` : ''}: the cooler is not keeping up even at rest.`,
      fix: `Check the pump and fans first: a CPU this hot before a load points at a cooler not making contact or a pump that has stopped; then fresh paste and a higher fan curve${levers}`
    });
  }
  if (sustained >= tjmax - CPU_WARM_BELOW_TJMAX_C) {
    const gap = tjmax - sustained;
    const where = gap <= 0 ? `sat at its ${tjmax} °C limit` : `held ${sustained} °C, ${gap} °C from its ${tjmax} °C limit,`;
    const holding = held ? `, with clocks holding (${held})` : '';
    if (ryzen) {
      // Ryzen boosts until it meets Tjmax by design, so a pinned all-core load with steady
      // clocks loses nothing today; what it lacks is headroom, and the card says exactly that
      // rather than sending the owner of a working cooler to repaste it.
      return finding(base, {
        state: 'info', severity: 0, costEstimate: 0,
        costText: 'Nothing lost: the clocks held.',
        detail: `The CPU ${where} under the all-core load${holding}. Ryzen boosts until it meets its limit, so this is by design under an all-core load; games load it less. Nothing is lost now, but a hotter room or a longer load has no headroom left.`,
        fix: `Nothing required; ${ryzenHeatLevers(co)}`,
        fixWhere: 'none'
      });
    }
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: 0.05,
      costText: 'Little headroom: a hotter room or a longer load will start throttling.',
      detail: `The CPU ${where} under the all-core load${holding}. Games load it less, but there is little headroom for a hot day.`,
      fix: 'Improve CPU cooling: check the pump and fans and raise the fan curve; fresh paste if the cooler has been on for years.'
    });
  }
  return finding(base, ok(`Held ${sustained} °C under the all-core load (peak ${peak} °C), ${tjmax - sustained} °C below the ${tjmax} °C limit.`));
}

function checkCpuAllCoreClock(s: StaticSnapshot, run: LoadRun | null, cpuSensors?: boolean): AuditFinding {
  const base: Base = { id: 'cpu-allcore-clock', title: 'All-core clock under load', costText: 'What the CPU really runs at when every core is busy.', fixWhere: 'none' };
  const why = cpuRunOrWhy(run, cpuSensors);
  if (why) return finding(base, why);
  const steady = cpuSteady(run)!;
  const clocks = finite(steady.map(x => x.avgEffectiveMhz));
  if (clocks.length === 0) return finding(base, unknown('The effective clock sensor was not readable during the load run.'));
  const eff = Math.round(mean(clocks));
  const spec = cpuSpec(s.cpu.name);
  if (!spec) return finding(base, info(`All cores ran at ${ghz(eff)} effective under the load.`));
  if (eff < spec.baseMhz * BELOW_BASE) {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: 0.1, fixWhere: 'bios',
      detail: `All-core ${ghz(eff)} effective under load, below the ${ghz(spec.baseMhz)} base clock: heat or a power limit is holding the CPU back.`,
      fix: 'Check the CPU thermal and package-power findings; better cooling or a higher power limit in the BIOS lets it boost.'
    });
  }
  return finding(base, info(`All-core ${ghz(eff)} effective under load (spec base ${ghz(spec.baseMhz)}, single-core boost ${ghz(spec.boostMhz)}).`));
}

function checkCpuPackagePower(s: StaticSnapshot, run: LoadRun | null, cpuPptW: number | null, cpuSensors?: boolean): AuditFinding {
  const base: Base = { id: 'cpu-package-power', title: 'CPU package power', costText: 'At the limit the CPU cannot boost further; games rarely reach it.', fixWhere: 'app' };
  const why = cpuRunOrWhy(run, cpuSensors);
  if (why) return finding(base, why);
  const steady = cpuSteady(run)!;
  const power = finite(steady.map(x => x.packageW));
  if (power.length === 0) return finding(base, unknown('The package power sensor was not readable during the load run.'));
  const measured = Math.round(mean(power));
  const spec = cpuSpec(s.cpu.name);
  const name = spec?.powerName ?? 'PPT';
  const stock = spec?.stockPowerW;
  const configured = cpuPptW !== null && cpuPptW > 0 ? Math.round(cpuPptW) : null;
  // The control is the gear on the Monitor page (the button under this card opens it); there is no Settings page.
  // On a laptop the limit is the vendor app's power mode, not a BIOS setting (plan 17d row 2; the Monitor's gear menu says the same).
  const laptop = s.chassis.isLaptop;
  const setIt = laptop
    ? `Enter the ${name} your vendor app's mode runs at with the button below (Monitor page, gear > CPU power mode you set in the vendor app > ${name}), so the Package bar and this check use it.`
    : `Enter the limit you set in the BIOS or Ryzen Master with the button below (Monitor page, gear > CPU tuning you set in BIOS > ${name}), so the Package bar and this check use it.`;
  if (configured === null && stock === undefined) {
    return finding(base, info(`Package power averaged ${measured} W under the all-core load; this part's stock limit is not in the table, so there is no verdict until the limit is set.`, setIt));
  }
  if (configured === null && stock !== undefined && measured > stock * PBO_OVER_STOCK) {
    // Never claim to read the limit: the sensors cannot (dependencies.md); the measurement over stock is the inference.
    return finding(base, info(laptop
      ? `The vendor app's power mode runs the CPU above its ${stock} W default: ${measured} W under the all-core load. Set the mode's ${name} here.`
      : `PBO / raised ${name} active — measured ${measured} W over the stock ${stock} W; set your ${name} limit here.`, setIt));
  }
  const limit = configured ?? stock!;
  const label = configured === null ? ' (stock)' : ' (set by you)';
  if (configured !== null && measured > configured * PBO_OVER_STOCK) {
    return finding(base, info(`Measured ${measured} W over the configured ${configured} W limit: the limit set here looks lower than the one the BIOS applies.`, `Check the ${name} set on the Monitor page against the BIOS or Ryzen Master.`));
  }
  if (measured >= limit * AT_LIMIT_FRACTION) {
    return finding(base, info(`At the ${limit} W ${name} limit${label} under the all-core load (${measured} W): normal, the limit is what stops the CPU boosting further.`, 'Nothing to change; raising the limit (PBO) trades heat for a little more all-core speed.'));
  }
  return finding(base, ok(`${measured} W under the all-core load, within the ${limit} W ${name} limit${label}.`));
}

function checkCpuSmt(s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'cpu-smt', title: 'Simultaneous multithreading (SMT)', costText: 'Up to 20–30 % in multi-threaded work; a few percent either way in games.', fixWhere: 'bios' };
  const { cores, logical } = s.cpu;
  if (!(cores > 0) || !(logical > 0)) return finding(base, unknown('Windows did not report the core count.'));
  if (logical > cores) return finding(base, ok(`${cores} cores, ${logical} threads: SMT on.`));
  // Equal counts mean "off" only on a part that has SMT to turn off: every Core Ultra
  // 200-series part ships without Hyper-Threading, and the table says which is which.
  const spec = cpuSpec(s.cpu.name);
  if (spec?.threads !== undefined && spec.cores !== undefined && spec.threads === spec.cores) {
    return finding(base, ok(`${cores} cores, ${logical} threads: this part has no SMT.`));
  }
  const known = spec?.threads !== undefined && spec.cores !== undefined && spec.threads > spec.cores;
  return finding(base, {
    state: 'info', severity: 1, costEstimate: 0.05,
    detail: known
      ? `${cores} cores and ${logical} threads: SMT (Hyper-Threading) is off, so multi-threaded work runs slower; a few games gain a little from it being off.`
      : `${cores} cores and ${logical} threads: SMT (Hyper-Threading) appears off, or this part has none; multi-threaded work runs slower with it off.`,
    fix: known
      ? 'In the BIOS turn SMT (AMD) or Hyper-Threading (Intel) on, under Advanced > CPU Configuration.'
      : 'If the BIOS has an SMT (AMD) or Hyper-Threading (Intel) switch under Advanced > CPU Configuration, turn it on; a part without one has nothing to change.'
  });
}

/** The first sample of the CPU run is taken before the worker starts (LoadRunner), so it is the idle reference. */
function checkCpuIdleClock(run: LoadRun | null, cpuSensors?: boolean): AuditFinding {
  const base: Base = { id: 'cpu-idle-clock', title: 'Idle clock', costText: 'Nothing at stake: how the CPU rests between frames.', fixWhere: 'none' };
  if (cpuSensors === false) return finding(base, CPU_SENSORS_MISSING);
  const idle = run && run.kind === 'cpu' && run.state === 'done' ? run.cpuSamples[0] : undefined;
  if (!idle) return finding(base, CPU_RUN_MISSING);
  if (idle.avgEffectiveMhz === null || idle.maxCoreMhz === null) return finding(base, unknown('The clock sensors were not readable before the load run.'));
  return finding(base, info(`Idle: ${Math.round(idle.avgEffectiveMhz)} MHz effective while the cores report up to ${Math.round(idle.maxCoreMhz)} MHz; the effective figure is the real rate, the other is the boost the cores stand ready to reach.`));
}

/**
 * The missing-ROPs check (plan §8, user 2026-09-16): early RTX 50-series batches shipped with
 * a raster engine disabled (168 ROPs on a 5090 instead of 176; NVIDIA confirmed it in
 * February 2025 for the 5090, 5090 D and 5070 Ti, later the 5080), about 4 % slower, and
 * the vendors replace affected cards. The direct read is NVAPI's own count (GpuFacts.units,
 * the number GPU-Z shows); when the driver did not answer it, the fill-rate cross-check
 * (gpuUnits.ts) stands in with its band, and a 4.5 % question is never decided from a bare
 * number. The reference is the gpus.json row for the card.
 */
const ROPS_COST = 0.04;
const RTX_50 = /RTX\s*50\d0/i;

/**
 * Whether the audit should spend the 6 s fill-rate run (kind 'fillrate'): only when the card
 * is in the reference table and the driver gave no direct ROP count, since with a direct read
 * the cross-check is appended but never decisive, and without a reference it judges nothing.
 */
export function needsFillRateCrossCheck(s: StaticSnapshot): boolean {
  const gpu = s.gpus[0];
  return !!gpu && lookupGpu(gpu.name, gpu.vram.totalMiB) !== null && (gpu.units?.rops ?? null) === null;
}

function checkGpuUnits(s: StaticSnapshot, fillRate: LoadRun | null | undefined): AuditFinding | null {
  const base: Base = { id: 'gpu-units', title: 'GPU unit counts (missing ROPs)', costText: 'About 4 %: a card with a raster unit disabled renders that much slower in every game.', fixWhere: 'hardware' };
  const gpu = s.gpus[0];
  if (!gpu) return null;
  const spec = lookupGpu(gpu.name, gpu.vram.totalMiB);
  if (!spec) return finding(base, unknown(`${gpu.name} is not in the reference table (src/data/gpus.json), so there is nothing to compare its unit counts with.`));
  const partner = boardPartnerOf(gpu.pciSubsystem?.vendorId) ?? 'the card\'s vendor';
  const rma = `The vendor replaces affected cards — contact ${partner} support with a GPU-Z screenshot or this report.`;
  const estimate = fillRateEstimate(fillRate, spec.rops);
  const crossCheck = estimate ? ` Fill-rate cross-check: ${estimate.line}.` : '';
  const rops = gpu.units?.rops ?? null;
  if (rops !== null) {
    const shaders = gpu.units?.shaders ? `, ${gpu.units.shaders.toLocaleString('en-US')} shaders` : '';
    if (rops < spec.rops) {
      const why = RTX_50.test(spec.name)
        ? 'Early RTX 50-series batches shipped with a raster unit disabled (NVIDIA confirmed, Feb 2025), about 4 % slower.'
        : 'A card with fewer raster units than its reference design renders slower in every game.';
      return finding(base, {
        state: 'bad', severity: 3, costEstimate: ROPS_COST,
        detail: `Your card reports ${rops} ROPs; a ${spec.name} has ${spec.rops}. ${why}${crossCheck}`,
        fix: rma
      });
    }
    if (rops > spec.rops) {
      return finding(base, info(`Your card reports ${rops} ROPs, more than the ${spec.rops} in the reference row for a ${spec.name}: the table row is wrong for this card, not the card.${crossCheck}`));
    }
    return finding(base, ok(`${rops} of ${spec.rops} ROPs${shaders}: the full ${spec.name} configuration.${crossCheck}`));
  }
  const noDirect = 'The driver did not answer the unit-count query (NVAPI), so the ROP count could not be read directly.';
  if (!estimate) {
    return finding(base, unknown(noDirect, `Run the audit again with nothing else using the GPU: it then runs the 6-second fill-rate cross-check, which draws full-screen quads as fast as the GPU writes pixels and compares the rate with the ${spec.rops} ROPs a ${spec.name} has.`));
  }
  if (estimate.verdict === 'consistent') {
    return finding(base, ok(`Fill-rate cross-check: ${estimate.line}. ${noDirect} A consistency check, not a count: a GPU-Z screenshot is the exact figure.`));
  }
  if (estimate.verdict === 'inconsistent') {
    return finding(base, {
      state: 'warn', severity: 2, costEstimate: ROPS_COST,
      detail: `Fill-rate cross-check: ${estimate.line}. ${noDirect} A ${spec.name} has ${spec.rops} ROPs; early RTX 50-series batches shipped with a raster unit disabled (NVIDIA confirmed, Feb 2025).`,
      fix: `Confirm the count with GPU-Z (it reads the ROPs directly). ${rma}`
    });
  }
  return finding(base, unknown(`Fill-rate cross-check: ${estimate.line}. ${noDirect}`, 'Close anything else using the GPU and run the audit again.'));
}

/**
 * Family-aware: this box keeps an Ollama model resident for Strata Photo and Code. Most
 * people never install Ollama (plan §10, "no local model is the normal case"): when it is
 * not running there is no row at all, because this is an observation for AI users, not a
 * finding for everyone.
 */
function checkAiModel(s: StaticSnapshot): AuditFinding | null {
  const base: Base = { id: 'ai-model-resident', title: 'AI model in video memory', costText: 'Games get less video memory while a model is loaded.', fixWhere: 'app' };
  if (s.ollama === null) return null;
  if (s.ollama.length === 0) return finding(base, ok('Ollama is running but holds no model.'));
  const held = s.ollama.map(m => `${m.name} holds ${Number((m.sizeVramBytes / 1e9).toFixed(1))} GB of VRAM`);
  return finding(base, {
    state: 'info', severity: 1, costEstimate: 0.1,
    detail: `${list(held)}; fine for AI work, costs games headroom.`,
    fix: `ollama stop ${s.ollama[0].name} to unload it; Ollama loads it again on the next request.`
  });
}

/**
 * Timer resolution (plan section 8). Windows ticks at 15.625 ms by default; games raise it to
 * 0.5–1 ms while they run and the kernel drops it again when they exit. During the audit
 * nothing should be running, so a timer held at the finest step is a background program's,
 * and the one the trace names is the finding. Strata Tune's own processes (Chromium raises
 * the timer while the window animates) are never the culprit. On a desktop the cost is a
 * little idle power; on a laptop it is battery, which is where it earns a warning.
 */
/**
 * One holder per image name, the finest period it asks for and how many of its processes
 * hold the timer: the trace lists every process, and a chat app with nine helpers (the dev
 * box read claude.exe nine times, Discord.exe three) is one thing to close, not nine.
 * Finest period first, then the most processes.
 */
export function timerHolders(foreign: readonly TimerRequester[]): string[] {
  const byName = new Map<string, { count: number; periodMs: number | null }>();
  for (const r of foreign) {
    const g = byName.get(r.name) ?? { count: 0, periodMs: null };
    g.count += 1;
    if (r.periodMs !== null && (g.periodMs === null || r.periodMs < g.periodMs)) g.periodMs = r.periodMs;
    byName.set(r.name, g);
  }
  return [...byName]
    .sort((a, b) => (a[1].periodMs ?? Number.MAX_VALUE) - (b[1].periodMs ?? Number.MAX_VALUE) || b[1].count - a[1].count)
    .map(([name, g]) => `${name}${g.count > 1 ? ` ×${g.count}` : ''}${g.periodMs !== null ? ` (asks for ${g.periodMs} ms)` : ''}`);
}

function checkTimerResolution(t: Timers | null, s: StaticSnapshot): AuditFinding {
  const base: Base = { id: 'timer-resolution', title: 'Windows timer resolution', costText: 'A background program holding the timer at its finest step costs battery on laptops and a little idle power on desktops.', fixWhere: 'windows' };
  if (!t || t.currentMs === null || t.coarsestMs === null || t.finestMs === null) return finding(base, unknown("Read from the collector's timer probe.", 'Run the audit; the timer is read with it.'));
  const current = `${t.currentMs} ms`;
  const clock = `The performance counter runs at ${(t.qpcFrequency / 1e6).toFixed(t.qpcFrequency % 1e6 ? 3 : 0)} MHz from the ${t.qpcSource}.`;
  if (t.currentMs >= t.coarsestMs) {
    return finding(base, info(`${current}, the platform default: nothing is holding it raised. A game raises it to 0.5–1 ms itself while it runs; if one does not, its frame pacing gets uneven. ${clock}`));
  }
  const foreign = (t.requesters ?? []).filter((r) => !r.own);
  const names = timerHolders(foreign);
  const atFinest = t.currentMs <= t.finestMs;
  if (foreign.length === 0) {
    const who = t.requesters === null ? 'the trace that names the holder did not run' : t.requesters.length ? 'only Strata Tune itself holds it, which ends when this window closes' : t.requestersNote ?? 'the trace listed no holder';
    return finding(base, info(`${current}, raised from the ${t.coarsestMs} ms default; ${who}. ${clock}`));
  }
  if (!atFinest) {
    return finding(base, info(`${current}, raised from the ${t.coarsestMs} ms default by ${list(names)}. Normal for a media or chat app; it drops back when they close. ${clock}`));
  }
  const cost = s.chassis.isLaptop ? 'On a laptop this costs battery: the CPU cannot rest between ticks.' : 'On a desktop this costs a little idle power and nothing in games.';
  return finding(base, {
    state: 'warn', severity: 1, costEstimate: 0.01,
    detail: `${list(names)} ${names.length === 1 ? 'holds' : 'hold'} the timer at its finest step, ${current}, with nothing running that needs it. ${cost} ${clock}`,
    fix: `Close ${names.length === 1 ? 'it' : 'them'} when you are not using ${names.length === 1 ? 'it' : 'them'}, or stop ${names.length === 1 ? 'it' : 'them'} from starting with Windows (Settings > Apps > Startup). Games raise the timer themselves.`
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
    checkGpuCoverage(s),
    checkPcie(s, inputs.pcieUnderLoad),
    checkRebar(s),
    checkPowerPlan(s),
    checkBootDrive(s),
    checkGameOnHdd(),
    checkHddPresent(s),
    checkThermal(s, inputs.thermalRamp),
    checkDriverAge(s, inputs.nowIso),
    checkHogs(inputs.hogs, s),
    checkPowerLimit(s),
    checkGpuOffsets(s, inputs.thermalRamp),
    checkGpuUnits(s, inputs.fillRate),
    checkCpuThermal(s, inputs.cpuLoad, inputs.curveOptimizer, inputs.cpuSensors),
    checkCpuAllCoreClock(s, inputs.cpuLoad, inputs.cpuSensors),
    checkCpuPackagePower(s, inputs.cpuLoad, inputs.cpuPptW, inputs.cpuSensors),
    checkCpuSmt(s),
    checkCpuIdleClock(inputs.cpuLoad, inputs.cpuSensors),
    checkAiModel(s),
    checkTimerResolution(inputs.timers ?? null, s)
  ];
  return rankFindings(findings.filter((f): f is AuditFinding => f !== null));
}
