import React, { useEffect, useState } from 'react';
import { Gauge, Square } from 'lucide-react';
import type { GpuBench } from '../../api';
import { STREAM_EFFICIENCY } from '../../analysis/advisor';
import { openExternal } from '../../support';
import { useSettings } from '../useSettings';
import { Card } from './Card';
import { PsuForm, psuOf } from './PsuForm';
import { Stat, Tag, type Provenance } from './Tag';
import { percent, tops } from './format';
import { PRECISIONS, type GpuSpecView, type Precision } from './rows';
import { MEM_GBPS_PER_MHZ, NVML_MEM_RATE_FACTOR, memClockMhzOf, memGbpsOf, type HeldClocks, type ThisCard } from './thisCard';

/** The worker's 3 s sweep plus the matmul runs, measured at under 4 s on the dev box; the bar only paces expectation, the result ends it. */
const MEASURE_EXPECTED_S = 5;
/** A held memory clock this far under the card's record is a tune no longer applied (the vendor tool closed), not measurement noise. */
const RECORD_TOLERANCE = 0.98;

interface Props {
  gpuName: string;
  gpuColour: string;
  spec: GpuSpecView | null;
  /** The driver's word on the card in the slot; null standalone, when only the reference row exists. */
  card: ThisCard | null;
  /** No discrete GPU (plan 17d row 1): the card explains CPU-only inference from the RAM bus instead of a GPU spec. */
  integrated?: boolean;
  /** Plan 17d: a laptop has no PSU to set, so the PSU tile is not drawn (the Monitor's battery line stands where the PSU question would be). */
  laptop?: boolean;
  /** The RAM bus figure the CPU-only estimate runs on (the header shows the same). */
  ramBandwidthGBs?: number;
  /** The most recent clocks seen under load, against the record `card` carries (useHeldClocks). */
  latest: HeldClocks | null;
  npuTops: number | null;
  /** The cached or fresh bench, whether or not it was taken on this GPU; `applies` says which. */
  bench: GpuBench | null;
  applies: boolean;
  measuring: boolean;
  canMeasure: boolean;
  error: string;
  /** The last Measure was stopped (plan section 17c): said in one muted line, the earlier figures standing. */
  stopped?: boolean;
  onMeasure: () => void;
  onStop?: () => void;
}

const LABEL: Record<Precision, string> = { fp4: 'FP4', fp8: 'FP8', int8: 'INT8', int4: 'INT4', fp16: 'FP16', bf16: 'BF16', tf32: 'TF32' };
const unitOf = (p: Precision) => (p.startsWith('int') ? 'TOPS' : 'TFLOPS');
/** Vendor style for the one number people arrive with: "3,352". */
const grouped = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 1 });
const gbps = (v: number) => `${v.toFixed(1)} Gbps`;
const gb = (v: number) => `${v.toFixed(0)} GB/s`;
/**
 * The offset a memory tune reads as, in both conventions people meet (plan section 10, the
 * MEMORY CLOCK tile): GPU-Z's clock (NVML ÷ 8 on GDDR7 / GDDR6X, ÷ 4 on GDDR6) and the GPU
 * Tweak / Afterburner slider, which counts the effective rate; sign-aware, "at reference" when
 * there is none. On the dev box 2001 − 1750 = +251 MHz in GPU-Z's clock is about +4016 on the slider.
 */
const offsetMhz = (mhz: number, reference: number, gbpsPerMhz: number) => {
  if (mhz === reference) return 'at reference';
  const gpuz = mhz - reference;
  const slider = Math.round(gpuz * gbpsPerMhz * NVML_MEM_RATE_FACTOR / 2);
  return `${gpuz > 0 ? '+' : '−'}${Math.abs(gpuz)} MHz in GPU-Z's clock (${gpuz > 0 ? '+' : '−'}${Math.abs(slider)} on the GPU Tweak slider)`;
};

/** What the card says instead of a spec when the GPU has no reference row or the machine has no discrete GPU: user words, never a file to edit. */
export function noSpecText(integrated: boolean, ramBandwidthGBs: number | undefined, hasDriverBandwidth: boolean): string {
  if (integrated) {
    return `No discrete GPU: models run on the CPU from RAM${ramBandwidthGBs ? `, paced by the RAM bus at about ${ramBandwidthGBs.toFixed(0)} GB/s (dual-channel DDR5 puts a 4B model at a few tokens a second)` : ''}. A discrete GPU is what changes this.`;
  }
  return `No reference figures for this GPU yet; the estimates use ${hasDriverBandwidth ? "the driver's own bandwidth (the memory clock the card holds times its bus width)" : 'a measurement (press Measure) once one exists'}.`;
}

