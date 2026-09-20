import gpus from '../data/gpus.json';
import cpus from '../data/cpus.json';
import appleGpus from '../data/apple-gpus.json';

/**
 * Spec-sheet rows for the advisor (master plan section 10): NVML gives VRAM but
 * not bandwidth or tensor throughput, so those come from gpus.json keyed by a
 * name regex. Every figure here is a "spec", never a measurement, and every row
 * carries the vendor page or whitepaper it was read from. A field the vendor
 * does not publish is null, never a guess (plan risk R5).
 */
export type TensorPrecision = 'fp16' | 'bf16' | 'tf32' | 'fp8' | 'int8' | 'fp4' | 'int4';

/** The vendor's headline figure exactly as advertised (plan section 10); `sparse` is null when the page gives no dense/sparse qualifier (Intel Ark). */
export interface AdvertisedTops {
  value: number;
  precision: TensorPrecision;
  sparse: boolean | null;
  source: string;
}

export interface GpuSpec {
  name: string;
  vendor: 'NVIDIA' | 'AMD' | 'Intel' | 'Apple';
  /** Case-insensitive, tested against GpuFacts.name; variants that share a name (4060 Ti 16/8 GB) are told apart by VRAM. */
  pattern: string;
  vramGiB: number;
  /** null when neither the vendor nor TechPowerUp publishes a figure: the page then shows "could not determine" and tok/s waits for a measurement. */
  bandwidthGBs: number | null;
  boostMhz: number;
  /** TGP (NVIDIA), Typical Board Power (AMD) or TBP (Intel); on a laptop part the top of the TGP range. */
  tdpW: number;
  /** Laptop parts only (plan 17d row 2): the TGP range the laptop maker chooses from, as NVIDIA's laptop compare page lists it. */
  tgpRangeW?: [number, number];
  /** Dense TOPS (TFLOPS for the float formats) per precision; `sparse` the 2:1 structured-sparsity figure where the vendor quotes one. */
  tops: Partial<Record<TensorPrecision, number>> & { sparse: Partial<Record<TensorPrecision, number>> };
  /** The vendor published only the sparse headline and the dense figures here are half of it, so the card tags them derived rather than spec. */
  denseDerived: boolean;
  /** null when the vendor advertises no AI TOPS headline (RTX 30 series, RDNA 3): the card leads with its largest published figure instead. */
  advertisedAiTops: AdvertisedTops | null;
  /** null when the vendor page prints no base clock (AMD gives a game clock instead). */
  baseMhz: number | null;
  /** Shader FP32: the vendor's figure where one is printed (AMD), else shading units x 2 x boost clock, the convention the NVIDIA whitepapers and TechPowerUp use. */
  fp32Tflops: number;
  /** NVIDIA's "required system power", AMD's "minimum PSU recommendation", Intel's "minimum power supply unit"; null when the page has none. */
  suggestedPsuW: number | null;
  /** Spec tiles (plan section 10): the TechPowerUp GPU-database page cited by `tpuUrl` is where these were read. */
  die: string;
  shadingUnits: number;
  tmus: number;
  rops: number;
  vramType: string;
  busBits: number;
  /** Effective memory data rate; bandwidth = memoryGbps x busBits / 8. */
  memoryGbps: number;
  /** The memory clock as GPU-Z, GPU Tweak and the cited page print it (1750 MHz on the 5090); null when the cited page's figure would contradict memoryGbps. */
  memoryClockMhz: number | null;
  tpuUrl: string;
  notes: string;
  source: string;
  /**
   * An Apple Silicon GPU (apple-gpus.json): one memory pool, so vramGiB, boostMhz and
   * fp32Tflops are 0 here and filled from the machine (the Metal working set, the top of the
   * GPU's clock table) by rows.ts gpuSpecOf; tdpW is 0 because Apple publishes none.
   */
  unified?: boolean;
  neuralEngineCores?: number;
}

/**
 * Apple Silicon rows (src/data/apple-gpus.json). Apple publishes GPU and Neural Engine core
 * counts and the memory bandwidth, never clocks, power or tensor figures; the unit counts
 * follow the per-core rule the review sites list (128 ALUs, 8 TMUs, 4 ROPs per core), cited
 * per row. The name carries the core count because two M5 Max parts share a chip name.
 */
export interface AppleGpuSpec {
  name: string;
  pattern: string;
  die: string;
  gpuCores: number;
  shadingUnits: number;
  tmus: number;
  rops: number;
  bandwidthGBs: number;
  memoryGbps: number;
  busBits: number;
  vramType: string;
  neuralEngineCores: number;
  source: string;
  unitsSource: string;
  notes: string;
}

