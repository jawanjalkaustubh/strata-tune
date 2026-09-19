import React from 'react';
import { TONE, type Tone } from './Pill';
import { toneByThresholds } from './Bar';
import { sparkPath } from './Sparkline';
import { Tooltip, useTooltip, type Tip } from './Tooltip';
import { fanState } from './fans';
import type { Vendor } from './vendors';

export interface FanReading {
  name: string;
  rpm?: number;
  duty?: number;
  history?: (number | undefined)[];
}

export interface EngineReading {
  name: string;
  /** 0–100, the busiest instance. */
  load: number;
}

interface Props {
  vendor: Vendor;
  coreC: number;
  /** Only when the driver exposes it; the die never shows a dash for it (plan 17a). */
  hotSpotC?: number;
  coreV?: number;
  smMhz: number;
  memMhz: number;
  vramUsedMiB: number;
  vramTotalMiB: number;
  memJunctionC?: number;
  pcie: { gen: number; width: number; maxGen: number; maxWidth: number };
  /** B/s. */
  rx?: number;
  tx?: number;
  rxHistory?: (number | undefined)[];
  txHistory?: (number | undefined)[];
  fans: FanReading[];
  engines: EngineReading[];
  /** Connector power for the stub on the top edge, from the pins block beside the card; the current stands in when only that is sensed, never a watts figure made from it. */
  connectorW?: number;
  connectorA?: number;
  idle: boolean;
  /** 60 s series for the die and memory hover tips. */
  histories: { coreC: (number | undefined)[]; vramUsedMiB: (number | undefined)[] };
}

const W = 300;
const H = 178;
const TEXT = '#f1f5f9';
const MUTED = '#94a3b8';
const OUTLINE = '#323b4e';
const SURFACE = '#0c0e14';

const FAN_CX = 34;
const FAN_R = 21;
const CHIP_W = 14;
const CHIP_H = 15;
const CHIP_GAP = 4;
const DIE_X = 96;
const DIE_Y = 44;
const DIE_W = 80;
const DIE_H = 72;
const EDGE_Y = 156;
const ENGINE_X = 202;
const ENGINE_W = 88;
const LINK_X = 160;

