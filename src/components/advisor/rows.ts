/**
 * View adapter between the analysis (src/analysis/advisor.ts, hardware-tables.ts)
 * and the advisor components: flat rows with what the list, the best-for grid
 * and the calibration table read, and the spec view the stats card draws. The
 * components never touch the analysis types, so the analysis can change shape
 * behind this one file.
 */
import type { GpuBench, OllamaBench } from '../../api';
import { CALIBRATION_FACTOR, STREAM_EFFICIENCY, advise, bestFor, type AdvisorRow, type Bucket, type ModelSpec, type QuantSpec } from '../../analysis/advisor';
import { lookupCpu, lookupGpu, type AdvertisedTops, type TensorPrecision } from '../../analysis/hardware-tables';
import gpus from '../../data/gpus.json';
import models from '../../data/models.json';
import type { HardwareFacts } from './hardware';

export type { Bucket };
export type Precision = TensorPrecision;

/** The "best model for" uses, in the plan's order. */
export const USE_TAGS = ['chat', 'coding', 'vision', 'reasoning'] as const;
export type UseTag = (typeof USE_TAGS)[number];

const MODELS = models as ModelSpec[];

export const DEFAULT_FACTOR = CALIBRATION_FACTOR;
/** A derived factor outside this band means the run was not a clean decode (a game or the worker on the card, a model half in RAM). */
export const FACTOR_BAND: [number, number] = [0.3, 1.0];
/** The picker's dropdown is the table itself, so adding a row to gpus.json adds a choice. */
export const GPU_NAMES: string[] = (gpus as { name: string }[]).map((g) => g.name);
/** The slider's top end: the widest window any model in the table accepts. */
export const MAX_CONTEXT = Math.max(...MODELS.map((m) => m.maxContext));
/** Filter chips: the four uses first, then any other tag the table carries. */
export const ALL_TAGS: string[] = [...USE_TAGS, ...new Set(MODELS.flatMap((m) => m.tags).filter((t) => !(USE_TAGS as readonly string[]).includes(t)))];

/** Plan section 10's bytes-per-weight table read backwards, for a quant row with no display name. */
const QUANT_LABELS: [number, string][] = [
  [2, 'fp16'],
  [1, 'q8_0'],
  [0.82, 'q6_K'],
  [0.7, 'q5_K_M'],
  [0.56, 'q4_K_M'],
  [0.5, 'nvfp4']
];
const quantLabel = (q: QuantSpec) => q.quant ?? QUANT_LABELS.find(([b]) => Math.abs(b - q.bytesPerWeight) < 0.02)?.[1] ?? `${q.bytesPerWeight} B/weight`;

export interface ViewRow {
  key: string;
  name: string;
  pullTag: string;
  quantLabel: string;
  tags: string[];
  maxContext: number;
  requiredBytes: number;
  headroomBytes: number;
  bucket: Bucket;
  /** null when no bandwidth figure exists (a GPU outside gpus.json and not yet measured). */
  tokPerSec: number | null;
  tokPerSecOffloaded: number | null;
  /** Tokens per forward pass folded into the tok/s figures when the model has an MTP head; null for plain decode. */
  mtpAcceptedTokens: number | null;
  /** Paced by its active experts on the bandwidth bound alone: no MoE model has been timed against the factor (docs/phase3-calibration.md), so the figure is a ceiling. */
  moe: boolean;
  /** The model's window is shorter than the slider's context. */
  contextCapped: boolean;
  /** Would load right now against free VRAM (and RAM); false while another app holds the card. */
  fitsNow: boolean;
  /** No discrete GPU (plan 17d row 1): the row runs on the CPU from RAM at the RAM bus's rate, and the verdict says so instead of "runs slowly". */
  cpuOnly: boolean;
  downloadBytes: number;
  fitsOnDisk: boolean;
  /** The analysis row behind this one, so bestFor can run on what advise() returned. */
  source: AdvisorRow;
}

