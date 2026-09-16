import React from 'react';
import { TONE, type Tone } from './Pill';
import { toneByLimit } from './Bar';
import { Tooltip, useTooltip, type Tip } from './Tooltip';
import type { Vendor } from './vendors';

export interface CoreCell {
  /** 1-based, as LibreHardwareMonitor numbers them. */
  n: number;
  effectiveMhz?: number;
  nominalMhz?: number;
  /** 0–100. */
  load?: number;
  smuW?: number;
  vid?: number;
}

export interface CoreGroup {
  /** "CCD1 (Tdie)" on Ryzen, "P-cores" / "E-cores" on an Intel hybrid, "Cores" otherwise. */
  label: string;
  tdie?: number;
  cores: CoreCell[];
}

interface Props {
  groups: CoreGroup[];
  tctl?: number;
  packageW?: number;
  /** Tjmax and the socket power ceiling, so the figures carry the same tone as the bars beside them. */
  tjmax?: number;
  powerLimitW?: number;
  vendor: Vendor;
}

const CELL_W = 46;
const CELL_H = 34;
const GAP = 4;
const PAD = 10;
const HEADER = 16;
const IOD_W = 60;
const COLS = 4;
const TEXT = '#f1f5f9';
const MUTED = '#94a3b8';
const OUTLINE = '#323b4e';
/** The load fill tops out as a tint (0.36 with the 0.06 floor): an AMD chip at full load must stay a red tint, not the solid red that the bars keep for "at a limit" (plan 17a). */
const LOAD_TINT = 0.3;

const ghz = (mhz?: number) => (mhz === undefined ? '—' : (mhz / 1000).toFixed(2));
const num = (v: number | undefined, digits: number, unit: string) => (v === undefined ? '—' : `${v.toFixed(digits)} ${unit}`);
const figureFill = (tone: Tone) => (tone === 'ok' ? TEXT : TONE[tone].hex);

/**
 * The package as an SVG: one cell per physical core, grouped by die, with the
 * IOD between the dies. Fill follows load as a tint of the vendor's colour (the
 * one gradient the panel allows, capped so a loaded AMD chip never matches the
 * state red beside it); the big figure is the effective clock because a
 * parked core reports its nominal 5.7 GHz and ~0 effective (plan 17), and the
 * nominal clock stands in where the library has no effective reading. Heat
 * reads before digits: a die's temperature and the package figures take the
 * amber/red of the bars, and a hot die's outline goes with them.
 */