/** One provenance tag on the title when every figure in the section shares it, so the narrow stats stay on one line. */
const Section: React.FC<{ title: string; tag?: Provenance; tagTitle?: string; children: React.ReactNode }> = ({ title, tag, tagTitle, children }) => (
  <div className="space-y-2 min-w-0">
    <h3 className="label text-studio-subtle flex items-center gap-1.5">
      {title}
      {tag && <Tag kind={tag} title={tagTitle} />}
    </h3>
    {children}
  </div>
);

/** The pacing bar with its Stop beside it from the first second (plan section 17c). */
const Progress: React.FC<{ onStop?: () => void }> = ({ onStop }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(id);
  }, []);
  const pct = Math.min(elapsed / MEASURE_EXPECTED_S, 0.95) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 text-[10px] text-studio-subtle">
        <span>Bandwidth sweep, then matmul…</span>
        <span className="flex-1" />
        <span className="figure whitespace-nowrap">
          {elapsed.toFixed(0)} / ~{MEASURE_EXPECTED_S} s
        </span>
        {onStop && (
          <button className="btn h-6 bg-rose-500/15 text-rose-300 hover:text-rose-200" onClick={onStop} title="Kills the worker mid-sweep (Escape)">
            <Square size={12} /> Stop
          </button>
        )}
      </div>
      <div className="relative h-1.5 rounded-full bg-studio-border">
        <div className="absolute inset-y-0 left-0 rounded-full bg-studio-accent transition-[width] duration-200 ease-linear" style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
    </div>
  );
};

/** The vendor's headline, or when it advertises none the largest figure it does print. */
function headline(spec: GpuSpecView): { value: number; precision: Precision; sparse: boolean | null; advertised: boolean } | null {
  if (spec.advertised) return { ...spec.advertised, advertised: true };
  let best: { value: number; precision: Precision; sparse: boolean } | null = null;
  for (const p of PRECISIONS) {
    for (const [table, sparse] of [[spec.sparse, true], [spec.tops, false]] as const) {
      const v = table[p];
      if (v !== undefined && (!best || v > best.value)) best = { value: v, precision: p, sparse };
    }
  }
  return best && { ...best, advertised: false };
}

/**
 * Plan section 10: tensor and shader peaks scale with the SM clock at a fixed unit count, so
 * this card's figure is the reference peak x (the clock it holds under load / the reference
 * boost), and by the shader ratio too when NVAPI counts fewer than the reference. Null when
 * no held clock is known: the driver's ceiling is the VF-curve top, never the headline. Null
 * too while the only clock seen is below the reference boost (polish 3 item 8: the seen clock
 * when it beats the boost, else the advertised figure): a memory-bound stream copy holds the
 * SM at 1192 MHz on the dev box, which says nothing about what a compute load would get.
 */
function ownScale(spec: GpuSpecView, card: ThisCard | null): { factor: number; mhz: number; unitRatio: number } | null {
  if (card?.seenSmMhz == null || card.seenSmMhz < spec.tiles.boostMhz) return null;
  const shaders = card.units?.shaders;
  const unitRatio = shaders != null && shaders < spec.tiles.shadingUnits ? shaders / spec.tiles.shadingUnits : 1;
  return { factor: (card.seenSmMhz / spec.tiles.boostMhz) * unitRatio, mhz: card.seenSmMhz, unitRatio };
}

interface TileProps {
  label: string;
  /** The primary figure, or a control (the PSU form) where the figure is the user's to give. */
  value: React.ReactNode;
  /** Set when the figure is this card's or the user's: the reference then goes to `sub`, muted. */
  tag?: Provenance;
  sub?: string;
  title?: string;
  className?: string;
}

/**
 * A spec tile: the primary figure large, the reference design demoted beneath it once a live
 * or user figure exists (plan section 10). The provenance rides in the label as text, not a
 * chip, because the tiles are 150 px wide and a chip beside "bandwidth" would not fit. The
 * label may break before the provenance ("BANDWIDTH" over "· THIS CARD"): a tile is narrow
 * and no text is ever clipped (plan section 17a).
 */
