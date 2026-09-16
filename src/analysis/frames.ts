/**
 * PresentMon CSV → FrameRow, by header name and never by index (docs/dependencies.md:
 * the upstream column table is stale). The capture host feeds parseLine one line at a
 * time as the pipe delivers them; a saved capture goes through parsePresentMonCsv. The
 * text is whatever the host decoded: PresentMon writes narrow Latin-1 with CRLF to a
 * pipe, and this file only asks that the header be a line of comma-separated names.
 */
import type { FrameRow } from './session-types';

/** Plan §11: the first 300 frames of a capture are the level load and no analysis reads them. */
export const WARMUP_FRAMES = 300;

type NumberField = { [K in keyof FrameRow]: FrameRow[K] extends number | null ? K : never }[keyof FrameRow];
type StringField = { [K in keyof FrameRow]: FrameRow[K] extends string ? K : never }[keyof FrameRow];

const STRING_COLUMNS: Record<string, StringField> = {
  Application: 'application',
  SwapChainAddress: 'swapChainAddress',
  PresentRuntime: 'presentRuntime',
  PresentMode: 'presentMode'
};

const NUMBER_COLUMNS: Record<string, NumberField> = {
  ProcessID: 'processId',
  SyncInterval: 'syncInterval',
  PresentFlags: 'presentFlags',
  AllowsTearing: 'allowsTearing',
  TimeInQPC: 'timeInQpc',
  MsBetweenSimulationStart: 'msBetweenSimulationStart',
  MsBetweenPresents: 'msBetweenPresents',
  MsBetweenDisplayChange: 'msBetweenDisplayChange',
  MsInPresentAPI: 'msInPresentApi',
  MsRenderPresentLatency: 'msRenderPresentLatency',
  MsUntilDisplayed: 'msUntilDisplayed',
  CPUStartQPC: 'cpuStartQpc',
  MsBetweenAppStart: 'msBetweenAppStart',
  MsCPUBusy: 'msCpuBusy',
  MsCPUWait: 'msCpuWait',
  MsGPULatency: 'msGpuLatency',
  MsGPUTime: 'msGpuTime',
  MsGPUBusy: 'msGpuBusy',
  MsGPUWait: 'msGpuWait',
  MsAnimationError: 'msAnimationError',
  AnimationTime: 'animationTime',
  MsFlipDelay: 'msFlipDelay',
  MsAllInputToPhotonLatency: 'msAllInputToPhotonLatency',
  MsClickToPhotonLatency: 'msClickToPhotonLatency'
};

function emptyRow(): FrameRow {
  return {
    application: '', processId: 0, swapChainAddress: '', presentRuntime: '', syncInterval: 0, presentFlags: 0,
    allowsTearing: 0, presentMode: '', timeInQpc: 0, msBetweenSimulationStart: null, msBetweenPresents: 0,
    msBetweenDisplayChange: null, msInPresentApi: null, msRenderPresentLatency: null, msUntilDisplayed: null,
    cpuStartQpc: null, msBetweenAppStart: null, msCpuBusy: null, msCpuWait: null, msGpuLatency: null, msGpuTime: null,
    msGpuBusy: null, msGpuWait: null, msAnimationError: null, animationTime: null, msFlipDelay: null,
    msAllInputToPhotonLatency: null, msClickToPhotonLatency: null
  };
}

function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === '' || t === 'NA') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Splits a header or data line; PresentMon never quotes, so a plain split is the whole grammar. */
function cells(line: string): string[] {
  return line.replace(/\r$/, '').split(',');
}

export function parseHeader(line: string): string[] {
  return cells(line).map((c) => c.trim());
}

/**
 * One data line against the header it arrived under. Returns null for anything that is
 * not a measurable frame: a blank line, a repeated header, a ragged row, or a row whose
 * TimeInQPC or MsBetweenPresents is missing (there is no place on the timeline for it).
 */
export function parseLine(header: string[], line: string): FrameRow | null {
  const values = cells(line);
  if (values.length !== header.length || values[0] === header[0]) return null;
  const row = emptyRow();
  let sawQpc = false;
  let sawFrameTime = false;
  for (let i = 0; i < header.length; i++) {
    const name = header[i];
    const stringField = STRING_COLUMNS[name];
    if (stringField) {
      row[stringField] = values[i].trim();
      continue;
    }
    const numberField = NUMBER_COLUMNS[name];
    if (!numberField) continue;
    const n = parseNumber(values[i]);
    if (numberField === 'timeInQpc') {
      if (n === null) return null;
      sawQpc = true;
      row.timeInQpc = n;
    } else if (numberField === 'msBetweenPresents') {
      if (n === null) return null;
      sawFrameTime = true;
      row.msBetweenPresents = n;
    } else if (numberField === 'processId' || numberField === 'syncInterval' || numberField === 'presentFlags' || numberField === 'allowsTearing') {
      row[numberField] = n ?? 0;
    } else {
      row[numberField] = n;
    }
  }
  return sawQpc && sawFrameTime ? row : null;
}

/** A whole capture, CRLF or LF; the first non-empty line is the header. */
export function parsePresentMonCsv(text: string): { header: string[]; rows: FrameRow[] } {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start === lines.length) return { header: [], rows: [] };
  const header = parseHeader(lines[start]);
  const rows: FrameRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const row = parseLine(header, lines[i]);
    if (row) rows.push(row);
  }
  return { header, rows };
}

/** The classic frame time, MsBetweenPresents. */
export function frameTimeMs(row: FrameRow): number {
  return row.msBetweenPresents;
}