const gib = (mib: number) => (mib / 1024).toFixed(1);
const rate = (bps?: number) => (bps === undefined ? '—' : bps >= 1e9 ? `${(bps / 1e9).toFixed(1)} GB/s` : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${(bps / 1e3).toFixed(0)} kB/s`);
const figureFill = (tone: Tone) => (tone === 'ok' || tone === 'idle' ? TEXT : TONE[tone].hex);

/**
 * The card as a schematic (plan 17a, phase1-polish item 4), outlined in the vendor
 * colour: fans on the shroud side, the die in the middle with the GDDR chips either
 * side (their fill is VRAM in use), engine loads on the flank (rows at zero collapse),
 * the 12V-2x6 stub on the top edge next to the pins block, and the PCIe edge along the
 * bottom with the link's gen × width and the Rx/Tx sparkline. Every zone answers hover
 * with its figures and a 60 s history. What the driver does not expose is left out,
 * never dashed: no VRM temperatures (ASUS EC only), hot spot only when NVML has it.
 */
export const CardSchematic: React.FC<Props> = (p) => {
  const { host, tip, bind } = useTooltip();
  const coreTone = toneByThresholds(p.coreC, 80, 88);
  const memTone = p.memJunctionC === undefined ? 'ok' : toneByThresholds(p.memJunctionC, 90, 100);
  const vramFrac = p.vramTotalMiB > 0 ? Math.min(p.vramUsedMiB / p.vramTotalMiB, 1) : 0;
  const linkDown = p.pcie.gen > 0 && p.pcie.width > 0 && (p.pcie.gen < p.pcie.maxGen || p.pcie.width < p.pcie.maxWidth);
  const linkText = p.pcie.gen > 0 ? `PCIe ${p.pcie.gen}.0 ×${p.pcie.width}${linkDown ? ` of ${p.pcie.maxGen}.0 ×${p.pcie.maxWidth}` : ''}` : 'PCIe';
  const rateMax = Math.max(...[...(p.rxHistory ?? []), ...(p.txHistory ?? [])].filter((x): x is number => x !== undefined), 1e6);
  const fans = p.fans.map((f) => ({ ...f, state: fanState(f.rpm, f.duty) })).filter((f) => !f.state.unused);
  const engines = p.engines.filter((e) => e.load > 0).slice(0, 6);

  const dieTip: Tip = {
    title: 'Die',
    lines: [`${p.coreC.toFixed(0)} °C core`, ...(p.hotSpotC !== undefined ? [`${p.hotSpotC.toFixed(0)} °C hot spot`] : []), ...(p.coreV !== undefined ? [`${p.coreV.toFixed(3)} V`] : []), `${p.smMhz.toFixed(0)} MHz SM`],
    history: p.histories.coreC,
    historyMax: 100
  };
  const memTip: Tip = {
    title: 'Memory',
    lines: [`${gib(p.vramUsedMiB)} of ${gib(p.vramTotalMiB)} GiB`, ...(p.memJunctionC !== undefined ? [`${p.memJunctionC.toFixed(0)} °C junction`] : []), `${p.memMhz.toFixed(0)} MHz`],
    history: p.histories.vramUsedMiB,
    historyMax: p.vramTotalMiB || 1
  };
  const linkTip: Tip = {
    title: 'PCIe link',
    lines: [linkText, `slot and card up to ${p.pcie.maxGen}.0 ×${p.pcie.maxWidth}`, `Rx ${rate(p.rx)}`, `Tx ${rate(p.tx)}`],
    history: p.rxHistory,
    historyMax: rateMax
  };

  // Chips flank the die, four a side; the fill runs left column top-down then right, as one bar folded in two.
  const chips = Array.from({ length: 8 }, (_, i) => {
    const side = i < 4 ? -1 : 1;
    const row = i % 4;
    const x = side < 0 ? DIE_X - CHIP_GAP - CHIP_W : DIE_X + DIE_W + CHIP_GAP;
    const y = DIE_Y + row * (CHIP_H + CHIP_GAP);
    const fill = Math.min(Math.max(vramFrac * 8 - i, 0), 1);
    return { x, y, fill };
  });

  return (
    <div ref={host} className="relative" style={{ maxWidth: W * 1.3 }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto max-w-full" role="img" aria-label="GPU card schematic">
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={6} fill="#121620" stroke={p.vendor.colour} strokeOpacity={0.7} />

        {/* 12V-2x6 stub on the top edge, beside the pins block it points at. */}
        {(p.connectorW !== undefined || p.connectorA !== undefined) && (
          <g transform={`translate(${W - 96} 1)`}>
            <rect x={0} y={0} width={86} height={14} rx={2} fill={SURFACE} stroke={OUTLINE} />
            <text x={43} y={10.5} textAnchor="middle" className="chip-nominal" fill={MUTED}>
              12V-2x6 {p.connectorW !== undefined ? `${p.connectorW.toFixed(0)} W` : `${p.connectorA!.toFixed(1)} A`}
            </text>
          </g>
        )}

        {/* Fans: duty as the arc, rpm inside; a radiator fan on a liquid card is still Fan n. */}
        {fans.map((f, i) => {
          const cy = 52 + i * 66;
          const c = 2 * Math.PI * FAN_R;
          const duty = Math.min(Math.max(f.duty ?? 0, 0), 100);
          const tone = f.state.tone;
          const fanTip: Tip = { title: f.name, lines: [`${f.rpm === undefined ? '—' : `${f.rpm.toFixed(0)} rpm`}`, ...(f.duty !== undefined ? [`${f.duty.toFixed(0)} % duty`] : []), ...(f.state.note ? [f.state.note] : [])], history: f.history, historyMax: 3000 };
          return (
            <g key={f.name} {...bind(fanTip)}>
              <text x={FAN_CX} y={cy - FAN_R - 5} textAnchor="middle" className="chip-label" fill={MUTED}>
                {f.name.toUpperCase()}
              </text>
              <circle cx={FAN_CX} cy={cy} r={FAN_R} fill={SURFACE} stroke={OUTLINE} />
              <circle cx={FAN_CX} cy={cy} r={FAN_R} fill="none" stroke={TONE[tone].hex} strokeWidth={2} strokeDasharray={`${((duty / 100) * c).toFixed(1)} ${c.toFixed(1)}`} transform={`rotate(-90 ${FAN_CX} ${cy})`} />
              <text x={FAN_CX} y={cy + 3} textAnchor="middle" className="chip-figure" fill={figureFill(tone)}>
                {f.rpm === undefined ? '—' : f.rpm.toFixed(0)}
              </text>
              <text x={FAN_CX} y={cy + 13} textAnchor="middle" className="chip-nominal" fill={MUTED}>
                {f.duty === undefined ? 'rpm' : `${f.duty.toFixed(0)} %`}
              </text>
            </g>
          );
        })}

        {/* Memory: the chips and their figures. */}
        <g {...bind(memTip)}>
          <text x={DIE_X + DIE_W / 2} y={DIE_Y - 10} textAnchor="middle" className="chip-nominal" fill={MUTED}>
            VRAM {gib(p.vramUsedMiB)} / {gib(p.vramTotalMiB)} GiB
          </text>
          {chips.map((c, i) => (
            <g key={i}>
              <rect x={c.x} y={c.y} width={CHIP_W} height={CHIP_H} rx={2} fill={SURFACE} stroke={OUTLINE} />
              {c.fill > 0 && <rect x={c.x + 1} y={c.y + 1 + (CHIP_H - 2) * (1 - c.fill)} width={CHIP_W - 2} height={(CHIP_H - 2) * c.fill} rx={1} fill={p.vendor.colour} fillOpacity={0.55} />}
            </g>
          ))}
          <text x={DIE_X + DIE_W / 2} y={DIE_Y + DIE_H + 13} textAnchor="middle" className="chip-nominal" fill={memTone === 'ok' ? MUTED : TONE[memTone].hex}>
            {p.memJunctionC !== undefined ? `MEM ${p.memJunctionC.toFixed(0)} °C · ` : 'MEM '}
            {p.memMhz.toFixed(0)} MHz
          </text>
        </g>

        {/* Die: core temperature big, voltage and SM clock small. */}
        <g transform={`translate(${DIE_X} ${DIE_Y})`} {...bind(dieTip)}>
          <rect width={DIE_W} height={DIE_H} rx={3} fill={p.vendor.colour} fillOpacity={p.idle ? 0.06 : 0.16} stroke={coreTone === 'ok' ? OUTLINE : TONE[coreTone].hex} />
          <text x={DIE_W / 2} y={11} textAnchor="middle" className="chip-label" fill={MUTED}>
            DIE
          </text>
          <text x={DIE_W / 2} y={p.hotSpotC === undefined ? 36 : 32} textAnchor="middle" className="chip-big" fill={figureFill(coreTone)}>
            {p.coreC.toFixed(0)} °C
          </text>
          {p.hotSpotC !== undefined && (
            <text x={DIE_W / 2} y={44} textAnchor="middle" className="chip-nominal" fill={figureFill(toneByThresholds(p.hotSpotC, 90, 100))}>
              hot spot {p.hotSpotC.toFixed(0)} °C
            </text>
          )}
          <text x={DIE_W / 2} y={p.hotSpotC === undefined ? 52 : 56} textAnchor="middle" className="chip-nominal" fill={MUTED}>
            {p.coreV !== undefined ? `${p.coreV.toFixed(3)} V` : ''}
          </text>
          <text x={DIE_W / 2} y={p.hotSpotC === undefined ? 63 : 66} textAnchor="middle" className="chip-nominal" fill={MUTED}>
            {p.smMhz.toFixed(0)} MHz
          </text>
        </g>

        {/* Engines on the flank: micro-bars for the busy ones only. */}
        <g transform={`translate(${ENGINE_X} 30)`}>
          <text x={0} y={8} className="chip-label" fill={MUTED}>
            ENGINES
          </text>
          {engines.length === 0 ? (
            <text x={0} y={22} className="chip-nominal" fill={MUTED}>
              idle
            </text>
          ) : (
            engines.map((e, i) => {
              const y = 14 + i * 15;
              return (
                <g key={e.name} transform={`translate(0 ${y})`} {...bind({ title: e.name === 'OFA' ? 'Optical flow accelerator' : `${e.name} engine`, lines: [`${e.load.toFixed(0)} % busy`] })}>
                  <text x={0} y={7} className="chip-nominal" fill={MUTED}>
                    {e.name}
                  </text>
                  <rect x={ENGINE_W - 42} y={3} width={42} height={4} rx={2} fill={OUTLINE} />
                  <rect x={ENGINE_W - 42} y={3} width={(42 * Math.min(e.load, 100)) / 100} height={4} rx={2} fill={TONE.ok.hex} />
                </g>
              );
            })
          )}
        </g>

        {/* PCIe edge connector along the bottom, with the link check made visible: the gen × width and the Rx/Tx figures on the row above, the throughput sparkline on the edge beside the fingers. */}
        <g {...bind(linkTip)}>
          <text x={10} y={EDGE_Y - 5} className="chip-nominal" fill={linkDown ? TONE.warn.hex : MUTED}>
            {linkText}
          </text>
          <rect x={10} y={EDGE_Y} width={140} height={10} rx={1} fill={SURFACE} stroke={OUTLINE} />
          {Array.from({ length: 27 }, (_, i) => (
            <line key={i} x1={15 + i * 5} y1={EDGE_Y + 2} x2={15 + i * 5} y2={EDGE_Y + 8} stroke={linkDown ? TONE.warn.hex : p.vendor.colour} strokeOpacity={0.5} />
          ))}
          <text x={W - 10} y={EDGE_Y - 5} textAnchor="end" className="chip-nominal" fill={MUTED}>
            RX {rate(p.rx)} · TX {rate(p.tx)}
          </text>
          <g transform={`translate(${LINK_X} ${EDGE_Y - 2})`}>
            <path d={sparkPath(p.rxHistory ?? [], W - 10 - LINK_X, 14, 0, rateMax)} fill="none" stroke={TONE.ok.hex} strokeWidth={1.2} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
            <path d={sparkPath(p.txHistory ?? [], W - 10 - LINK_X, 14, 0, rateMax)} fill="none" stroke={TONE.info.hex} strokeWidth={1.2} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
          </g>
        </g>
      </svg>
      <Tooltip tip={tip} hostWidth={host.current?.clientWidth} />
    </div>
  );
};