const Tile: React.FC<TileProps> = ({ label, value, tag, sub, title, className = '' }) => (
  <div className={`min-w-0 px-2 py-1 rounded border border-studio-border bg-studio-surface ${className}`} title={title}>
    <div className="label text-[9px] leading-tight">
      {label}
      {tag && (
        <>
          {' '}
          <span className="text-slate-300 whitespace-nowrap">· {tag}</span>
        </>
      )}
    </div>
    <div className="figure text-mini text-studio-text">{value}</div>
    {sub && <div className="text-[9px] text-studio-subtle leading-tight">{sub}</div>}
  </div>
);

const Link: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <button className="underline decoration-dotted underline-offset-2 hover:text-studio-text" onClick={() => openExternal(href)} title={href}>
    {children}
  </button>
);

/**
 * Plan section 10, the AI stats card: this card's own headline first with the advertised
 * figure beneath, then the spec tiles with this card's figures leading and the reference
 * design demoted, dense/sparse compute pairs at the clock this card holds, bandwidth as
 * reference · this card · measured, and the worker's matmul beside the shader figure.
 */
export const StatsCard: React.FC<Props> = (p) => {
  const psuSet = psuOf(useSettings()) !== null;
  const measured = p.applies ? p.bench : null;
  const t = p.spec?.tiles;
  const c = p.card;
  const specBandwidth = p.spec?.bandwidthGBs ?? null;
  const cardBandwidth = c?.bandwidthGBs ?? null;
  const busBits = t?.busBits ?? null;
  const toGBs = (memMhz: number) => (busBits ? (memGbpsOf(memMhz) * busBits) / 8 : null);
  // A measurement is judged against the ceiling in force when it was taken: the clock the sweep held, else this card's, else the table.
  const runBandwidth = measured?.heldMemMhz ? toGBs(measured.heldMemMhz) : null;
  const ceiling = runBandwidth ?? cardBandwidth ?? specBandwidth;
  const ceilingName = runBandwidth !== null ? 'the clock held for this run' : cardBandwidth !== null ? "this card's ceiling" : 'reference spec';
  const expectedCopy = ceiling !== null ? ceiling * STREAM_EFFICIENCY : null;
  const gap = measured && ceiling !== null ? ((measured.bandwidthGBs - ceiling) / ceiling) * 100 : null;
  const gapVsCopy = measured && expectedCopy !== null ? ((measured.bandwidthGBs - expectedCopy) / expectedCopy) * 100 : null;
  const when = (b: GpuBench) => `${b.device}${b.driver ? `, driver ${b.driver}` : ''}, ${new Date(b.measuredAt).toLocaleDateString()}`;
  // The record against the last load seen, or the run's clock: a tune that came off the card (the vendor tool closed) is said once, in one line.
  const recordGbps = c?.memSource === 'held' ? c.memGbps : null;
  const below = (memMhz: number | null | undefined) => (recordGbps !== null && memMhz ? memGbpsOf(memMhz) < recordGbps * RECORD_TOLERANCE : false);
  const notApplied =
    recordGbps === null
      ? null
      : below(p.latest?.memMhz)
        ? `Earlier this card held ${gbps(recordGbps)}${cardBandwidth !== null ? ` (${gb(cardBandwidth)})` : ''}; the last load seen held ${gbps(memGbpsOf(p.latest!.memMhz))} — the memory offset is not applied now (vendor tool closed?).`
        : below(measured?.heldMemMhz)
          ? `Earlier this card held ${gbps(recordGbps)}${cardBandwidth !== null ? ` (${gb(cardBandwidth)})` : ''}; this run held ${gbps(memGbpsOf(measured!.heldMemMhz!))} — the memory offset was not applied then (vendor tool closed?).`
          : null;
  // The MEMORY CLOCK tile in the GPU-Z convention beside the Gbps one (plan section 10); null skips it for a memory type without a rule.
  const memClockMhz = c?.memMhz != null && t ? memClockMhzOf(c.memMhz, t.vramType) : null;
  const precisions = PRECISIONS.filter((x) => p.spec?.tops[x] !== undefined || p.spec?.sparse[x] !== undefined);
  const lead = p.spec ? headline(p.spec) : null;
  const scale = p.spec ? ownScale(p.spec, c) : null;
  const own = (v: number) => (scale ? v * scale.factor : v);
  const ownTag: Provenance = scale ? 'this card' : 'spec';
  const ownTitle = scale
    ? `The reference figure scaled by ${scale.mhz} MHz held under load / the ${t!.boostMhz} MHz reference boost${scale.unitRatio < 1 ? ` and by the ${grouped(scale.unitRatio * t!.shadingUnits)} of ${grouped(t!.shadingUnits)} shaders NVAPI counts` : ''}: an estimate at this card's clock, not a benchmark`
    : 'The reference design figure; a held clock scales it to this card';
  const denseKind: Provenance = scale ? 'this card' : p.spec?.denseDerived ? 'derived' : 'spec';
  const cardVsRef = cardBandwidth !== null && specBandwidth !== null ? Math.round(((cardBandwidth - specBandwidth) / specBandwidth) * 100) : 0;

  return (
    <Card
      title="AI stats"
      aside={
        <span className="text-mini font-semibold truncate" style={{ color: p.gpuColour }} title={p.gpuName}>
          {p.gpuName}
        </span>
      }
    >
      {p.spec && t ? (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2 flex-wrap min-w-0">
            {lead ? (
              <>
                <span className="figure text-2xl leading-7 text-studio-text">{grouped(own(lead.value))}</span>
                <span className="text-mini text-studio-muted">{lead.advertised ? 'AI TOPS' : unitOf(lead.precision)}</span>
                <span className="label">
                  {LABEL[lead.precision]} · {lead.sparse === null ? 'no sparsity qualifier' : lead.sparse ? 'sparse' : 'dense'}
                </span>
                <Tag kind={ownTag} title={scale ? ownTitle : lead.advertised ? `As advertised: ${p.spec.advertised!.source}` : `The vendor advertises no AI TOPS headline; this is its largest published figure (${p.spec.source})`} />
                {scale && <span className="text-[10px] text-studio-subtle">at {scale.mhz} MHz held under load</span>}
                {!lead.advertised && <span className="text-[10px] text-studio-subtle">no advertised AI TOPS; largest published figure</span>}
              </>
            ) : measured?.matmulTopsInt8 != null ? (
              <>
                <span className="figure text-2xl leading-7 text-studio-text">{tops(measured.matmulTopsInt8)}</span>
                <span className="text-mini text-studio-muted">AI TOPS</span>
                <span className="label">int8 · dense · measured on this GPU</span>
                <Tag kind="measured" title={`The GPU's matrix path (Metal 4 tensor ops) at int8 with int32 accumulate, a ${measured.matmulN ?? 4096}² matmul on this machine, ${when(measured)}. ${p.spec.vendor} advertises no TOPS figure; a PC's headline is its vendor's peak, often at fp4 with sparsity, so compare precision for precision.`} />
                <span className="text-[10px] text-studio-subtle">no vendor figure; measured, dense int8</span>
              </>
            ) : measured?.matmulTflopsFp16 != null ? (
              <>
                <span className="figure text-2xl leading-7 text-studio-text">{tops(measured.matmulTflopsFp16)}</span>
                <span className="text-mini text-studio-muted">AI TOPS</span>
                <span className="label">fp16 · dense · measured on this GPU</span>
                <Tag kind="measured" title={`The worker's ${measured.matmulN ?? 4096}² half-precision matmul on this machine, ${when(measured)}; ${p.spec.vendor} publishes no tensor or TOPS figure`} />
                <span className="text-[10px] text-studio-subtle">no vendor figure; a measurement stands in</span>
              </>
            ) : (
              <span className="text-mini text-studio-muted">{p.spec.unified ? 'Apple publishes no tensor or TOPS figure; press Measure for this GPU\'s own.' : 'No tensor figure published for this GPU.'}</span>
            )}
          </div>
          {lead && scale && (
            <div className="text-[10px] text-studio-subtle">
              {p.spec.vendor} {lead.advertised ? 'advertises' : 'publishes'} <span className="figure">{grouped(lead.value)}</span> at the {t.boostMhz} MHz reference boost <Tag kind="spec" />
            </div>
          )}
          <div className="text-mini text-studio-muted figure">
            {t.die} · {p.spec.vramGiB} GB {t.vramType} · {t.busBits}-bit · {cardBandwidth !== null ? gb(cardBandwidth) : specBandwidth !== null ? gb(specBandwidth) : 'bandwidth unknown'}
            {cardBandwidth !== null && specBandwidth !== null && gb(cardBandwidth) !== gb(specBandwidth) && <span className="text-studio-subtle"> (reference {gb(specBandwidth)})</span>}
          </div>
          <div className="grid gap-1.5 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
            <Tile label="die" value={t.die} />
            {c?.units?.shaders != null ? (
              <Tile label="shaders" value={grouped(c.units.shaders)} tag="this card" sub={`reference ${grouped(t.shadingUnits)}`} title="Shading units as NVAPI counts them on this card" />
            ) : (
              <Tile label="shaders" value={grouped(t.shadingUnits)} />
            )}
            {c?.units?.tmus != null ? (
              <Tile label="TMUs" value={String(c.units.tmus)} tag="this card" sub={`reference ${t.tmus}`} title="SM count from NVAPI times the architecture's texture units per SM" />
            ) : (
              <Tile label="TMUs" value={String(t.tmus)} />
            )}
            {c?.units?.rops != null ? (
              <Tile label="ROPs" value={String(c.units.rops)} tag="this card" sub={`reference ${t.rops}`} title="ROPs as NVAPI counts them on this card; fewer than the reference is the audit's missing-ROPs finding" />
            ) : (
              <Tile label="ROPs" value={String(t.rops)} />
            )}
            <Tile label={p.spec.unified ? 'GPU working set' : 'VRAM'} value={`${p.spec.vramGiB} GB`} sub={p.spec.unified ? `${t.vramType} · unified, what Metal lets the GPU hold` : t.vramType} />
            <Tile label="bus" value={`${t.busBits}-bit`} />
            {c ? (
              <Tile
                label="boost"
                value={c.seenSmMhz !== null ? `${c.seenSmMhz} MHz` : 'run a load to measure'}
                tag="this card"
                sub={`${c.seenSmMhz !== null ? (c.seenSmMhz < t.boostMhz ? 'held in a memory-bound run; a compute load shows the boost · ' : 'held under load · ') : ''}reference ${t.baseMhz !== null ? `${t.baseMhz} / ` : ''}${t.boostMhz}${c.ceilingSmMhz !== null ? ` · driver ceiling ${c.ceilingSmMhz}` : ''}`}
                title={`${c.seenSmMhz !== null ? `The highest SM clock this card has held under load; Measure, Calibrate or a game shows it.${c.seenSmMhz < t.boostMhz ? ' Below the reference boost it came from a memory-bound run (a stream copy holds the SM clock low) or a ramp, not from compute; the figures above keep the advertised clock until a compute load is seen.' : ''}` : 'The SM clock this card holds under load shows after Measure, Calibrate or a game.'} Reference design base / boost beneath${c.ceilingSmMhz !== null ? ", then the driver's VF-curve top, which every card of this model reports and no card runs at" : ''}.`}
              />
            ) : (
              <Tile
                label={t.baseMhz !== null ? 'base / boost' : 'boost'}
                value={t.baseMhz !== null ? `${t.baseMhz}/${t.boostMhz}` : t.boostMhz > 0 ? `${t.boostMhz}` : 'not published'}
                tag={p.spec.unified && t.boostMhz > 0 ? 'this card' : undefined}
                sub={p.spec.unified ? "top of the GPU's clock table as macOS reports it" : undefined}
                title={p.spec.unified ? 'Apple publishes no GPU clock; this is the highest state in the clock table the OS reports for this chip' : t.baseMhz === null ? 'The vendor page prints no base clock' : 'MHz, reference design'}
              />
            )}
            {c?.memGbps != null ? (
              <Tile
                label="memory"
                value={gbps(c.memGbps)}
                tag="this card"
                sub={`reference ${t.memoryGbps} Gbps`}
                title={c.memSource === 'held' ? 'From the memory clock this card holds under load: a tune above the driver ceiling' : "The driver's memory clock ceiling plus any offset in force; measure to see the clock the card holds under load"}
              />
            ) : (
              <Tile label="memory" value={`${t.memoryGbps} Gbps`} />
            )}
            {memClockMhz !== null ? (
              <Tile
                label="memory clock"
                value={`${memClockMhz} MHz`}
                tag="this card"
                sub={t.memoryClockMhz !== null ? `reference ${t.memoryClockMhz} MHz · ${offsetMhz(memClockMhz, t.memoryClockMhz, MEM_GBPS_PER_MHZ[t.vramType])}` : 'no reference clock in the table'}
                title={`${c!.memSource === 'held' ? 'The memory clock this card holds under load' : "The driver's memory clock ceiling plus any offset in force; measure to see the clock the card holds under load"}, in the MHz GPU-Z and GPU Tweak print (NVML's figure ÷ ${MEM_GBPS_PER_MHZ[t.vramType] / NVML_MEM_RATE_FACTOR} for ${t.vramType}); the reference clock and the offset a tune reads as beneath`}
              />
            ) : (
              !c && t.memoryClockMhz !== null && <Tile label="memory clock" value={`${t.memoryClockMhz} MHz`} title="Reference design memory clock as GPU-Z and GPU Tweak print it" />
            )}
            {cardBandwidth !== null ? (
              <Tile label="bandwidth" value={gb(cardBandwidth)} tag="this card" sub={specBandwidth !== null ? `reference ${gb(specBandwidth)}` : 'no reference figure'} title="Memory data rate x bus width / 8, from this card's own clock" />
            ) : (
              <Tile label="bandwidth" value={specBandwidth !== null ? gb(specBandwidth) : 'no figure'} />
            )}
            {c?.tdpW != null ? (
              <Tile
                label={t.tgpRangeW ? 'TGP' : 'TDP'}
                value={`${c.tdpW.toFixed(0)} W`}
                tag="this card"
                sub={`${c.limitW !== null && c.limitW < c.tdpW ? `set to ${c.limitW.toFixed(0)} W now · ` : ''}${c.sliderMaxW !== null ? `${t.tgpRangeW ? 'Dynamic Boost' : 'slider'} up to ${c.sliderMaxW.toFixed(0)} W · ` : ''}${t.tgpRangeW ? `laptop makers set ${t.tgpRangeW[0]}–${t.tgpRangeW[1]} W` : `reference ${t.tdpW} W`}`}
                title={t.tgpRangeW ? 'The TGP this laptop runs the card at, as the driver reports it; Dynamic Boost can add to it, and the range laptop makers choose from is beneath.' : "The board's default power limit as the driver reports it: what this card is built for. The slider's top when it goes higher, and the reference design's TDP, beneath."}
              />
            ) : t.tdpW > 0 ? (
              <Tile label={t.tgpRangeW ? 'TGP' : 'TDP'} value={t.tgpRangeW ? `${t.tgpRangeW[0]}–${t.tgpRangeW[1]} W` : `${t.tdpW} W`} title={t.tgpRangeW ? 'The TGP range laptop makers choose from; the driver reports the one this laptop runs at' : undefined} />
            ) : (
              <Tile label="TDP" value="not published" sub="Apple prints no power figure; the Monitor shows what it draws" />
            )}
            {!p.laptop && !p.spec.unified && (
              <Tile
                label="PSU"
                tag={psuSet ? 'you' : undefined}
                className="col-span-2"
                value={<PsuForm />}
                sub={t.suggestedPsuW !== null ? `reference suggests ≥ ${t.suggestedPsuW} W` : 'no vendor suggestion'}
                title={t.suggestedPsuW === null ? 'The vendor page prints no PSU recommendation' : 'Your supply, as you set it; the vendor’s system recommendation for the reference card beneath'}
              />
            )}
          </div>
          <div className="text-[10px] text-studio-subtle flex flex-wrap gap-x-3">
            {c && (
              <span>
                <Tag kind="this card" /> from the driver: power limit, clock ceilings, clocks held under load.
              </span>
            )}
            {p.spec.unified ? (
              <span>
                Apple's figures <Tag kind="spec" />: <Link href={p.spec.source}>tech specs</Link>; unit counts by the per-core rule the review sites list: <Link href={p.spec.unitsUrl}>listing</Link>. Clock and FP32 are this Mac's own.
              </span>
            ) : (
              <span>
                Reference design figures <Tag kind="spec" />: <Link href={p.spec.source}>vendor page</Link>. A board-partner card runs above them.
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="text-mini text-studio-muted">{noSpecText(!!p.integrated, p.ramBandwidthGBs, cardBandwidth !== null)}</p>
      )}

      <div className="grid gap-x-6 gap-y-4 grid-cols-1 md:grid-cols-[1.2fr_1.4fr_1fr] pt-2">
        <Section
          title="Tensor throughput, dense / sparse"
          tag={p.spec ? denseKind : undefined}
          tagTitle={scale ? ownTitle : denseKind === 'derived' ? 'The vendor printed only the sparse headline; dense is half of it by the sparsity definition' : 'From the whitepaper or vendor spec page'}
        >
          {p.spec && precisions.length > 0 ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2">
              {precisions.map((key) => {
                const dense = p.spec!.tops[key];
                const sparse = p.spec!.sparse[key];
                const note = sparse !== undefined ? `sparse ${tops(own(sparse))}` : lead?.sparse === null ? 'no sparsity figure published' : 'no sparse figure';
                return (
                  <Stat
                    key={key}
                    label={LABEL[key]}
                    value={dense !== undefined ? tops(own(dense)) : 'not published'}
                    unit={unitOf(key)}
                    muted={dense === undefined}
                    note={scale && dense !== undefined ? `${note} · reference ${tops(dense)}${sparse !== undefined ? ` / ${tops(sparse)}` : ''}` : note}
                  />
                );
              })}
              <Stat label="FP32 shader" value={tops(own(p.spec.fp32Tflops))} unit="TFLOPS" note={scale ? `not a tensor figure · reference ${tops(p.spec.fp32Tflops)}` : 'not a tensor figure'} />
            </div>
          ) : p.spec?.unified ? (
            <div className="space-y-2">
              <p className="text-mini text-studio-muted">Apple publishes no tensor or TOPS figure for its GPUs or the Neural Engine; the measured matmul is what there is.</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Stat label="int8" value={measured?.matmulTopsInt8 != null ? tops(measured.matmulTopsInt8) : 'press Measure'} unit={measured?.matmulTopsInt8 != null ? 'TOPS' : undefined} kind={measured?.matmulTopsInt8 != null ? 'measured' : undefined} muted={measured?.matmulTopsInt8 == null} note="dense, int32 accumulate · Metal 4 tensor ops" />
                <Stat label="fp16 tensor" value={measured?.matmulTflopsFp16tensor != null ? tops(measured.matmulTflopsFp16tensor) : 'press Measure'} unit={measured?.matmulTflopsFp16tensor != null ? 'TFLOPS' : undefined} kind={measured?.matmulTflopsFp16tensor != null ? 'measured' : undefined} muted={measured?.matmulTflopsFp16tensor == null} note="dense, fp32 accumulate · Metal 4 tensor ops" />
                <Stat label="fp16 matmul" value={measured?.matmulTflopsFp16 != null ? tops(measured.matmulTflopsFp16) : 'press Measure'} unit={measured?.matmulTflopsFp16 != null ? 'TFLOPS' : undefined} kind={measured?.matmulTflopsFp16 != null ? 'measured' : undefined} muted={measured?.matmulTflopsFp16 == null} note="half-precision storage, this GPU" />
                <Stat label="fp32 matmul" value={measured ? tops(measured.matmulTflopsFp32) : 'press Measure'} unit={measured ? 'TFLOPS' : undefined} kind={measured ? 'measured' : undefined} muted={!measured} note="single precision, this GPU" />
                {p.spec.fp32Tflops > 0 && <Stat label="FP32 shader" value={tops(p.spec.fp32Tflops)} unit="TFLOPS" kind="derived" note={`${grouped(t!.shadingUnits)} ALUs × 2 × ${t!.boostMhz} MHz · not a tensor figure`} />}
                {p.spec.neuralEngineCores !== null && <Stat label="Neural Engine" value={`${p.spec.neuralEngineCores}`} unit="cores" note="no vendor throughput figure" />}
              </div>
            </div>
          ) : (
            <p className="text-mini text-studio-muted">{p.spec ? 'No tensor figures published for this GPU.' : p.integrated ? 'No tensor cores: an integrated GPU runs no local model faster than the CPU does.' : 'No reference tensor figures for this GPU yet.'}</p>
          )}
          {scale && <p className="text-[10px] text-studio-subtle">This card at {scale.mhz} MHz held under load; the reference figures are at {t!.boostMhz} MHz. An estimate, not a benchmark.</p>}
          {p.npuTops !== null && <Stat label="NPU" value={tops(p.npuTops)} unit="TOPS" note="vendor figure for the CPU's NPU" />}
        </Section>

        <Section title="Memory bandwidth">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {p.integrated ? (
              <Stat label="RAM bus" value={p.ramBandwidthGBs ? p.ramBandwidthGBs.toFixed(0) : 'unknown'} unit="GB/s" kind="spec" note="what a model streams from with no discrete GPU: the configured DIMM speed and channel count" />
            ) : (
              <Stat
                label="Spec"
                value={specBandwidth !== null ? specBandwidth.toFixed(0) : 'no figure'}
                unit={specBandwidth !== null ? 'GB/s' : undefined}
                kind={specBandwidth !== null ? 'spec' : undefined}
                muted={specBandwidth === null}
                note={specBandwidth === null ? (p.spec ? 'nobody publishes a figure' : 'no reference row for this GPU yet') : 'reference design'}
              />
            )}
            {!p.integrated && p.spec?.unified && (
              <Stat label="Measured" value={measured ? measured.bandwidthGBs.toFixed(0) : 'press Measure'} unit={measured ? 'GB/s' : undefined} kind={measured ? 'measured' : undefined} muted={!measured} note={measured ? `stream copy on this Mac · ${specBandwidth !== null ? `${Math.round((measured.bandwidthGBs / specBandwidth) * 100)} % of Apple's figure` : ''}` : "the pool's real rate, one figure for the CPU and the GPU"} />
            )}
            {!p.integrated && !p.spec?.unified && (
              <Stat
                label="This card"
                value={cardBandwidth !== null ? cardBandwidth.toFixed(0) : 'not read'}
                unit={cardBandwidth !== null ? 'GB/s' : undefined}
                kind={cardBandwidth !== null ? (c!.memSource === 'held' ? 'measured' : 'this card') : undefined}
                muted={cardBandwidth === null}
                note={
                  cardBandwidth !== null
                    ? `${gbps(c!.memGbps!)} × ${busBits}-bit${cardVsRef !== 0 ? ` · ${percent(cardVsRef)} vs reference` : ''}${c!.memSource === 'held' ? '' : ' · driver ceiling; run a load to measure'}`
                    : p.card
                      ? 'no memory clock ceiling from the driver'
                      : "needs the collector's live clocks"
                }
              />
            )}
          </div>
          {/* The stream copy is evidence for the figure above, not a rival figure: a copy kernel reaches ~80 % of any bus. */}
          {measured ? (
            <p className="text-[10px] text-studio-subtle">
              Stream copy <span className="figure">{measured.bandwidthGBs.toFixed(0)}</span> GB/s
              {gap !== null && (
                <>
                  {' '}
                  · {(100 + gap).toFixed(0)} % of {ceilingName} (a copy kernel reaches ~{(STREAM_EFFICIENCY * 100).toFixed(0)} %)
                </>
              )}
              {measured.bandwidthMedianGBs != null && (
                <>
                  {' '}
                  · median <span className="figure">{measured.bandwidthMedianGBs.toFixed(0)}</span>
                </>
              )}
              {' '}
              · {when(measured)}.
              {gapVsCopy !== null && gapVsCopy < -10 && ' Well below the expected copy: a throttled or shared card during the sweep.'}
            </p>
          ) : (
            <p className="text-[10px] text-studio-subtle">{p.bench ? `bench.json is from ${p.bench.device}, not this GPU.` : 'Not measured yet: Measure runs a stream copy to confirm the bus.'}</p>
          )}
          {notApplied && <p className="text-[10px] text-studio-subtle">{notApplied}</p>}
          {p.measuring ? (
            <Progress onStop={p.onStop} />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn btn-accent" disabled={!p.canMeasure} onClick={p.onMeasure} title={p.canMeasure ? 'Runs the worker bandwidth and matmul kernels (about 5 s)' : 'Needs the app: the worker runs from Electron'}>
                <Gauge size={13} /> {measured ? 'Measure again' : 'Measure'}
              </button>
              {p.error && <span className="text-mini text-rose-300">{p.error}</span>}
              {p.stopped && !p.error && <span className="text-mini text-studio-subtle">Stopped; {measured ? 'the earlier measurement stands' : 'nothing was measured'}.</span>}
            </div>
          )}
        </Section>

        <Section title="Matmul, shader cores">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat
              label="FP32"
              value={measured ? tops(measured.matmulTflopsFp32) : 'not measured'}
              unit={measured ? 'TFLOPS' : undefined}
              kind={measured ? 'measured' : undefined}
              muted={!measured}
              note={
                p.spec
                  ? measured
                    ? `of ${tops(own(p.spec.fp32Tflops))} ${scale ? `at the ${scale.mhz} MHz this card holds` : 'shader spec'}${measured.matmulN ? ` · ${measured.matmulN} × ${measured.matmulN}` : ''}`
                    : (
                        <>
                          shader {scale ? 'peak' : 'spec'} <span className="figure">{tops(own(p.spec.fp32Tflops))}</span> <Tag kind={ownTag} />
                        </>
                      )
                  : measured?.matmulN
                    ? `${measured.matmulN} × ${measured.matmulN}`
                    : undefined
              }
            />
            <Stat
              label="FP16 storage"
              value={measured?.matmulTflopsFp16 != null ? tops(measured.matmulTflopsFp16) : 'not measured'}
              unit={measured?.matmulTflopsFp16 != null ? 'TFLOPS' : undefined}
              kind={measured?.matmulTflopsFp16 != null ? 'measured' : undefined}
              muted={measured?.matmulTflopsFp16 == null}
              note="half storage, float maths on the shader cores: not a tensor-core figure, so the tensor figures above do not apply"
            />
          </div>
        </Section>
      </div>
    </Card>
  );
};
