import type { RamModule } from '../collector-types';

/**
 * Local AI model advisor (master plan section 10). Pure functions over the
 * model table and the machine's memory figures; the page supplies bandwidth
 * (measured when it exists, else spec scaled to what a copy reaches) and, once
 * calibrated, its own factor.
 */
export interface QuantSpec {
  /** The Ollama pull tag for exactly this quantisation. */
  tag: string;
  /** Display name of the quantisation (q4_K_M, q8_0, fp16). */
  quant?: string;
  /** Plan section 10's table, used only to pace decode; the file size below is what loads. */
  bytesPerWeight: number;
  /** Every blob the tag pulls, projector included: the ground truth for what VRAM must hold. */
  downloadBytes: number;
  notes?: string;
}

export interface ModelSpec {
  name: string;
  family: string;
  tags: string[];
  paramsB: number;
  /** MoE models read only their active experts per token; dense models repeat the total. */
  activeParamsB: number;
  /** Blocks whose KV cache grows with the whole context; a hybrid (qwen35) or windowed (gemma3) model counts only its full-attention blocks. */
  layers: number;
  /** Blocks whose KV cache is a sliding window, which Ollama and llama.cpp size at the window rather than the context. */
  swa?: { layers: number; window: number };
  kvHeads: number;
  headDim: number;
  hiddenSize: number;
  maxContext: number;
  visionEncoderGB: number;
  /**
   * Mean accepted draft length per forward pass when the GGUF carries an MTP head
   * (`*.nextn_predict_layers` >= 1) that Ollama 0.34 runs as speculative decoding: tokens
   * emitted per pass, so the bandwidth-bound estimate is multiplied by it. Conservative
   * (the low end of what the box measured), because acceptance varies with the text.
   */
  mtpAcceptedTokens?: number;
  quants: QuantSpec[];
  /** The ollama.com page whose GGUF metadata the architecture numbers were read from. */
  source: string;
}

export type Bucket = 'fast' | 'tight' | 'slow' | 'no';

export interface AdvisorInputs {
  vramBytes: number;
  vramFreeBytes: number;
  ramBytes: number;
  ramFreeBytes: number;
  /** What a stream copy reaches on this card: the worker's measurement, or the spec figure times STREAM_EFFICIENCY. */
  gpuBandwidthGBs: number;
  ramBandwidthGBs: number;
  /** null when no drive is known: every row then fits. */
  freeDiskBytes: number | null;
  contextTokens: number;
  models: ModelSpec[];
}

export interface AdvisorRow {
  model: ModelSpec;
  quant: QuantSpec;
  requiredBytes: number;
  headroomBytes: number;
  bucket: Bucket;
  tokPerSec: number;
  /** Only when the model spills into RAM: the speed after the cliff. */
  tokPerSecOffloaded?: number;
  /** The model's own window is shorter than the context asked for, so it cannot be the pick at this length. */
  contextCapped: boolean;
  /** Whether it would load right now, against free VRAM (and free RAM for a spilling row) rather than totals: another Strata app may hold a model. */
  fitsNow: boolean;
  downloadBytes: number;
  fitsOnDisk: boolean;
}

/**
 * Measured on the dev box on 2026-09-16 (docs/phase3-calibration.md): qwen3:4b q4_K_M decodes
 * 356 tok/s in Ollama against 716 at factor 1 on the worker's 1611 GB/s, so 0.50 replaces plan
 * section 10's 0.65 guess. One dense 4B model is all this box could time: a 30B-class dense
 * model pays proportionally less per token in launches and sampling, so its rows are likely
 * 15-25 % under, and no MoE row has been timed at all (the plan's three-model calibration is
 * still owed). The page's "Set factor from measurements" overrides it per box.
 */
export const CALIBRATION_FACTOR = 0.45;

/**
 * What the worker's stream copy reaches of the theoretical bus figure: 1611 GB/s against the
 * 2027 GB/s this box's 1979 MHz memory clock gives (docs/phase3-calibration.md). The factor
 * above is measured against the copy rate, so a card that has not been measured is estimated
 * at spec x this, not at the datasheet number.
 */
export const STREAM_EFFICIENCY = 0.8;

const GB = 1e9;
const GIB = 1024 ** 3;
const KV_BYTES = 2;
const CUDA_OVERHEAD = 0.6 * GB;
const DESKTOP_RESERVE = 1.0 * GB;
/** In the unit the page prints, so the rule it states ("tight below 1.5 GiB") is the one it applies. */
export const TIGHT_HEADROOM = 1.5 * GIB;
/** Spilling past this much of RAM leaves nothing for the desktop: the row says won't run. */
const RAM_USABLE = 0.8;

const BUCKET_ORDER: Record<Bucket, number> = { fast: 0, tight: 1, slow: 2, no: 3 };

/** What the offloaded share runs at when the kit is unknown (standalone page, or a board with no module rows). */
export const DEFAULT_RAM_BANDWIDTH_GBS = 80;

/** Peak RAM bandwidth: 8 bytes per transfer per channel, DDR4 and DDR5 alike. */
export function ramBandwidthGBs(configuredMts: number, channels: number): number {
  return (configuredMts * 8 * channels) / 1000;
}

/** From the snapshot's module rows: the configured speed, two or more DIMMs on a desktop board running dual channel. */
export function ramBandwidthFromModules(modules: RamModule[]): number {
  const mts = Math.max(0, ...modules.map((m) => m.configuredMts || 0));
  return mts ? ramBandwidthGBs(mts, modules.length >= 2 ? 2 : 1) : DEFAULT_RAM_BANDWIDTH_GBS;
}

