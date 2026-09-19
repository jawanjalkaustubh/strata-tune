import type { Tone } from './Pill';

export interface PinReading {
  n: number;
  amps?: number;
  volts?: number;
  watts?: number;
}

export interface PinAnalysis {
  /** Pins with a current reading. */
  live: number;
  meanA: number;
  minA: number;
  maxA: number;
  /** max − min, in amps and as a share of the mean. */
  spreadA: number;
  spreadPct: number;
  maxOverMean: number;
  tone: Tone;
  /** Index of the pin carrying the most current, for the diagram to single out. */
  maxIndex: number;
}

/** 12VHPWR / 12V-2x6 per-pin continuous rating; the connector's 600 W is 8.3 A per pin. */
export const PIN_LIMIT_A = 9.5;
export const CONNECTOR_LIMIT_W = 600;
/** Below this (about 145 W) the connector is idle and the spread is noise on the ADC, not a plug fault. */
const IDLE_MEAN_A = 2;

/**
 * The two numbers GPU Tweak never computes (plan 17a): spread and max/mean.
 * Emerald at a spread up to 10 % of the mean, amber to 20 %, red above, and
 * red the moment any pin reaches its 9.5 A rating. The plan's draft said
 * "any pin above 8 A", which would paint a 5090 red at its normal 600 W
 * (8.3 A per pin); the continuous rating is the honest red line.
 */
export function analysePins(pins: PinReading[]): PinAnalysis {
  const live = pins.map((p, i) => ({ a: p.amps, i })).filter((x): x is { a: number; i: number } => x.a !== undefined && Number.isFinite(x.a));
  if (live.length === 0) return { live: 0, meanA: 0, minA: 0, maxA: 0, spreadA: 0, spreadPct: 0, maxOverMean: 0, tone: 'idle', maxIndex: -1 };
  const meanA = live.reduce((s, x) => s + x.a, 0) / live.length;
  let max = live[0];
  let min = live[0];
  for (const x of live) {
    if (x.a > max.a) max = x;
    if (x.a < min.a) min = x;
  }
  const spreadA = max.a - min.a;
  const spreadPct = meanA > 0 ? (spreadA / meanA) * 100 : 0;
  const maxOverMean = meanA > 0 ? max.a / meanA : 0;
  let tone: Tone;
  if (max.a >= PIN_LIMIT_A) tone = 'bad';
  else if (meanA < IDLE_MEAN_A) tone = 'idle';
  else if (spreadPct > 20) tone = 'bad';
  else if (spreadPct > 10) tone = 'warn';
  else tone = 'ok';
  return { live: live.length, meanA, minA: min.a, maxA: max.a, spreadA, spreadPct, maxOverMean, tone, maxIndex: max.i };
}
