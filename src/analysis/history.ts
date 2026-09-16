import type { Score, Subscore, Subscores } from './score';

/**
 * Fix verification (master plan §15): after a change the same workload runs again
 * and the delta is stored as { what, before, after, date }. The file lives in the
 * app's user-data folder (electron/history.ts); this module is the pure part.
 */
export interface ScoreSnapshot {
  total: number | null;
  subscores: Subscores;
}

export interface HistoryEntry {
  /** What the user changed, in their words: "Raised the fan curve". */
  what: string;
  before: ScoreSnapshot;
  after: ScoreSnapshot;
  /** ISO 8601. */
  date: string;
}

export interface ScoreDelta {
  total: number | null;
  subscores: Record<Subscore, number | null>;
}

export const SUBSCORES: Subscore[] = ['configuration', 'thermals', 'smoothness', 'efficiency'];

export const SUBSCORE_LABEL: Record<Subscore, string> = { configuration: 'Configuration', thermals: 'Thermals', smoothness: 'Smoothness', efficiency: 'Efficiency' };

export function snapshot(score: Score): ScoreSnapshot {
  return { total: score.total, subscores: { ...score.subscores } };
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);

/** After minus before, per subscore and in total; null where either side was not measured. */
export function delta(entry: Pick<HistoryEntry, 'before' | 'after'>): ScoreDelta {
  const subscores = Object.fromEntries(SUBSCORES.map((k) => [k, diff(entry.before.subscores[k], entry.after.subscores[k])])) as Record<Subscore, number | null>;
  return { total: diff(entry.before.total, entry.after.total), subscores };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** "+7 total (Thermals +18, Smoothness +3)"; subscores that did not move are left out. */
export function describeDelta(d: ScoreDelta): string {
  const moved = SUBSCORES.filter((k) => d.subscores[k] !== null && d.subscores[k] !== 0).map((k) => `${SUBSCORE_LABEL[k]} ${signed(d.subscores[k] as number)}`);
  const total = d.total === null ? 'total not comparable' : `${signed(d.total)} total`;
  return moved.length ? `${total} (${moved.join(', ')})` : total;
}

export function makeEntry(what: string, before: Score, after: Score, date = new Date().toISOString()): HistoryEntry {
  return { what: what.trim(), before: snapshot(before), after: snapshot(after), date };
}

/** Newest first, the order the page shows them in. */
export function newestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}
