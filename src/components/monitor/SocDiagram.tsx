import React from 'react';
import { TONE, type Tone } from './Pill';
import { toneByThresholds } from './Bar';
import { Tooltip, useTooltip, type Tip } from './Tooltip';
import type { Vendor } from './vendors';

interface Props {
  vendor: Vendor;
  /** One cell per GPU core, all tinted by the one load the chip reports (Apple exposes no per-core GPU figures). */
  gpuCores: number;
  /** 0-100. */
  load?: number;
  clockMhz?: number;
  /** The top of the clock table, for the tooltip. */
  maxClockMhz?: number;
  tempC?: number;
  powerW?: number;
  neuralCores?: number;
  anePowerW?: number;
  memUsedMiB?: number;
  memTotalMiB?: number;
  memoryPowerW?: number;
}

const CELL = 18;
const GAP = 3;
const PAD = 10;
const HEADER = 16;
/** Two lines of figures under the core grid (clock and temperature, then power and load), so nothing shares the header with the label. */
const FOOTER = 28;
const COLS = 10;
const NE_COLS = 8;
const NE_CELL = 10;
/** Wide enough for "16 cores · 0.02 W" in the 10 px figure font. */
const RIGHT_W = 128;
const MEM_H = 30;
const TEXT = '#f1f5f9';
const MUTED = '#94a3b8';
const OUTLINE = '#323b4e';
const LOAD_TINT = 0.3;
const ANE_TINT_AT_W = 8;

const figureFill = (tone: Tone) => (tone === 'ok' || tone === 'idle' ? TEXT : TONE[tone].hex);
const num = (v: number | undefined, digits: number, unit: string) => (v === undefined ? '—' : `${v.toFixed(digits)} ${unit}`);
const gib = (mib?: number) => (mib === undefined ? '—' : `${(mib / 1024).toFixed(1)} GiB`);

/**
 * The Apple SoC's GPU side as an SVG, the twin of ChipDiagram for the CPU: a block of GPU cores
 * (one cell each, tinted by load like the CPU cells), the Neural Engine's cores beside them with
 * the power they draw, and the unified memory the GPU works from with its working set filled.
 * Apple reports one clock, one load and one temperature for the whole GPU, so every core cell
 * carries the same tint; the block header holds the figures. Nothing is drawn as a dash for a
 * figure the chip does not expose (plan 17a).
 */
