import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, LAPTOP_LAYOUT, isDefaultLayout, movePanel, parseLayout, placeLayout, rowsOf, snapSpan, type Layout } from '../src/components/monitor/layout';

/** What the page puts on the grid of a machine without a battery node: the order minus the battery panel. */
const desktop = (layout: Layout): Layout => layout.filter((p) => p.id !== 'battery');

const cell = (layout: Layout, id: Layout[number]['id']) => {
  const p = placeLayout(layout).find((x) => x.id === id)!;
  return [p.row, p.col, p.rows, p.span];
};

/** No cell of the grid's rows is empty: what the default and the integration run's moved state must satisfy. */
const holes = (layout: Layout) => {
  const placed = placeLayout(layout);
  const rows = Math.max(...placed.map((p) => p.row + p.rows));
  const taken = new Set(placed.flatMap((p) => Array.from({ length: p.rows }, (_, i) => Array.from({ length: p.span }, (_, j) => `${p.row + i},${p.col + j}`)).flat()));
  return rows * 6 - taken.size;
};

describe('Monitor layout (phase1-polish item 3)', () => {
  it('parseLayout round-trips what the settings carry and drops what does not parse', () => {
    const saved = [{ id: 'gpu', span: 3, rows: 2 }, { id: 'power', span: 3 }, { id: 'battery', span: 3 }, { id: 'board', span: 6, height: 240 }, { id: 'cpu', span: 3 }];
    expect(parseLayout(saved)).toEqual(saved);
    expect(parseLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    // Bad spans, unknown ids, duplicates and a height under the minimum are ignored; a missing panel takes its default place at the end.
    expect(parseLayout([{ id: 'gpu', span: 5 }, { id: 'nope', span: 3 }, { id: 'cpu', span: 2, height: 10 }, { id: 'cpu', span: 4 }])).toEqual([
      { id: 'cpu', span: 2 }, { id: 'gpu', span: 3, rows: 2 }, { id: 'power', span: 3 }, { id: 'battery', span: 3 }, { id: 'board', span: 6 }
    ]);
    // A layout saved before the battery panel existed gets it in its default slot, before the board, so a laptop upgrading keeps its arrangement.
    const before = [{ id: 'gpu', span: 3, rows: 2 }, { id: 'power', span: 3 }, { id: 'board', span: 6, height: 240 }, { id: 'cpu', span: 3 }];
    expect(parseLayout(before).map((p) => p.id)).toEqual(['gpu', 'power', 'battery', 'board', 'cpu']);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('x')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null, true)).toEqual(LAPTOP_LAYOUT);
    expect(isDefaultLayout(parseLayout(undefined))).toBe(true);
    expect(isDefaultLayout(parseLayout(undefined, true), true)).toBe(true);
    expect(isDefaultLayout(parseLayout(undefined, true))).toBe(false);
    expect(isDefaultLayout(parseLayout(saved))).toBe(false);
  });

  it('the default: CPU and power stack beside the two-row GPU panel, the board underneath, no hole', () => {
    const grid = desktop(DEFAULT_LAYOUT);
    expect(cell(grid, 'cpu')).toEqual([0, 0, 1, 3]);
    expect(cell(grid, 'gpu')).toEqual([0, 3, 2, 3]);
    expect(cell(grid, 'power')).toEqual([1, 0, 1, 3]);
    expect(cell(grid, 'board')).toEqual([2, 0, 1, 6]);
    expect(holes(grid)).toBe(0);
    expect(rowsOf(placeLayout(grid))).toEqual({ rows: 3, lastRow: new Set(['board']) });
  });

  it('the laptop default (plan 17d): the battery beside the board on the third row, no hole', () => {
    expect(cell(LAPTOP_LAYOUT, 'cpu')).toEqual([0, 0, 1, 3]);
    expect(cell(LAPTOP_LAYOUT, 'gpu')).toEqual([0, 3, 2, 3]);
    expect(cell(LAPTOP_LAYOUT, 'power')).toEqual([1, 0, 1, 3]);
    expect(cell(LAPTOP_LAYOUT, 'battery')).toEqual([2, 0, 1, 3]);
    expect(cell(LAPTOP_LAYOUT, 'board')).toEqual([2, 3, 1, 3]);
    expect(holes(LAPTOP_LAYOUT)).toBe(0);
    expect(rowsOf(placeLayout(LAPTOP_LAYOUT))).toEqual({ rows: 3, lastRow: new Set(['battery', 'board']) });
  });

  it('the integration run\'s moved state (gpu, power, board, cpu) packs the CPU panel back beside the GPU instead of leaving a hole', () => {
    const moved = desktop(movePanel(DEFAULT_LAYOUT, 'cpu', 'board'));
    expect(moved.map((p) => p.id)).toEqual(['gpu', 'power', 'board', 'cpu']);
    expect(cell(moved, 'gpu')).toEqual([0, 0, 2, 3]);
    expect(cell(moved, 'power')).toEqual([0, 3, 1, 3]);
    expect(cell(moved, 'cpu')).toEqual([1, 3, 1, 3]);
    expect(cell(moved, 'board')).toEqual([2, 0, 1, 6]);
    expect(holes(moved)).toBe(0);
    expect(rowsOf(placeLayout(moved)).lastRow).toEqual(new Set(['board']));
  });

  it('a two-row GPU panel that nothing fills beside takes one row, so a full-width neighbour never opens a panel-high hole', () => {
    const order: Layout = [{ id: 'cpu', span: 3 }, { id: 'power', span: 3 }, { id: 'gpu', span: 3, rows: 2 }, { id: 'board', span: 6 }];
    expect(cell(order, 'gpu')).toEqual([1, 0, 1, 3]);
    expect(cell(order, 'board')).toEqual([2, 0, 1, 6]);
    expect(holes(order)).toBe(3);
    // The CPU panel resized to four columns: the GPU panel cannot sit beside it, so it drops to one row and the grid stays three rows deep.
    const wide: Layout = [{ id: 'cpu', span: 4, height: 300 }, { id: 'gpu', span: 3, rows: 2 }, { id: 'power', span: 3 }, { id: 'board', span: 6 }];
    expect(cell(wide, 'gpu')).toEqual([1, 0, 1, 3]);
    expect(cell(wide, 'power')).toEqual([1, 3, 1, 3]);
    expect(rowsOf(placeLayout(wide)).rows).toBe(3);
  });

  it('dense packing: a narrow panel later in the order fills a gap left earlier', () => {
    const l: Layout = [{ id: 'cpu', span: 4 }, { id: 'gpu', span: 3 }, { id: 'power', span: 2 }, { id: 'board', span: 6 }];
    expect(cell(l, 'power')).toEqual([0, 4, 1, 2]);
    expect(cell(l, 'gpu')).toEqual([1, 0, 1, 3]);
  });

  it('snapSpan picks the nearest of a third, a half, two thirds and the row', () => {
    expect([0.3, 0.45, 0.6, 0.9].map(snapSpan)).toEqual([2, 3, 4, 6]);
  });

  it('movePanel is sortable: the dragged panel takes the target\'s slot, nothing else changes', () => {
    expect(movePanel(DEFAULT_LAYOUT, 'board', 'cpu').map((p) => p.id)).toEqual(['board', 'cpu', 'gpu', 'power', 'battery']);
    expect(movePanel(DEFAULT_LAYOUT, 'cpu', 'cpu')).toBe(DEFAULT_LAYOUT);
    expect(movePanel(DEFAULT_LAYOUT, 'gpu', 'power')[2]).toEqual({ id: 'gpu', span: 3, rows: 2 });
  });
});
