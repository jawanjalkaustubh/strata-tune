import { app, type IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { HistoryEntry } from '../src/analysis/history';

/**
 * Fix-verification history (master plan §15): a JSON array of
 * { what, before, after, date } in the app's user-data folder
 * (%APPDATA%\strata-tune\history.json). Read on demand, written whole
 * (tmp + rename) so a crash mid-write leaves the previous file, never half of one.
 */
export const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');

function isEntry(v: unknown): v is HistoryEntry {
  const e = v as Partial<HistoryEntry> | null;
  return !!e && typeof e.what === 'string' && typeof e.date === 'string' && !!e.before && !!e.after;
}

export function readHistory(file = HISTORY_FILE()): HistoryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function writeHistory(entries: HistoryEntry[], file = HISTORY_FILE()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, file);
}

export function appendHistory(entry: HistoryEntry, file = HISTORY_FILE()): HistoryEntry[] {
  if (!isEntry(entry)) throw new Error('history entry is missing what, before, after or date');
  const entries = [...readHistory(file), entry];
  writeHistory(entries, file);
  return entries;
}

export function registerHistoryIpc(ipcMain: IpcMain): void {
  ipcMain.handle('history:list', () => readHistory());
  ipcMain.handle('history:add', (_e, entry: HistoryEntry) => appendHistory(entry));
}