export const SocDiagram: React.FC<Props> = ({ vendor, gpuCores, load, clockMhz, maxClockMhz, tempC, powerW, neuralCores, anePowerW, memUsedMiB, memTotalMiB, memoryPowerW }) => {
  const { host, tip, bind } = useTooltip();
  const cores = Math.max(1, gpuCores);
  const cols = Math.min(COLS, cores);
  const rows = Math.ceil(cores / cols);
  const gpuW = cols * (CELL + GAP) - GAP;
  const gridH = rows * (CELL + GAP) - GAP;
  const gpuH = HEADER + gridH + FOOTER;
  const ne = neuralCores ?? 0;
  const neCols = Math.min(NE_COLS, Math.max(ne, 1));
  const neRows = ne > 0 ? Math.ceil(ne / neCols) : 0;
  const neW = ne > 0 ? neCols * (NE_CELL + GAP) - GAP : 0;
  const neH = ne > 0 ? HEADER + neRows * (NE_CELL + GAP) - GAP + 14 : 0;
  const rightW = Math.max(neW, RIGHT_W);
  const width = PAD + gpuW + PAD + rightW + PAD;
  const memY = PAD + Math.max(gpuH, neH + 28) + PAD;
  const height = memY + HEADER + MEM_H + PAD;
  const tint = 0.06 + (LOAD_TINT * Math.min(load ?? 0, 100)) / 100;
  const tempTone = toneByThresholds(tempC ?? 0, 85, 95);
  const memFrac = memTotalMiB && memUsedMiB !== undefined ? Math.min(1, memUsedMiB / memTotalMiB) : 0;
  const memTone = toneByThresholds(memFrac * 100, 85, 95);
  const aneTint = 0.06 + LOAD_TINT * Math.min(1, (anePowerW ?? 0) / ANE_TINT_AT_W);
  const gpuTip: Tip = {
    title: `GPU · ${gpuCores} cores`,
    lines: [load === undefined ? 'load —' : `${load.toFixed(0)} % busy`, `${num(clockMhz, 0, 'MHz')}${maxClockMhz ? ` of ${maxClockMhz} MHz` : ''}`, num(tempC, 0, '°C'), num(powerW, 1, 'W')]
  };
  const neTip: Tip = { title: `Neural Engine · ${ne} cores`, lines: [num(anePowerW, 2, 'W'), 'Apple publishes no throughput figure'] };
  const memTip: Tip = { title: 'Unified memory', lines: [`GPU working set ${gib(memUsedMiB)} of ${gib(memTotalMiB)}`, ...(memoryPowerW !== undefined ? [`${num(memoryPowerW, 2, 'W')} memory`] : []), 'one pool for the CPU, the GPU and the Neural Engine'] };

  return (
    <div ref={host} className="relative" style={{ maxWidth: width * 1.25 }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full h-auto max-w-full" role="img" aria-label="GPU cores, Neural Engine and unified memory">
        <rect x={1} y={1} width={width - 2} height={height - 2} rx={6} fill="#121620" stroke={vendor.colour} strokeOpacity={0.7} />
        <g transform={`translate(${PAD} ${PAD})`} {...bind(gpuTip)}>
          <text x={0} y={10} className="chip-label" fill={MUTED}>
            GPU · {gpuCores} CORES
          </text>
          {Array.from({ length: cores }, (_, i) => (
            <rect key={i} x={(i % cols) * (CELL + GAP)} y={HEADER + Math.floor(i / cols) * (CELL + GAP)} width={CELL} height={CELL} rx={2} fill={vendor.colour} fillOpacity={tint} stroke={OUTLINE} />
          ))}
          <text x={0} y={HEADER + gridH + 13} className="chip-figure" fill={figureFill(tempTone)}>
            {[clockMhz === undefined ? null : `${clockMhz.toFixed(0)} MHz`, tempC === undefined ? null : `${tempC.toFixed(0)} °C`].filter(Boolean).join(' · ')}
          </text>
          <text x={0} y={HEADER + gridH + 25} className="chip-nominal" fill={MUTED}>
            {[powerW === undefined ? null : `${powerW.toFixed(1)} W`, load === undefined ? null : `${load.toFixed(0)} % busy`].filter(Boolean).join(' · ')}
          </text>
        </g>
        <g transform={`translate(${PAD + gpuW + PAD} ${PAD})`}>
          {ne > 0 && (
            <g {...bind(neTip)}>
              <text x={0} y={10} className="chip-label" fill={MUTED}>
                NEURAL ENGINE
              </text>
              {Array.from({ length: ne }, (_, i) => (
                <rect key={i} x={(i % neCols) * (NE_CELL + GAP)} y={HEADER + Math.floor(i / neCols) * (NE_CELL + GAP)} width={NE_CELL} height={NE_CELL} rx={1.5} fill={vendor.colour} fillOpacity={aneTint} stroke={OUTLINE} />
              ))}
              <text x={0} y={neH - 2} className="chip-nominal" fill={MUTED}>
                {anePowerW === undefined ? `${ne} cores` : `${ne} cores · ${anePowerW.toFixed(2)} W`}
              </text>
            </g>
          )}
        </g>
        <g transform={`translate(${PAD} ${memY})`} {...bind(memTip)}>
          <text x={0} y={10} className="chip-label" fill={MUTED}>
            UNIFIED MEMORY
          </text>
          <text x={width - PAD * 2} y={10} textAnchor="end" className="chip-figure" fill={figureFill(memTone)}>
            {memTotalMiB ? `${gib(memUsedMiB)} of ${gib(memTotalMiB)}` : ''}
          </text>
          <rect x={0} y={HEADER} width={width - PAD * 2} height={MEM_H - 8} rx={3} fill="#161b26" stroke={memTone === 'ok' || memTone === 'idle' ? OUTLINE : TONE[memTone].hex} />
          <rect x={1} y={HEADER + 1} width={Math.max(0, (width - PAD * 2 - 2) * memFrac)} height={MEM_H - 10} rx={2} fill={vendor.colour} fillOpacity={0.35} />
          <text x={6} y={HEADER + 15} className="chip-nominal" fill={MUTED}>
            {memoryPowerW === undefined ? 'GPU working set' : `GPU working set · ${memoryPowerW.toFixed(2)} W memory`}
          </text>
        </g>
      </svg>
      <Tooltip tip={tip} hostWidth={host.current?.clientWidth} />
    </div>
  );
};