export const ChipDiagram: React.FC<Props> = ({ groups, tctl, packageW, tjmax, powerLimitW, vendor }) => {
  const { host, tip, bind } = useTooltip();
  const blockCols = (g: CoreGroup) => Math.min(COLS, Math.max(g.cores.length, 1));
  const blockW = (g: CoreGroup) => blockCols(g) * CELL_W + (blockCols(g) - 1) * GAP;
  const blockH = (g: CoreGroup) => Math.ceil(Math.max(g.cores.length, 1) / COLS) * (CELL_H + GAP) - GAP + HEADER;
  // Dies stacked top to bottom with the IOD down the right edge: a 9950X is two 4×2 blocks
  // over each other, 276 px wide, which sits beside the bars at its natural size (plan 17a).
  const ys: number[] = [];
  let y = PAD;
  groups.forEach((g) => {
    ys.push(y);
    y += blockH(g) + PAD;
  });
  const innerH = Math.max(y - PAD * 2, CELL_H * 2 + GAP + HEADER);
  const diesW = Math.max(...groups.map(blockW), CELL_W * 2 + GAP);
  const iodX = PAD + diesW + PAD;
  const width = iodX + IOD_W + PAD;
  const height = innerH + PAD * 2;

  const tctlTone = toneByLimit(tctl ?? 0, tjmax);
  const pkgTone = toneByLimit(packageW ?? 0, powerLimitW);
  // The package outline is identity only (plan 17a: state colours are never vendor colours,
  // and an AMD-red outline must not be mistaken for "at a limit"); state lives on the die
  // outlines and the figures.
  const chipTone: Tone = tctlTone === 'bad' || pkgTone === 'bad' ? 'bad' : tctlTone === 'warn' || pkgTone === 'warn' ? 'warn' : 'ok';
  const packageTip: Tip = { title: 'Package', lines: [`Tctl ${num(tctl, 0, '°C')}${tjmax ? ` of ${tjmax} °C` : ''}`, `${num(packageW, 1, 'W')}${powerLimitW ? ` of ${powerLimitW} W` : ''}`] };

  return (
    <div ref={host} className="relative" style={{ maxWidth: width * 1.25 }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full h-auto max-w-full" role="img" aria-label="CPU cores by die">
        <rect x={1} y={1} width={width - 2} height={height - 2} rx={6} fill="#121620" stroke={vendor.colour} strokeOpacity={0.7} />
        {groups.map((g, gi) => {
          const dieTone = toneByLimit(g.tdie ?? 0, tjmax);
          return (
            <g key={g.label} transform={`translate(${PAD} ${ys[gi]})`}>
              <text x={0} y={10} className="chip-label" fill={MUTED}>
                {g.label.toUpperCase()}
              </text>
              {g.tdie !== undefined && (
                <text x={blockW(g)} y={10} textAnchor="end" className="chip-figure" fill={figureFill(dieTone)}>
                  {g.tdie.toFixed(0)} °C
                </text>
              )}
              {g.cores.map((c, i) => {
                const cx = (i % COLS) * (CELL_W + GAP);
                const cy = HEADER + Math.floor(i / COLS) * (CELL_H + GAP);
                const load = c.load ?? 0;
                const big = c.effectiveMhz ?? c.nominalMhz;
                const cellTip: Tip = {
                  title: `Core ${c.n}`,
                  lines: [
                    c.load === undefined ? 'load —' : `${load.toFixed(0)} % load`,
                    c.effectiveMhz === undefined ? `${ghz(c.nominalMhz)} GHz` : `${ghz(c.effectiveMhz)} GHz effective`,
                    ...(c.effectiveMhz !== undefined && c.nominalMhz !== undefined ? [`${ghz(c.nominalMhz)} GHz nominal`] : []),
                    ...(c.smuW !== undefined ? [num(c.smuW, 2, 'W')] : []),
                    ...(c.vid !== undefined ? [`${num(c.vid, 3, 'V')} VID`] : [])
                  ]
                };
                return (
                  <g key={c.n} transform={`translate(${cx} ${cy})`} {...bind(cellTip)}>
                    <rect width={CELL_W} height={CELL_H} rx={3} fill={vendor.colour} fillOpacity={0.06 + LOAD_TINT * Math.min(load, 100) / 100} stroke={dieTone === 'ok' ? OUTLINE : TONE[dieTone].hex} strokeWidth={dieTone === 'ok' ? 1 : 1.5} />
                    <text x={CELL_W / 2} y={16} textAnchor="middle" className="chip-figure" fill={TEXT}>
                      {ghz(big)}
                    </text>
                    <text x={CELL_W / 2} y={28} textAnchor="middle" className="chip-nominal" fill={MUTED}>
                      {c.effectiveMhz === undefined ? (c.nominalMhz === undefined ? '' : 'nominal') : ghz(c.nominalMhz)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <g transform={`translate(${iodX} ${PAD})`} {...bind(packageTip)}>
          <rect width={IOD_W} height={innerH} rx={3} fill="#161b26" stroke={chipTone === 'ok' ? OUTLINE : TONE[chipTone].hex} />
          <text x={IOD_W / 2} y={14} textAnchor="middle" className="chip-label" fill={MUTED}>
            PKG
          </text>
          <text x={IOD_W / 2} y={innerH / 2 + 2} textAnchor="middle" className="chip-figure" fill={figureFill(tctlTone)}>
            {tctl === undefined ? '—' : `${tctl.toFixed(0)} °C`}
          </text>
          <text x={IOD_W / 2} y={innerH / 2 + 16} textAnchor="middle" className="chip-nominal" fill={pkgTone === 'ok' ? MUTED : TONE[pkgTone].hex}>
            {packageW === undefined ? '—' : `${packageW.toFixed(0)} W`}
          </text>
        </g>
      </svg>
      <Tooltip tip={tip} hostWidth={host.current?.clientWidth} />
    </div>
  );
};
