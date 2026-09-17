import React, { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { GpuBench } from '../../api';
import { STREAM_EFFICIENCY } from '../../analysis/advisor';
import { openExternal } from '../../support';
import { Card } from './Card';
import { Stat, Tag, type Provenance } from './Tag';
import { percent, tops } from './format';
import { PRECISIONS, type GpuSpecView, type Precision } from './rows';

/** The worker's 3 s sweep plus the matmul runs, measured at under 4 s on the dev box; the bar only paces expectation, the result ends it. */
const MEASURE_EXPECTED_S = 5;

interface Props {
  gpuName: string;
  gpuColour: string;
  spec: GpuSpecView | null;
  npuTops: number | null;
  /** The cached or fresh bench, whether or not it was taken on this GPU; `applies` says which. */
  bench: GpuBench | null;
  applies: boolean;
  measuring: boolean;
  canMeasure: boolean;
  error: string;
  onMeasure: () => void;
}

const LABEL: Record<Precision, string> = { fp4: 'FP4', fp8: 'FP8', int8: 'INT8', int4: 'INT4', fp16: 'FP16', bf16: 'BF16', tf32: 'TF32' };
const unitOf = (p: Precision) => (p.startsWith('int') ? 'TOPS' : 'TFLOPS');
/** Vendor style for the one number people arrive with: "3,352". */
const grouped = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });

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

const Progress: React.FC = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(id);
  }, []);
  const pct = Math.min(elapsed / MEASURE_EXPECTED_S, 0.95) * 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-studio-subtle">
        <span>Bandwidth sweep, then matmul…</span>
        <span className="figure">
          {elapsed.toFixed(0)} / ~{MEASURE_EXPECTED_S} s
        </span>
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

const Tile: React.FC<{ label: string; value: string; title?: string }> = ({ label, value, title }) => (
  <div className="min-w-0 px-2 py-1 rounded border border-studio-border bg-studio-surface" title={title}>
    <div className="label text-[9px] truncate">{label}</div>
    <div className="figure text-mini text-studio-text whitespace-nowrap">{value}</div>
  </div>
);

const Link: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <button className="underline decoration-dotted underline-offset-2 hover:text-studio-text" onClick={() => openExternal(href)} title={href}>
    {children}
  </button>
);

/**
 * Plan section 10, the AI stats card: the advertised figure first, then the card's own
 * spec tiles, then dense/sparse compute pairs, spec against measured bandwidth, and the
 * worker's matmul beside the shader spec.
 */
