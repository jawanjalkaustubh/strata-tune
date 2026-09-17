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
  downloadBytes: number;
  fitsOnDisk: boolean;
  /** The analysis row behind this one, so bestFor can run on what advise() returned. */
  source: AdvisorRow;
}

export interface GpuSpecView {
  name: string;
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
    baseMhz: number | null;
    boostMhz: number;
    tdpW: number;
    suggestedPsuW: number | null;
  };
  tpuUrl: string;
  source: string;
}

/** The plan's card order: the marketing formats first, the training formats after. */
export const PRECISIONS: Precision[] = ['fp4', 'fp8', 'int8', 'int4', 'fp16', 'bf16', 'tf32'];

/** The VRAM total tells memory variants apart (4060 Ti 16/8 GB) when the name comes from NVML rather than the picker. */
export function gpuSpecOf(name: string, vramMiB?: number): GpuSpecView | null {
  const g = lookupGpu(name, vramMiB);
  if (!g) return null;
  const pick = (from: Partial<Record<Precision, number>> | undefined) =>
    Object.fromEntries(PRECISIONS.flatMap((p) => (from?.[p] !== undefined ? [[p, from[p]]] : []))) as Partial<Record<Precision, number>>;
  return {
    name: g.name,
    vramGiB: g.vramGiB,
    bandwidthGBs: g.bandwidthGBs,
    tops: pick(g.tops),
    sparse: pick(g.tops.sparse),
    denseDerived: g.denseDerived,
    advertised: g.advertisedAiTops,
    fp32Tflops: g.fp32Tflops,
    tiles: {
      die: g.die,
      shadingUnits: g.shadingUnits,
      tmus: g.tmus,
      rops: g.rops,
      vramType: g.vramType,
      busBits: g.busBits,
      memoryGbps: g.memoryGbps,
      baseMhz: g.baseMhz,
      boostMhz: g.boostMhz,
      tdpW: g.tdpW,
      suggestedPsuW: g.suggestedPsuW
    },
    tpuUrl: g.tpuUrl,
    source: g.source
  };
}

export interface Bandwidth {
  /** What a stream copy reaches: the worker's best pass, or spec x STREAM_EFFICIENCY. */
  gbs: number;
  measured: boolean;
}

/** The figure the estimates run on: a bench taken on this card, else the spec scaled to what a copy reaches; null with neither. */
export function streamedBandwidth(bench: GpuBench | null, applies: boolean, spec: GpuSpecView | null): Bandwidth | null {
  if (bench && applies) return { gbs: bench.bandwidthGBs, measured: true };
  return spec?.bandwidthGBs != null ? { gbs: spec.bandwidthGBs * STREAM_EFFICIENCY, measured: false } : null;
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
function toView(r: AdvisorRow, scale: number | null): ViewRow {
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
    downloadBytes: r.downloadBytes,
    fitsOnDisk: r.fitsOnDisk,
    source: r
  };
}

export function adviseRows({ facts, bandwidthGBs, contextTokens, factor }: AdviseArgs): ViewRow[] {
  const rows = advise({
    vramBytes: facts.vramBytes,
    vramFreeBytes: facts.vramFreeBytes,
    ramBytes: facts.ramBytes,
    ramFreeBytes: facts.ramFreeBytes,
    gpuBandwidthGBs: bandwidthGBs ?? 0,
    ramBandwidthGBs: facts.ramBandwidthGBs,
    freeDiskBytes: facts.freeDiskBytes,
    contextTokens,
    models: MODELS
  });
  return rows.map((r) => toView(r, bandwidthGBs === null ? null : factor / CALIBRATION_FACTOR));
}

/** The analysis's own pick per use, mapped back to the view row by pull tag. */
export function bestRows(rows: ViewRow[]): Record<UseTag, ViewRow | null> {
  const byTag = new Map(rows.map((r) => [r.pullTag, r]));
  const source = rows.map((r) => r.source);
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