export interface GpuSpecView {
  name: string;
  /** Who advertises the headline figure: "NVIDIA advertises 3,352". */
  vendor: string;
  /** Apple Silicon: one memory pool; the VRAM figure is the GPU's working set and the clock the machine's own (hardware-tables.ts GpuSpec.unified). */
  unified: boolean;
  /** Apple's Neural Engine core count; null elsewhere. */
  neuralEngineCores: number | null;
  /** Where the unit counts were read (TechPowerUp for cards, the review listing for Apple rows). */
  unitsUrl: string;
  vramGiB: number;
  /** null when nobody publishes a figure: the card says so and tok/s waits for a measurement. */
  bandwidthGBs: number | null;
  tops: Partial<Record<Precision, number>>;
  sparse: Partial<Record<Precision, number>>;
  denseDerived: boolean;
  advertised: AdvertisedTops | null;
  fp32Tflops: number;
  tiles: {
    die: string;
    shadingUnits: number;
    tmus: number;
    rops: number;
    vramType: string;
    busBits: number;
    memoryGbps: number;
    /** The reference memory clock in the GPU-Z convention, for the MEMORY CLOCK tile; null when the table has none. */
    memoryClockMhz: number | null;
    baseMhz: number | null;
    boostMhz: number;
    tdpW: number;
    /** Laptop parts: the TGP range the laptop maker chooses from; null on a desktop card. */
    tgpRangeW: [number, number] | null;
    suggestedPsuW: number | null;
  };
  source: string;
}

/** The plan's card order: the marketing formats first, the training formats after. */
export const PRECISIONS: Precision[] = ['fp4', 'fp8', 'int8', 'int4', 'fp16', 'bf16', 'tf32'];

/** What the machine knows that Apple's table does not print: the top of the GPU's clock table (electron/mac/snapshot.ts DisplayAdapter.maxClockMhz). */
export interface MachineGpu {
  maxClockMhz: number | null;
}

/** The VRAM total tells memory variants apart (4060 Ti 16/8 GB) when the name comes from NVML rather than the picker. */
export function gpuSpecOf(name: string, vramMiB?: number, machine?: MachineGpu): GpuSpecView | null {
  const g = lookupGpu(name, vramMiB);
  if (!g) return null;
  const unified = !!g.unified;
  // Apple publishes no clock: the machine's own clock-table top stands in, and the FP32 figure follows the table's own convention (ALUs x 2 x clock).
  const boostMhz = unified ? (machine?.maxClockMhz ?? 0) : g.boostMhz;
  const fp32Tflops = unified ? (boostMhz > 0 ? (g.shadingUnits * 2 * boostMhz) / 1e6 : 0) : g.fp32Tflops;
  const vramGiB = unified && vramMiB ? Math.round(vramMiB / 1024) : g.vramGiB;
  const pick = (from: Partial<Record<Precision, number>> | undefined) =>
    Object.fromEntries(PRECISIONS.flatMap((p) => (from?.[p] !== undefined ? [[p, from[p]]] : []))) as Partial<Record<Precision, number>>;
  return {
    name: g.name,
    vendor: g.vendor,
    unified,
    neuralEngineCores: g.neuralEngineCores ?? null,
    unitsUrl: g.tpuUrl,
    vramGiB,
    bandwidthGBs: g.bandwidthGBs,
    tops: pick(g.tops),
    sparse: pick(g.tops.sparse),
    denseDerived: g.denseDerived,
    advertised: g.advertisedAiTops,
    fp32Tflops,
    tiles: {
      die: g.die,
      shadingUnits: g.shadingUnits,
      tmus: g.tmus,
      rops: g.rops,
      vramType: g.vramType,
      busBits: g.busBits,
      memoryGbps: g.memoryGbps,
      memoryClockMhz: g.memoryClockMhz,
      baseMhz: g.baseMhz,
      boostMhz,
      tdpW: g.tdpW,
      tgpRangeW: g.tgpRangeW ?? null,
      suggestedPsuW: g.suggestedPsuW
    },
    source: g.source
  };
}

export interface Bandwidth {
  /** What a stream copy reaches: the worker's best pass, or the ceiling x STREAM_EFFICIENCY. */
  gbs: number;
  measured: boolean;
}

/**
 * The figure the estimates run on: a bench taken on this card, else the ceiling scaled to
 * what a copy reaches; null with neither. The ceiling is this card's own (live memory clock x
 * bus width, thisCard.ts) when the collector knows it, the reference spec otherwise:
 * STREAM_EFFICIENCY was measured against the dev box's tuned clock, not the table.
 */
export function streamedBandwidth(bench: GpuBench | null, applies: boolean, ceilingGBs: number | null): Bandwidth | null {
  if (bench && applies) return { gbs: bench.bandwidthGBs, measured: true };
  return ceilingGBs !== null ? { gbs: ceilingGBs * STREAM_EFFICIENCY, measured: false } : null;
}

export function npuTopsOf(cpuName: string | null): number | null {
  return (cpuName && lookupCpu(cpuName)?.npuTops) || null;
}

interface AdviseArgs {
  facts: HardwareFacts;
  /** null: the memory figures still rank the models, only tok/s is left blank. */
  bandwidthGBs: number | null;
  contextTokens: number;
  factor: number;
}