/** The GGUF that loads, projector aside: the file is the truth, the parameter count only a floor for a rounded-down size. */
export function weightsBytes(m: ModelSpec, q: QuantSpec): number {
  return Math.max(q.downloadBytes - m.visionEncoderGB * GB, m.paramsB * GB * q.bytesPerWeight);
}

/** KV cache: GQA (kvHeads, not attention heads); full-attention blocks grow with the context, windowed blocks stop at the window. */
export function kvBytes(m: ModelSpec, contextTokens: number, kvBytesPerElem = KV_BYTES): number {
  const ctx = Math.min(contextTokens, m.maxContext);
  const positions = m.layers * ctx + (m.swa ? m.swa.layers * Math.min(ctx, m.swa.window) : 0);
  return 2 * m.kvHeads * m.headDim * kvBytesPerElem * positions;
}

/** Weights + KV cache + vision tower + the two reserves. */
export function requiredBytes(m: ModelSpec, q: QuantSpec, contextTokens: number, kvBytesPerElem = KV_BYTES): number {
  return weightsBytes(m, q) + kvBytes(m, contextTokens, kvBytesPerElem) + m.visionEncoderGB * GB + CUDA_OVERHEAD + DESKTOP_RESERVE;
}

/** Tokens emitted per forward pass: one, or the accepted draft length of an MTP model. */
const tokensPerPass = (m: ModelSpec) => m.mtpAcceptedTokens ?? 1;

/** Bytes a forward pass streams, on the plan's per-weight table: the factor was fitted against this, not the file size. */
const pacedBytes = (m: ModelSpec, q: QuantSpec) => m.activeParamsB * GB * q.bytesPerWeight;

/** Bandwidth-bound decode: every active weight crosses the bus once per forward pass, which emits one token unless MTP drafts more. */
export function tokPerSec(m: ModelSpec, q: QuantSpec, bandwidthGBs: number, factor = CALIBRATION_FACTOR): number {
  return ((bandwidthGBs * GB) / pacedBytes(m, q)) * factor * tokensPerPass(m);
}

/**
 * After the cliff: the share of the file that no longer fits streams from RAM, and the paced
 * bytes split in that proportion, so the figure meets tokPerSec exactly as the spill goes to
 * zero.
 */
export function tokPerSecOffloaded(m: ModelSpec, q: QuantSpec, spilledBytes: number, gpuBandwidthGBs: number, ramBandwidthGBs: number, factor = CALIBRATION_FACTOR): number {
  const spilled = Math.min(1, spilledBytes / weightsBytes(m, q));
  const seconds = (pacedBytes(m, q) / GB) * ((1 - spilled) / gpuBandwidthGBs + spilled / ramBandwidthGBs);
  return (factor * tokensPerPass(m)) / seconds;
}

function row(m: ModelSpec, q: QuantSpec, i: AdvisorInputs): AdvisorRow {
  const required = requiredBytes(m, q, i.contextTokens);
  const headroomBytes = i.vramBytes - required;
  const bucket: Bucket =
    headroomBytes >= TIGHT_HEADROOM ? 'fast' : headroomBytes >= 0 ? 'tight' : required <= i.vramBytes + i.ramBytes * RAM_USABLE ? 'slow' : 'no';
  const fitsNow = bucket === 'no' ? false : bucket === 'slow' ? required <= i.vramFreeBytes + i.ramFreeBytes * RAM_USABLE : required <= i.vramFreeBytes;

  return {
    model: m,
    quant: q,
    requiredBytes: required,
    headroomBytes,
    bucket,
    tokPerSec: tokPerSec(m, q, i.gpuBandwidthGBs),
    tokPerSecOffloaded: bucket === 'slow' ? tokPerSecOffloaded(m, q, -headroomBytes, i.gpuBandwidthGBs, i.ramBandwidthGBs) : undefined,
    contextCapped: m.maxContext < i.contextTokens,
    fitsNow,
    downloadBytes: q.downloadBytes,
    fitsOnDisk: i.freeDiskBytes === null || q.downloadBytes <= i.freeDiskBytes
  };
}

/** Every quant of every model: the largest model that still runs fast first, then tight, slow, won't run; ties by tok/s. A 30B-A3B is a 30B here. */
export function advise(inputs: AdvisorInputs): AdvisorRow[] {
  return inputs.models
    .flatMap((m) => m.quants.map((q) => row(m, q, inputs)))
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.model.paramsB - a.model.paramsB || b.tokPerSec - a.tokPerSec);
}

/** The first fast row carrying the tag whose window covers the context: advise() already put the largest first. */
export function bestFor(rows: AdvisorRow[], tag: string): AdvisorRow | null {
  return rows.find((r) => r.bucket === 'fast' && !r.contextCapped && r.model.tags.includes(tag)) ?? null;
}

/**
 * Median of measured ÷ estimated-at-factor-1 over the calibrated models; null with nothing
 * measured. MTP models are left out rather than divided by their multiplier: the accepted
 * draft length moves run to run with the text (2.4–3.4 on the dev box), so their ratio is
 * not a decode-efficiency figure (docs/phase3-calibration.md).
 */
export function factorFrom(measurements: { model: ModelSpec; quant: QuantSpec; measuredTokS: number }[], bandwidthGBs: number): number | null {
  const ratios = measurements
    .filter((m) => m.measuredTokS > 0 && m.model.mtpAcceptedTokens === undefined)
    .map((m) => m.measuredTokS / tokPerSec(m.model, m.quant, bandwidthGBs, 1))
    .sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  const mid = ratios.length >> 1;
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}
