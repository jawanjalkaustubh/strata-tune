/**
 * The Monitor page's panel arrangement (phase1-polish item 3): a six-column grid so a
 * panel can take a third (2), a half (3), two thirds (4) or the whole row (6); order
 * is the array order. Persisted as settings.monitorLayout, which settings.ts types as
 * unknown because this file owns the shape; anything that does not parse is the default.
 */
export type PanelId = 'cpu' | 'gpu' | 'power' | 'board';
export type Span = 2 | 3 | 4 | 6;

export interface PanelPlace {
  id: PanelId;
  span: Span;
  /** Rows the panel may span: the tall GPU panel takes two so the CPU panel and the power row stack beside it. Honoured only when they do (placeLayout). */
  rows?: 1 | 2;
  /** Height in px set with the corner grip; undefined lets the content decide. */
  height?: number;
}

export type Layout = PanelPlace[];

/** A panel's cell on the grid, zero-based; `rows` is what the grid gives it, which is 1 where a two-row span would leave a hole. */
export interface PlacedPanel extends PanelPlace {
  row: number;
  col: number;
  rows: 1 | 2;
}

export const COLUMNS = 6;
export const SPANS: Span[] = [2, 3, 4, 6];
export const MIN_HEIGHT = 120;
const IDS: PanelId[] = ['cpu', 'gpu', 'power', 'board'];

export const DEFAULT_LAYOUT: Layout = [
  { id: 'cpu', span: 3 },
  { id: 'gpu', span: 3, rows: 2 },
  { id: 'power', span: 3 },
  { id: 'board', span: 6 }
];

const isSpan = (x: unknown): x is Span => typeof x === 'number' && (SPANS as number[]).includes(x);

/** A saved layout is trusted only panel by panel; a panel missing from it takes its default place at the end. */
export function parseLayout(raw: unknown): Layout {
  const out: Layout = [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (!p || typeof p !== 'object') continue;
      const { id, span, rows, height } = p as Record<string, unknown>;
      if (!IDS.includes(id as PanelId) || out.some((x) => x.id === id) || !isSpan(span)) continue;
      const h = typeof height === 'number' && Number.isFinite(height) && height >= MIN_HEIGHT ? Math.round(height) : undefined;
      out.push({ id: id as PanelId, span, ...(rows === 2 ? { rows: 2 } : {}), ...(h !== undefined ? { height: h } : {}) });
    }
  }
  for (const d of DEFAULT_LAYOUT) if (!out.some((x) => x.id === d.id)) out.push({ ...d });
  return out;
}

export function isDefaultLayout(layout: Layout): boolean {
  return layout.length === DEFAULT_LAYOUT.length && layout.every((p, i) => p.id === DEFAULT_LAYOUT[i].id && p.span === DEFAULT_LAYOUT[i].span && (p.rows ?? 1) === (DEFAULT_LAYOUT[i].rows ?? 1) && p.height === undefined);
}

/** Dense packing, the way CSS grid's `auto-flow: row dense` walks: each panel takes the first cell, row-major, where it fits. */
function pack(layout: Layout, rowsOfPanel: (p: PanelPlace) => 1 | 2): { placed: PlacedPanel[]; taken: Set<string> } {
  const taken = new Set<string>();
  const key = (r: number, c: number) => `${r},${c}`;
  const fits = (r: number, c: number, span: number, rows: number) => {
    if (c + span > COLUMNS) return false;
    for (let i = 0; i < rows; i++) for (let j = 0; j < span; j++) if (taken.has(key(r + i, c + j))) return false;
    return true;
  };
  const placed: PlacedPanel[] = [];
  for (const p of layout) {
    const rows = rowsOfPanel(p);
    let row = 0;
    let col = 0;
    while (!fits(row, col, p.span, rows)) {
      col += 1;
      if (col + p.span > COLUMNS) {
        row += 1;
        col = 0;
      }
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < p.span; j++) taken.add(key(row + i, col + j));
    placed.push({ ...p, row, col, rows });
  }
  return { placed, taken };
}

/**
 * Where each panel sits. A two-row panel is only worth two rows when the panels after it
 * fill both rows beside it; otherwise (a full-width panel next in order, a resized
 * neighbour) it would leave a hole the height of a panel, so it takes one row like the
 * rest and the grid stays packed. Holes then come only from spans that cannot tile, which
 * is the user's own arrangement.
 */
export function placeLayout(layout: Layout): PlacedPanel[] {
  const demoted = new Set<PanelId>();
  for (;;) {
    const { placed, taken } = pack(layout, (p) => (p.rows === 2 && !demoted.has(p.id) ? 2 : 1));
    const hollow = placed.find((p) => {
      if (p.rows !== 2) return false;
      for (let r = p.row; r < p.row + p.rows; r++) for (let c = 0; c < COLUMNS; c++) if ((c < p.col || c >= p.col + p.span) && !taken.has(`${r},${c}`)) return true;
      return false;
    });
    if (!hollow) return placed;
    demoted.add(hollow.id);
  }
}

/** How many rows a placed grid has and which panels end on the last one (that row takes the rest of the viewport). */
export function rowsOf(placed: PlacedPanel[]): { rows: number; lastRow: Set<PanelId> } {
  const rows = Math.max(0, ...placed.map((p) => p.row + p.rows));
  return { rows, lastRow: new Set(placed.filter((p) => p.row + p.rows === rows).map((p) => p.id)) };
}

/** The span nearest to a dragged width, as a fraction of the grid. */
export function snapSpan(fraction: number): Span {
  let best: Span = SPANS[0];
  for (const s of SPANS) if (Math.abs(s / COLUMNS - fraction) < Math.abs(best / COLUMNS - fraction)) best = s;
  return best;
}

/** Sortable semantics: the dragged panel takes the target's slot and the rest shift. */
export function movePanel(layout: Layout, id: PanelId, targetId: PanelId): Layout {
  const from = layout.findIndex((p) => p.id === id);
  const to = layout.findIndex((p) => p.id === targetId);
  if (from < 0 || to < 0 || from === to) return layout;
  const next = [...layout];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
