/**
 * The Tune page's reading of the collector's /tune/* wire (src/collector-types.ts, plan
 * section 16): the few derived facts the components share, and the flight file's NDJSON.
 * Nothing here decides anything about the card; that is the collector's.
 */
import type { FlightLine, TuneCandidate, TuneDeltas, TuneRollback, TuneRun, TuneStatus, TuneVerdict } from '../../collector-types';
import type { Tone } from '../monitor/Pill';

export type Axis = 'core' | 'memory';

export interface Offsets {
  coreMhz: number;
  memMhz: number;
}

/** "+90" / "−15": offsets are always signed, so a zero reads as "+0" (applied, and nothing). */
export const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}`;

export const pair = (d: Offsets) => `core ${signed(d.coreMhz)} · mem ${signed(d.memMhz)} MHz`;

export const STAGE_TONE: Record<TuneRollback, Tone> = { KNOWN_GOOD: 'ok', PENDING: 'warn', VALIDATING: 'info', REVERTED: 'bad' };

export const STAGE_TEXT: Record<TuneRollback, string> = {
  KNOWN_GOOD: 'nothing of Tune\'s is on the card',
  PENDING: 'a candidate is applied; a crash now is reverted at the next start',
  VALIDATING: 'a kept result is on the card until the next reboot; a clean shutdown and a clean boot then mark it known-good (the offsets are not re-applied: the export text is what persists)',
  REVERTED: 'the last start found a candidate applied across a crash and put the baseline back'
};

/** 'device-lost' is stage 3 of the failure ladder, drawn like any other tripped rung. */
export const VERDICT_TONE: Record<TuneVerdict, Tone> = { stable: 'ok', unstable: 'bad', invalid: 'warn', 'device-lost': 'bad' };

export const STAGE_NAME: Record<number, string> = { 1: 'silent error', 2: 'bandwidth fell', 3: 'driver reset', 4: 'hard hang' };

/** The axis a run moves; a validate run replays the found values, whose non-zero axis is the one to draw. */
export function axisOf(run: TuneRun): Axis {
  if (run.kind === 'memory') return 'memory';
  if (run.kind === 'core') return 'core';
  const memMoved = run.candidates.filter((c) => c.deltas.memMhz !== 0).length;
  return memMoved > run.candidates.length / 2 ? 'memory' : 'core';
}

export const on = (d: TuneDeltas | Offsets, axis: Axis) => (axis === 'memory' ? d.memMhz : d.coreMhz);

/** A memory step that held but did not raise the bandwidth above a lower step's is the sweep's "tripped": the climb turns back there. */
export function notRising(run: TuneRun, c: TuneCandidate): boolean {
  if (run.kind !== 'memory' || c.verdict !== 'stable' || c.bandwidthGBs === null) return false;
  const bw = c.bandwidthGBs;
  const step = on(c.deltas, 'memory');
  return run.candidates.some((o) => o !== c && o.verdict === 'stable' && o.bandwidthGBs !== null && on(o.deltas, 'memory') < step && o.bandwidthGBs >= bw);
}

export const tripped = (run: TuneRun, c: TuneCandidate) => c.verdict === 'unstable' || c.verdict === 'device-lost' || notRising(run, c);

/** The bisect window while the hunt narrows: the highest rung that held (and, for memory, rose) and the lowest that tripped. */
export function bisectOf(run: TuneRun, axis: Axis): { lo: number; hi: number } | null {
  if (run.phase !== 'bisect') return null;
  const held = run.candidates.filter((c) => c.verdict === 'stable' && !notRising(run, c)).map((c) => on(c.deltas, axis));
  const trips = run.candidates.filter((c) => tripped(run, c)).map((c) => on(c.deltas, axis));
  if (held.length === 0 || trips.length === 0) return null;
  return { lo: Math.max(...held), hi: Math.min(...trips) };
}

export function candidateTitle(c: TuneCandidate, axis: Axis): string {
  const stage = c.stage ? ` (stage ${c.stage}, ${STAGE_NAME[c.stage] ?? 'unknown'}${c.failedPattern ? `, ${c.failedPattern} pattern` : ''})` : '';
  const bandwidth = c.bandwidthGBs !== null ? `, ${c.bandwidthGBs.toFixed(0)} GB/s` : '';
  return `${axis} ${signed(on(c.deltas, axis))} MHz: ${c.verdict}${stage}${bandwidth}${c.note ? ` — ${c.note}` : ''}`;
}

/**
 * The collector answers a refusal as JSON { error } behind a 409; the client's message
 * carries it as `POST /tune/start answered 409 {"error":"…"}`. The words are what the user needs.
 */
export function refusalOf(message: string): string {
  const m = /\{.*\}\s*$/s.exec(message);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    } catch {
      /* not JSON: the message stands */
    }
  }
  return message;
}

/** The vendor tool the collector named in a refusal, for the state strip's warning. */
export function toolIn(refusal: string | null): string | null {
  const m = refusal ? /(GPU Tweak III|GPUTweakIII|MSIAfterburner|Afterburner)/i.exec(refusal) : null;
  return m ? m[1] : null;
}

/** Something of Tune's is on the card, or a crash revert waits to be acknowledged. */
export const revertable = (s: TuneStatus) => s.state !== 'KNOWN_GOOD';

/** GET /tune/flight is NDJSON, one FlightLine per line; a line the recorder cut short is dropped, not fatal. */
export function parseFlight(ndjson: string): FlightLine[] {
  const lines: FlightLine[] = [];
  for (const raw of ndjson.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as FlightLine;
      if (parsed && (parsed.kind === 'sample' || parsed.kind === 'event')) lines.push(parsed);
    } catch {
      /* a partial last line from a flush cut off by the hang */
    }
  }
  return lines;
}
