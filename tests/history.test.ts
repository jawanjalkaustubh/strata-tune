import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { delta, describeDelta, makeEntry, newestFirst, type HistoryEntry } from '../src/analysis/history';
import type { Score } from '../src/analysis/score';
import { appendHistory, readHistory } from '../electron/history';

const score = (total: number | null, configuration: number | null, thermals: number | null, smoothness: number | null, efficiency: number | null): Score =>
  ({ total, subscores: { configuration, thermals, smoothness, efficiency }, complete: true, capped: false, valid: total !== null, invalidReasons: [], topFix: null });

describe('fix verification delta (plan §15)', () => {
  it('is after minus before, per subscore and in total', () => {
    const d = delta(makeEntry('Raised the fan curve', score(71, 80, 40, 85, 90), score(78, 80, 58, 88, 90)));
    expect(d.total).toBe(7);
    expect(d.subscores).toEqual({ configuration: 0, thermals: 18, smoothness: 3, efficiency: 0 });
    expect(describeDelta(d)).toBe('+7 total (Thermals +18, Smoothness +3)');
  });

  it('a side that was not measured is null, and the sentence says so', () => {
    const d = delta(makeEntry('Undervolt', score(null, 80, null, 85, 90), score(75, 80, 60, 85, 95)));
    expect(d.total).toBeNull();
    expect(d.subscores.thermals).toBeNull();
    expect(describeDelta(d)).toBe('total not comparable (Efficiency +5)');
    expect(describeDelta(delta(makeEntry('Nothing', score(70, 70, 70, 70, 70), score(70, 70, 70, 70, 70))))).toBe('0 total');
  });

  it('newestFirst sorts by date', () => {
    const a = makeEntry('a', score(1, 1, 1, 1, 1), score(2, 2, 2, 2, 2), '2026-09-10T00:00:00Z');
    const b = makeEntry('b', score(1, 1, 1, 1, 1), score(2, 2, 2, 2, 2), '2026-09-16T00:00:00Z');
    expect(newestFirst([a, b]).map((e) => e.what)).toEqual(['b', 'a']);
  });
});

describe('history.json on disk (electron/history.ts)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-tune-history-'));
  const file = path.join(dir, 'history.json');

  it('reads an absent or broken file as empty', () => {
    expect(readHistory(file)).toEqual([]);
    fs.writeFileSync(file, '{not json');
    expect(readHistory(file)).toEqual([]);
  });

  it('appends whole entries and drops rows that are not entries', () => {
    fs.writeFileSync(file, JSON.stringify([{ junk: true }]));
    const entry = makeEntry('Enabled EXPO', score(60, 40, 90, 70, 80), score(75, 100, 90, 70, 80), '2026-09-16T10:00:00Z');
    expect(appendHistory(entry, file)).toEqual([entry]);
    expect(readHistory(file)).toEqual([entry]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(() => appendHistory({ what: 'x' } as HistoryEntry, file)).toThrow(/missing/);
  });
});