export const StatsCard: React.FC<Props> = (p) => {
  const measured = p.applies ? p.bench : null;
  const specBandwidth = p.spec?.bandwidthGBs ?? null;
  const expectedCopy = specBandwidth !== null ? specBandwidth * STREAM_EFFICIENCY : null;
  const gap = measured && specBandwidth !== null ? ((measured.bandwidthGBs - specBandwidth) / specBandwidth) * 100 : null;
  const gapVsCopy = measured && expectedCopy !== null ? ((measured.bandwidthGBs - expectedCopy) / expectedCopy) * 100 : null;
  const when = (b: GpuBench) => `${b.device}${b.driver ? `, driver ${b.driver}` : ''}, ${new Date(b.measuredAt).toLocaleDateString()}`;
  const precisions = PRECISIONS.filter((x) => p.spec?.tops[x] !== undefined || p.spec?.sparse[x] !== undefined);
  const lead = p.spec ? headline(p.spec) : null;
  const denseKind: Provenance = p.spec?.denseDerived ? 'derived' : 'spec';
  const t = p.spec?.tiles;

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
                <span className="figure text-2xl leading-7 text-studio-text">{grouped(lead.value)}</span>
                <span className="text-mini text-studio-muted">{lead.advertised ? 'AI TOPS' : unitOf(lead.precision)}</span>
                <span className="label">
                  {LABEL[lead.precision]} · {lead.sparse === null ? 'no sparsity qualifier' : lead.sparse ? 'sparse' : 'dense'}
                </span>
                <Tag kind="spec" title={lead.advertised ? `As advertised: ${p.spec.advertised!.source}` : `The vendor advertises no AI TOPS headline; this is its largest published figure (${p.spec.source})`} />
                {!lead.advertised && <span className="text-[10px] text-studio-subtle">no advertised AI TOPS; largest published figure</span>}
              </>
            ) : (
              <span className="text-mini text-studio-muted">No tensor figure published for this GPU.</span>
            )}
          </div>
          <div className="text-mini text-studio-muted figure">
            {t.die} · {p.spec.vramGiB} GB {t.vramType} · {t.busBits}-bit · {specBandwidth !== null ? `${specBandwidth} GB/s` : 'bandwidth unknown'}
          </div>
          <div className="grid gap-1.5 grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-11">
            <Tile label="die" value={t.die} />
            <Tile label="shaders" value={grouped(t.shadingUnits)} />
            <Tile label="TMUs" value={String(t.tmus)} />
            <Tile label="ROPs" value={String(t.rops)} />
            <Tile label="VRAM" value={`${p.spec.vramGiB} GB ${t.vramType}`} />
            <Tile label="bus" value={`${t.busBits}-bit`} />
            <Tile label="base / boost" value={t.baseMhz !== null ? `${t.baseMhz} / ${t.boostMhz}` : `— / ${t.boostMhz}`} title={t.baseMhz === null ? 'The vendor page prints no base clock' : 'MHz, reference design'} />
            <Tile label="memory" value={`${t.memoryGbps} Gbps`} />
            <Tile label="bandwidth" value={specBandwidth !== null ? `${specBandwidth} GB/s` : '—'} />
            <Tile label="TDP" value={`${t.tdpW} W`} />
            <Tile label="PSU" value={t.suggestedPsuW !== null ? `${t.suggestedPsuW} W` : '—'} title={t.suggestedPsuW === null ? 'The vendor page prints no PSU recommendation' : "The vendor's recommended system power supply"} />
          </div>
          <div className="text-[10px] text-studio-subtle flex flex-wrap gap-x-3">
            <span>
              Reference design figures <Tag kind="spec" />: <Link href={p.spec.source}>vendor page</Link>. A board-partner card runs above them.
            </span>
          </div>
        </div>
      ) : (
        <p className="text-mini text-studio-muted">Not in gpus.json: could not determine. Add a row to src/data/gpus.json.</p>
      )}

      <div className="grid gap-x-6 gap-y-4 grid-cols-1 md:grid-cols-[1.2fr_1fr_1fr] pt-2">
        <Section
          title="Tensor throughput, dense / sparse"
          tag={p.spec ? denseKind : undefined}
          tagTitle={denseKind === 'derived' ? 'The vendor printed only the sparse headline; dense is half of it by the sparsity definition' : 'From the whitepaper or vendor spec page'}
        >
          {p.spec && precisions.length > 0 ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2">
              {precisions.map((key) => {
                const dense = p.spec!.tops[key];
                const sparse = p.spec!.sparse[key];
                return (
                  <Stat
                    key={key}
                    label={LABEL[key]}
                    value={dense !== undefined ? tops(dense) : '—'}
                    unit={unitOf(key)}
                    muted={dense === undefined}
                    note={sparse !== undefined ? `sparse ${tops(sparse)}` : lead?.sparse === null ? 'no sparsity figure published' : 'no sparse figure'}
                  />
                );
              })}
              <Stat label="FP32 shader" value={tops(p.spec.fp32Tflops)} unit="TFLOPS" note="not a tensor figure" />
            </div>
          ) : (
            <p className="text-mini text-studio-muted">{p.spec ? 'No tensor figures published for this GPU.' : 'Not in gpus.json: could not determine.'}</p>
          )}
          {p.npuTops !== null && <Stat label="NPU" value={tops(p.npuTops)} unit="TOPS" note="vendor figure for the CPU's NPU" />}
        </Section>

        <Section title="Memory bandwidth">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat
              label="Spec"
              value={specBandwidth !== null ? specBandwidth.toFixed(0) : '—'}
              unit="GB/s"
              kind={specBandwidth !== null ? 'spec' : undefined}
              muted={specBandwidth === null}
              note={
                specBandwidth === null
                  ? p.spec
                    ? 'could not determine: nobody publishes a figure'
                    : 'could not determine: not in gpus.json'
                  : `a stream copy reaches ~${(STREAM_EFFICIENCY * 100).toFixed(0)} %: ${expectedCopy!.toFixed(0)} GB/s expected`
              }
            />
            <Stat
              label="Measured"
              value={measured ? measured.bandwidthGBs.toFixed(0) : '—'}
              unit="GB/s"
              kind={measured ? 'measured' : undefined}
              muted={!measured}
              note={
                measured
                  ? gap !== null
                    ? `${percent(gap)} vs spec · ${percent(gapVsCopy!)} vs expected copy`
                    : 'no spec to compare'
                  : p.bench
                    ? `bench.json is from ${p.bench.device}, not this GPU`
                    : 'not measured yet'
              }
            />
          </div>
          {measured?.bandwidthMedianGBs != null && (
            <p className="text-[10px] text-studio-subtle">
              best of N; median <span className="figure">{measured.bandwidthMedianGBs.toFixed(0)}</span> GB/s · {when(measured)}. Above expected means the memory runs over the reference
              clock, below means a throttled or shared card.
            </p>
          )}
          {p.measuring ? (
            <Progress />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn btn-accent" disabled={!p.canMeasure} onClick={p.onMeasure} title={p.canMeasure ? 'Runs the worker bandwidth and matmul kernels (about 5 s)' : 'Needs the app: the worker runs from Electron'}>
                <Gauge size={13} /> {measured ? 'Measure again' : 'Measure'}
              </button>
              {p.error && <span className="text-mini text-rose-300">{p.error}</span>}
            </div>
          )}
        </Section>

        <Section title="Matmul, shader cores">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat
              label="FP32"
              value={measured ? tops(measured.matmulTflopsFp32) : '—'}
              unit="TFLOPS"
              kind={measured ? 'measured' : undefined}
              muted={!measured}
              note={
                p.spec
                  ? measured
                    ? `of ${tops(p.spec.fp32Tflops)} shader spec${measured.matmulN ? ` · ${measured.matmulN} × ${measured.matmulN}` : ''}`
                    : (
                        <>
                          shader spec <span className="figure">{tops(p.spec.fp32Tflops)}</span> <Tag kind="spec" />
                        </>
                      )
                  : measured?.matmulN
                    ? `${measured.matmulN} × ${measured.matmulN}`
                    : undefined
              }
            />
            <Stat
              label="FP16 storage"
              value={measured?.matmulTflopsFp16 != null ? tops(measured.matmulTflopsFp16) : '—'}
              unit="TFLOPS"
              kind={measured?.matmulTflopsFp16 != null ? 'measured' : undefined}
              muted={measured?.matmulTflopsFp16 == null}
              note="half storage, float maths on the shader cores: not a tensor-core figure, so the tensor spec above does not apply"
            />
          </div>
        </Section>
      </div>
    </Card>
  );
};