/** The analysis estimates at its default factor; tok/s is linear in it, so the calibrated factor is one scale. */
function toView(r: AdvisorRow, scale: number | null, cpuOnly = false): ViewRow {
  return {
    key: r.quant.tag,
    name: r.model.name,
    pullTag: r.quant.tag,
    quantLabel: quantLabel(r.quant),
    tags: r.model.tags,
    maxContext: r.model.maxContext,
    requiredBytes: r.requiredBytes,
    headroomBytes: r.headroomBytes,
    bucket: r.bucket,
    tokPerSec: scale === null ? null : r.tokPerSec * scale,
    tokPerSecOffloaded: scale === null || r.tokPerSecOffloaded === undefined ? null : r.tokPerSecOffloaded * scale,
    mtpAcceptedTokens: r.model.mtpAcceptedTokens ?? null,
    moe: r.model.activeParamsB < r.model.paramsB,
    contextCapped: r.contextCapped,
    fitsNow: r.fitsNow,
    cpuOnly,
    downloadBytes: r.downloadBytes,
    fitsOnDisk: r.fitsOnDisk,
    source: r
  };
}

/**
 * Every model against this machine. With no discrete GPU (plan 17d row 1) the whole model
 * streams from RAM: the analysis runs with no VRAM and the RAM bus as the bandwidth, so every
 * row that fits in RAM comes out "slow" (fully spilled, paced by the RAM bus) and is relabelled
 * as running on the CPU; the tok/s figure is the plan's CPU-only estimate (dual-channel DDR5
 * at about 80 GB/s puts a 4B model at a few tokens a second).
 */
export function adviseRows({ facts, bandwidthGBs, contextTokens, factor }: AdviseArgs): ViewRow[] {
  const cpuOnly = facts.integrated;
  const rows = advise({
    vramBytes: facts.vramBytes,
    vramFreeBytes: facts.vramFreeBytes,
    ramBytes: facts.ramBytes,
    ramFreeBytes: facts.ramFreeBytes,
    gpuBandwidthGBs: cpuOnly ? facts.ramBandwidthGBs : (bandwidthGBs ?? 0),
    ramBandwidthGBs: facts.ramBandwidthGBs,
    freeDiskBytes: facts.freeDiskBytes,
    contextTokens,
    models: MODELS
  });
  const scale = cpuOnly || bandwidthGBs !== null ? factor / CALIBRATION_FACTOR : null;
  return rows.map((r) => toView(r, scale, cpuOnly));
}

/** The analysis's own pick per use, mapped back to the view row by pull tag; on the CPU, the largest model per use that fits in RAM at all (nothing runs fast there). */
export function bestRows(rows: ViewRow[]): Record<UseTag, ViewRow | null> {
  const byTag = new Map(rows.map((r) => [r.pullTag, r]));
  const source = rows.map((r) => r.source);
  if (rows.some((r) => r.cpuOnly)) {
    return Object.fromEntries(USE_TAGS.map((tag) => [tag, rows.find((r) => r.bucket === 'slow' && !r.contextCapped && r.tags.includes(tag)) ?? null])) as Record<UseTag, ViewRow | null>;
  }
  return Object.fromEntries(USE_TAGS.map((tag) => [tag, byTag.get(bestFor(source, tag)?.quant.tag ?? '') ?? null])) as Record<UseTag, ViewRow | null>;
}

/** Whether a calibrated model counts towards the factor: an MTP row's ratio moves with the text, not the bus (advisor.ts factorFrom). */
export const inFactor = (est: ViewRow | undefined): est is ViewRow => !!est && est.mtpAcceptedTokens === null;

/** The estimate a measurement is judged against: a spilling model was timed after its cliff, not at the in-VRAM rate. */
export const estimateFor = (est: ViewRow): number | null => (est.bucket === 'slow' ? est.tokPerSecOffloaded : est.tokPerSec);

/** The factor the measurements imply: median of measured ÷ (estimate at factor 1), so it replaces the current one outright. */
export function derivedFactor(measurements: Record<string, OllamaBench>, estimates: Record<string, ViewRow | undefined>, factor: number): number | null {
  const ratios = Object.entries(measurements)
    .flatMap(([name, m]) => {
      const est = estimates[name];
      const expected = inFactor(est) ? estimateFor(est) : null;
      return expected && m.tokPerSec > 0 ? [m.tokPerSec / (expected / factor)] : [];
    })
    .sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  const mid = ratios.length >> 1;
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}