export const APPLE_GPU_SPECS: AppleGpuSpec[] = appleGpus as AppleGpuSpec[];

const APPLE_ROWS = APPLE_GPU_SPECS.map((spec) => ({ spec, regex: new RegExp(spec.pattern, 'i') }));

function appleSpec(a: AppleGpuSpec): GpuSpec {
  return {
    name: a.name,
    vendor: 'Apple',
    pattern: a.pattern,
    vramGiB: 0,
    bandwidthGBs: a.bandwidthGBs,
    boostMhz: 0,
    tdpW: 0,
    tops: { sparse: {} },
    denseDerived: false,
    advertisedAiTops: null,
    baseMhz: null,
    fp32Tflops: 0,
    suggestedPsuW: null,
    die: a.die,
    shadingUnits: a.shadingUnits,
    tmus: a.tmus,
    rops: a.rops,
    vramType: a.vramType,
    busBits: a.busBits,
    memoryGbps: a.memoryGbps,
    memoryClockMhz: null,
    tpuUrl: a.unitsSource,
    notes: a.notes,
    source: a.source,
    unified: true,
    neuralEngineCores: a.neuralEngineCores
  };
}

export interface CpuSpec {
  /** The token the name was matched on, e.g. "9950X" or "Ultra 7 258V". */
  model: string;
  cores: number;
  threads: number;
  boostMhz: number;
  /** AMD's default TDP or Intel's processor base power; the socket ceiling (PPT / PL2) lives in the Monitor's cpuLimits. */
  tdpW: number;
  /** Ryzen AI / Core Ultra NPU throughput as the vendor states it; null on parts without an NPU. */
  npuTops: number | null;
  source: string;
}

/** cpus.json rows carry the Monitor's limits too; only rows with the advisor's fields are specs here. */
interface CpuRow {
  models: string[];
  boostMhz: number;
  cores?: number;
  threads?: number;
  tdpW?: number;
  npuTops?: number | null;
  source?: string;
}

export const GPU_SPECS: GpuSpec[] = gpus as GpuSpec[];

const GPU_ROWS = GPU_SPECS.map((spec) => ({ spec, regex: new RegExp(spec.pattern, 'i') }));

/** Laptop parts share desktop names with different memory and power: a mobile name matches only a Laptop row, a desktop name never does. */
const MOBILE = /laptop|mobile|max-q/i;

/** A card's NVML total is a little under its nominal size (32607 MiB on a 32 GiB 5090); a variant off by more than this is a different card. */
const VRAM_TOLERANCE = 0.1;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The row for a GPU name as NVML, DXGI or the picker spells it. The picker's exact
 * row name wins; otherwise the regex, and when several rows share one (memory
 * variants) the VRAM total picks the row or, without one, the first listed.
 */
export function lookupGpu(name: string, vramMiB?: number): GpuSpec | null {
  const exact = GPU_SPECS.find((g) => g.name.toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact;
  // Apple rows match on chip name and core count; the VRAM rule below is for cards, not a shared pool.
  const apple = APPLE_ROWS.find((r) => r.regex.test(name));
  if (apple) return appleSpec(apple.spec);
  const mobile = MOBILE.test(name);
  const hits = GPU_ROWS.filter((r) => MOBILE.test(r.spec.name) === mobile && r.regex.test(name)).map((r) => r.spec);
  if (hits.length === 0) return null;
  if (vramMiB === undefined) return hits[0];
  const vramGiB = vramMiB / 1024;
  const closest = hits.reduce((best, g) => (Math.abs(g.vramGiB - vramGiB) < Math.abs(best.vramGiB - vramGiB) ? g : best));
  return Math.abs(closest.vramGiB - vramGiB) <= closest.vramGiB * VRAM_TOLERANCE ? closest : null;
}

// One regex per model token on word boundaries, the same rule as the Monitor's cpuLimits:
// "9950X" must not match "9950X3D".
const CPU_ROWS = (cpus as CpuRow[]).flatMap((row) => row.models.map((model) => ({ row, model, regex: new RegExp(`\\b${escape(model)}\\b`, 'i') })));

/** The advisor's spec for the part the WMI name identifies; null when no row matches or the row has only Monitor limits. */
export function lookupCpu(name: string): CpuSpec | null {
  const hit = CPU_ROWS.find((r) => r.regex.test(name));
  if (!hit) return null;
  const { row, model } = hit;
  if (row.cores === undefined || row.threads === undefined || row.tdpW === undefined || row.source === undefined) return null;
  return { model, cores: row.cores, threads: row.threads, boostMhz: row.boostMhz, tdpW: row.tdpW, npuTops: row.npuTops ?? null, source: row.source };
}
