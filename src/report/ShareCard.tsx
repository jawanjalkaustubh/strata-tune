import React from 'react';
import { LOGO_DATA_URL } from '../assets/logo';
import type { Score, Subscore } from '../analysis/score';
import { SUBSCORES, SUBSCORE_LABEL } from '../analysis/history';

export const CARD_W = 1200;
export const CARD_H = 630;

export interface ShareCardProps {
  score: Score;
  /** "AMD Ryzen 9 9950X · GeForce RTX 5090". */
  hardware: string;
  date?: string;
}

const C = {
  bg: '#0c0e14', panel: '#161b26', border: '#232938', track: '#232938', text: '#f1f5f9', muted: '#94a3b8', subtle: '#64748b',
  ok: '#10b981', warn: '#fbbf24', bad: '#f43f5e', idle: '#64748b'
};
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, Consolas, "Cascadia Mono", Menlo, monospace';

/** State colour by score band: the same three semantics as every bar in the app. */
const toneOf = (v: number) => (v >= 80 ? C.ok : v >= 50 ? C.warn : C.bad);

const Label: React.FC<{ x: number; y: number; children: string; anchor?: 'start' | 'end'; fill?: string }> = ({ x, y, children, anchor = 'start', fill = C.muted }) => (
  <text x={x} y={y} fontFamily={SANS} fontSize={16} fontWeight={500} letterSpacing="0.08em" fill={fill} textAnchor={anchor}>
    {children.toUpperCase()}
  </text>
);

const BAR_X = 620;
const BAR_W = 460;
const BAR_H = 10;

const SubscoreRow: React.FC<{ k: Subscore; value: number | null; y: number }> = ({ k, value, y }) => (
  <g>
    <Label x={BAR_X} y={y}>
      {SUBSCORE_LABEL[k]}
    </Label>
    <text x={BAR_X + BAR_W} y={y} fontFamily={MONO} fontSize={22} fill={value === null ? C.subtle : C.text} textAnchor="end">
      {value === null ? 'not measured' : value}
    </text>
    <rect x={BAR_X} y={y + 12} width={BAR_W} height={BAR_H} rx={BAR_H / 2} fill={C.track} />
    {value !== null && <rect x={BAR_X} y={y + 12} width={Math.max(BAR_H, (BAR_W * value) / 100)} height={BAR_H} rx={BAR_H / 2} fill={toneOf(value)} />}
  </g>
);

/**
 * The share card (plan §14): 1200×630, total, four bars, top fix, hardware line, the
 * St monogram. Plain SVG with system fonts and the monogram as a data URL, so the
 * same markup rasterises on a 2D canvas with GPU acceleration off (toPng below).
 */
export const ShareCard: React.FC<ShareCardProps> = ({ score, hardware, date }) => {
  const total = score.total;
  const tone = total === null ? C.idle : toneOf(total);
  const fix = score.topFix;
  const rows = SUBSCORES;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={CARD_W} height={CARD_H} viewBox={`0 0 ${CARD_W} ${CARD_H}`} role="img" aria-label="Strata Tune system score">
      <rect width={CARD_W} height={CARD_H} fill={C.bg} />
      <rect x={40} y={40} width={CARD_W - 80} height={CARD_H - 80} rx={12} fill={C.panel} stroke={C.border} />
      <rect x={40} y={40} width={6} height={CARD_H - 80} rx={3} fill={tone} />

      <image href={LOGO_DATA_URL} x={80} y={72} width={48} height={48} />
      <Label x={144} y={92} fill={C.text}>
        Strata Tune
      </Label>
      <Label x={144} y={116}>
        System score
      </Label>
      {date && (
        <text x={CARD_W - 80} y={92} fontFamily={MONO} fontSize={16} fill={C.subtle} textAnchor="end">
          {date}
        </text>
      )}

      {total === null ? (
        <>
          <text x={80} y={300} fontFamily={SANS} fontSize={56} fontWeight={600} fill={C.text}>
            Not comparable
          </text>
          <text x={80} y={344} fontFamily={SANS} fontSize={20} fill={C.muted}>
            {score.invalidReasons[0] ?? 'nothing measured yet'}
          </text>
        </>
      ) : (
        <>
          <text x={80} y={330} fontFamily={MONO} fontSize={200} fontWeight={500} fill={tone}>
            {total}
          </text>
          <text x={80} y={380} fontFamily={SANS} fontSize={20} fill={C.muted}>
            {score.capped ? 'capped at 60: a driver reset or compute error during validation' : score.complete ? 'out of 100' : 'out of 100, partly measured'}
          </text>
        </>
      )}

      {rows.map((k, i) => (
        <SubscoreRow key={k} k={k} value={score.subscores[k]} y={200 + i * 72} />
      ))}

      <line x1={80} x2={CARD_W - 80} y1={450} y2={450} stroke={C.border} />
      <Label x={80} y={486}>
        {fix ? 'Top fix' : 'Configuration'}
      </Label>
      <text x={80} y={516} fontFamily={SANS} fontSize={24} fill={C.text}>
        {fix ? fix.title : 'Nothing to fix'}
      </text>
      <text x={80} y={572} fontFamily={SANS} fontSize={18} fill={C.muted}>
        {hardware}
      </text>
    </svg>
  );
};

/**
 * Rasterises the rendered card to PNG on a 2D canvas in the renderer: the SVG
 * element is serialised to a data URL, drawn through an Image, and read back with
 * toBlob. No WebGL, so it works with hardware acceleration off. Fonts are the
 * system stacks the SVG names, so the PNG matches what the app shows.
 */
export function toPng(card: SVGSVGElement): Promise<Blob> {
  const svg = new XMLSerializer().serializeToString(card);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = CARD_W;
      canvas.height = CARD_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('2D canvas unavailable'));
      ctx.drawImage(img, 0, 0, CARD_W, CARD_H);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('share card SVG did not load'));
    img.src = url;
  });
}
