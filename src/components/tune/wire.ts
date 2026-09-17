/**
 * The Tune page's reading of the collector's /tune/* wire (src/collector-types.ts, plan
 * section 16): the few derived facts the components share, and the flight file's NDJSON.
 * Nothing here decides anything about the card; that is the collector's.
 */
import type { FlightLine, ScoredRun, TuneCandidate, TuneLadderKind, TuneResult, TuneRollback, TuneRun, TuneStatus, TuneStopReason, TuneVerdict } from '../../collector-types';
import { converged, CORE_STEP_KHZ, gainedOnCap, isScoredRun, judgeAdditivity, meanClockNoiseMhz, MEM_STEP_KHZ, throughputNoise } from '../../analysis/tune';
import type { Tone } from '../monitor/Pill';

export interface Offsets {
  coreMhz: number;
  memMhz: number;
}

/** "+90" / "−15": offsets are always signed, so a zero reads as "+0" (applied, and nothing). */
export const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}`;

export const pair = (d: Offsets) => `core ${signed(d.coreMhz)} · mem ${signed(d.memMhz)} MHz`;

/** "11,812": points are printed with thousands separators everywhere, as the export text does. */
export const points = (n: number) => n.toLocaleString('en-US');

/** The state machine as trimmed on 2026-09-16: IDLE → PENDING (a rung is on the card) → IDLE; REVERTED is the attribution after a crash. */
export const STAGE_TONE: Record<TuneRollback, Tone> = { IDLE: 'ok', PENDING: 'warn', REVERTED: 'bad' };

export const STAGE_TEXT: Record<TuneRollback, string> = {
  IDLE: "nothing of Tune's is on the card",
  PENDING: 'a rung is on the card under test; a crash now is reverted at the next collector start',
  REVERTED: 'the last start found a rung applied across a crash and put the baseline back'
};

/** 'device-lost' is stage 3 of the failure ladder, drawn like any other tripped rung. */
export const VERDICT_TONE: Record<TuneVerdict, Tone> = { stable: 'ok', unstable: 'bad', invalid: 'warn', 'device-lost': 'bad' };

export const STAGE_NAME: Record<number, string> = { 1: 'silent error', 2: 'regression', 3: 'driver reset', 4: 'hard hang' };

/** The failure ladder's stages in the words of the result block; the stops that are not failures say what ended the ladder. */
export const STOP_TEXT: Record<TuneStopReason, string> = {
  hash: 'silent error',
  throughput: 'throughput fell',
  bandwidth: 'bandwidth fell',
  'device-lost': 'driver reset',
  thermal: 'the cooler, not the clock, is the limit',
  inconsistent: 'the repeats disagreed',
  'foreign-tune': 'a tune we cannot see is on the card',
  'vendor-mismatch': 'the vendor value entered is not what the card holds',
  additivity: 'the driver is not adding our offset',
  'driver-max': "the driver's offset range",
  ceiling: "the driver's clock ceiling",
  cap: 'the rung cap',
  'top-of-table': 'the top of the clock table',
  'user-cap': 'your cap'
};

/** The rungs of one ladder, in the order they were tested, without the scored runs (isScoredRun). */
export const rungsOf = (candidates: readonly TuneCandidate[], ladder: TuneLadderKind, scored: readonly (ScoredRun | null)[] = []) =>
  candidates.filter((c) => c.ladder === ladder && !scored.some((s) => isScoredRun(c, s)));

/** The rung's offset above the baseline on its own axis, in MHz. */
export const offsetOf = (c: Pick<TuneCandidate, 'ladder' | 'deltas'>, baseline: Offsets | null) =>
  c.ladder === 'memory' ? c.deltas.memMhz - (baseline?.memMhz ?? 0) : c.deltas.coreMhz - (baseline?.coreMhz ?? 0);

export const tripped = (c: TuneCandidate) => c.verdict === 'unstable' || c.verdict === 'device-lost';

/** The ladders the rungs have touched, memory first as the hunt runs them; the one under test too when it has no rung yet. */
export function laddersOf(candidates: readonly TuneCandidate[], testing: TuneLadderKind | null = null, scored: readonly (ScoredRun | null)[] = []): TuneLadderKind[] {
  const seen = new Set<TuneLadderKind>(candidates.filter((c) => !scored.some((s) => isScoredRun(c, s))).map((c) => c.ladder));
  if (testing) seen.add(testing);
  return (['memory', 'core'] as const).filter((l) => seen.has(l));
}

export function candidateTitle(c: TuneCandidate, baseline: Offsets | null): string {
  const stage = c.stage ? ` (stage ${c.stage}, ${STAGE_NAME[c.stage] ?? 'unknown'}${c.failedPattern ? `, ${c.failedPattern} half` : ''})` : '';
  const score = c.score ? `, ${points(c.score.points)} points` : '';
  const held = c.held ? `, held ${c.held.smMhz} / ${c.held.memMhz} MHz` : '';
  return `${c.ladder} ${signed(offsetOf(c, baseline))} MHz: ${c.verdict}${stage}${score}${held}${c.note ? ` — ${c.note}` : ''}`;
}

/**
 * The first rung's additivity check as the result shows it (plan section 16): the first
 * rung of each ladder must hold about the rung above the card as found. Read back from the
 * rungs and the stops, since the collector judged it; a ladder with no rung above the
 * baseline or no as-found figure to compare with has no row.
 */
export interface Additivity {
  ladder: TuneLadderKind;
  passed: boolean;
  /** "16016 vs 16008 as found (+15 written)", the undecided wording, or the collector's own stop sentence. */
  text: string;
}

/**
 * The additivity check read back per ladder from the rungs as tested: the climb is judged
 * against what it sat on (the vendor rung's own peaks when the user's tune was written through
 * our route, else the card as found: the top of the curve for the core, the memory clock for
 * memory), rung by rung until one decides it (judgeAdditivity), as the collector does. A core
 * rung whose top did not move is read on the cap as the collector reads it (gainedOnCap: the
 * sustained mean clock and the throughput against the reference; the page has no as-found
 * spread, so the floors are the rule's own minimums), and a top-of-table or additivity stop
 * the collector wrote is the verdict as it stands.
 */
export function additivityOf(r: Pick<TuneResult, 'rungs' | 'baseline' | 'baselineHeld' | 'stops'> & { asFound?: ScoredRun | null }): Additivity[] {
  const out: Additivity[] = [];
  for (const ladder of ['memory', 'core'] as const) {
    // A top-of-table stop at +0 is the additivity verdict itself; one higher up ended a climb whose additivity had shown, and reads back from the rungs like any other.
    const stop = r.stops.find((s) => s.ladder === ladder && (s.reason === 'additivity' || (s.reason === 'top-of-table' && s.offsetMhz === 0)));
    if (stop) {
      out.push({ ladder, passed: false, text: stop.note });
      continue;
    }
    const figure = (c: Pick<TuneCandidate, 'held' | 'topSmMhz'>) => (ladder === 'memory' ? c.held?.memMhz : (c.topSmMhz ?? c.held?.smMhz)) ?? null;
    const rungs = rungsOf(r.rungs, ladder, [r.asFound ?? null]);
    // The vendor rung sits at the baseline on both axes and serves both ladders.
    const vendor = r.rungs.find((c) => c.deltas.coreKhz === r.baseline.coreKhz && c.deltas.memKhz === r.baseline.memKhz && !isScoredRun(c, r.asFound ?? null));
    const base = vendor ? figure(vendor) : r.asFound ? figure(r.asFound) : r.baselineHeld ? (ladder === 'memory' ? r.baselineHeld.memMhz : r.baselineHeld.smMhz) : null;
    if (base === null) continue;
    const source = vendor ? 'your tune through our route' : 'as found';
    const reference = vendor ? { mean: vendor.meanSmMhz ?? null, work: vendor.throughputGsps } : r.asFound ? { mean: r.asFound.meanSmMhz ?? null, work: r.asFound.score?.throughputGsps ?? null } : { mean: null, work: null };
    const rung = (ladder === 'memory' ? MEM_STEP_KHZ : CORE_STEP_KHZ) / 1000;
    let last: Additivity | null = null;
    for (const c of rungs.filter((x) => offsetOf(x, r.baseline) > 0)) {
      const held = figure(c);
      if (held === null) continue;
      const offset = offsetOf(c, r.baseline);
      const verdict = judgeAdditivity(held, base, offset, rung);
      if (verdict !== 'passed' && ladder === 'core' && gainedOnCap(c.meanSmMhz ?? null, reference.mean, meanClockNoiseMhz(null), c.throughputGsps, reference.work, throughputNoise(null))) {
        last = { ladder, passed: true, text: `${held} vs ${base} ${source} at the top of the curve (${signed(offset)} written), but ${c.meanSmMhz?.toFixed(0) ?? '?'} vs ${reference.mean?.toFixed(0) ?? '?'} MHz sustained and ${c.throughputGsps?.toFixed(2) ?? '?'} vs ${reference.work?.toFixed(2) ?? '?'} Gsteps/s: the offset counts on the cap` };
        break;
      }
      last = { ladder, passed: verdict === 'passed', text: verdict === 'undecided' ? `not yet shown: ${held} vs ${base} ${source} (${signed(offset)} written, within a bin); a second rung decides` : `${held} vs ${base} ${source} (${signed(offset)} written)` };
      if (verdict !== 'undecided') break;
    }
    if (last) out.push(last);
  }
  return out;
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

/**
 * Why the confidence is what it is, from the same inputs the collector rated it on
 * (TuneLadder.Confidence): every ladder converged on a failure or the card's own limit,
 * nothing above the baseline, a device loss or an invalid rung in the record, a ladder at the
 * driver's range, the clock ceiling or the top of the table, or a failed official run.
 */
export function confidenceWhy(r: Pick<TuneResult, 'stops' | 'rungs' | 'certified' | 'official'>): string {
  const reasons: string[] = [];
  const unconverged = r.stops.filter((s) => !converged(s.reason));
  if (r.certified.coreMhz === 0 && r.certified.memMhz === 0) reasons.push('nothing above the card as found held');
  for (const s of unconverged) reasons.push(`the ${s.ladder} ladder ended on ${STOP_TEXT[s.reason]} before finding a failure`);
  if (r.official && r.official.verdict !== 'stable') reasons.push('the official run failed');
  if (r.rungs.some((c) => c.verdict === 'device-lost')) reasons.push('a driver reset is in the record');
  if (r.rungs.some((c) => c.verdict === 'invalid')) reasons.push('an invalid rung is in the record');
  const limit = r.stops.find((s) => s.reason === 'driver-max' || s.reason === 'ceiling' || s.reason === 'top-of-table');
  if (limit && reasons.length === 0) reasons.push(`the ${limit.ladder} ladder ran into ${STOP_TEXT[limit.reason]}`);
  return reasons.length ? reasons.join('; ') : 'every ladder found its failure and bisected it with nothing in the way';
}

/** Something of Tune's is on the card, or a crash revert waits to be acknowledged. */
export const revertable = (s: TuneStatus) => s.state !== 'IDLE';

/**
 * What Stop left behind, for the line under the buttons (polish 3 item 5: Stop must show the
 * restore outcome): the collector restores the baseline as the run ends and the state file
 * says whether it took. Null while no stopped run is the last one.
 */
export function stopOutcome(status: TuneStatus, run: TuneRun | null): { tone: Tone; text: string } | null {
  if (!run || run.state !== 'stopped') return null;
  const closing = run.error ?? run.lastEvent;
  if (status.state === 'PENDING') return { tone: 'bad', text: `Stopped, but the baseline is not back on the card: ${closing || 'the driver refused the restore'}. Revert tries again.` };
  return { tone: 'ok', text: `Stopped; the card is back as it was found${closing ? ` (${closing})` : ''}.` };
}

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
