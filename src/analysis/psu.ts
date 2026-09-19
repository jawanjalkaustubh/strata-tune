import table from '../data/psu.json';

/**
 * Wall-side power and the PSU verdict (master plan §13, Phase 6). The DC side is
 * measured and estimated by power.ts; this file turns it into what the meter at
 * the wall reads and answers "do I need a bigger supply" from the user's own peaks.
 *
 * Efficiency curves are the 80 PLUS programme's minimums (CLEAResult / Ecos
 * Consulting, 115 V internal non-redundant), per cent of rated load:
 *
 *   rating     10 %   20 %   50 %  100 %
 *   80 PLUS      -     80     80     80
 *   Bronze       -     82     85     82
 *   Silver       -     85     88     85
 *   Gold         -     87     90     87
 *   Platinum     -     90     92     89
 *   Titanium    90     92     94     90
 *
 * Only Titanium has a 10 % requirement; the other 10 % points in psu.json are
 * modelled (five to eight points under the 20 % figure, which is where measured
 * units land) and flagged as such. Real units beat their minimums; the curve is a
 * floor, so the wall figure errs high and carries the "estimated" tag like every
 * modelled part of the system total.
 */
export type PsuRating = 'none' | 'white' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'titanium';

interface RatingRow {
  id: PsuRating;
  label: string;
  efficiencyPercent: number[];
  modelledTenPercent: boolean;
}

const LOADS = (table.loadPercent as number[]).map((p) => p / 100);
const ROWS = table.ratings as RatingRow[];
const rowFor = (rating: PsuRating) => ROWS.find((r) => r.id === rating) ?? ROWS[0];

export const PSU_RATINGS: { id: PsuRating; label: string }[] = ROWS.map((r) => ({ id: r.id, label: r.label }));

/** Below the first table point the curve keeps falling: a supply at 2 % load is well under its 10 % figure. */
const LOW_LOAD_DROP = 0.2;
const FLOOR = 0.5;

/**
 * Efficiency (0..1) at a fraction of rated load, interpolated linearly between the
 * table points; flat past 100 % (the supply is over-rated there and the verdict
 * says so), sloping down to the floor under 10 %.
 */
export function efficiency(loadFraction: number, rating: PsuRating): number {
  const curve = rowFor(rating).efficiencyPercent.map((p) => p / 100);
  const f = Math.max(0, loadFraction);
  if (f >= LOADS[LOADS.length - 1]) return curve[curve.length - 1];
  if (f <= LOADS[0]) return Math.max(FLOOR, curve[0] - (LOADS[0] - f) / LOADS[0] * LOW_LOAD_DROP);
  for (let i = 1; i < LOADS.length; i++) {
    if (f <= LOADS[i]) {
      const t = (f - LOADS[i - 1]) / (LOADS[i] - LOADS[i - 1]);
      return curve[i - 1] + (curve[i] - curve[i - 1]) * t;
    }
  }
  return curve[curve.length - 1];
}

/** What the wall meter reads for a DC draw from a supply of this size and badge. */
export function wallWatts(dcWatts: number, ratedW: number, rating: PsuRating): number {
  if (!(dcWatts > 0) || !(ratedW > 0)) return 0;
  return dcWatts / efficiency(dcWatts / ratedW, rating);
}

/** Stated in the UI beside every PSU figure, never as a footnote (plan §13). */
export const PSU_TRANSIENT_NOTE =
  'Sensors are read ten times a second; a power supply trips its over-current protection on spikes that last microseconds. A clean graph does not prove a healthy supply.';

export type PsuBand = 'over' | 'tight' | 'good' | 'generous';

export interface PsuVerdict {
  band: PsuBand;
  /** Peak sustained DC draw as a fraction of the rating. */
  loadFraction: number;
  headroomW: number;
  /** For 'over' and 'tight': the smallest common size that keeps the peak at or under 70 % of the rating. */
  recommendedW: number | null;
  sentence: string;
}

/** Common retail sizes, so the recommendation is a supply the user can buy. */
const SIZES = [450, 550, 650, 750, 850, 1000, 1200, 1300, 1600];
/** Peak at or under 70 % of the rating leaves room for the millisecond excursions modern cards draw above their sustained power; the Monitor speaks the verdict only past it. */
export const COMFORTABLE = 0.7;
/** Above 80 % of the rating a card's excursions reach the rating itself. */
const TIGHT = 0.8;
/** Under 40 % the supply is fine, just bigger than the machine needs. */
const GENEROUS = 0.4;

/**
 * "Do I need a bigger PSU", from the peak sustained DC draw seen in the user's own
 * sessions against the rated wattage. Bands by load fraction: over 100 % the supply is
 * already being asked for more than its rating; 80–100 % is tight; 40–80 % is the
 * range supplies are built for; under 40 % is generous. Sustained is the operative
 * word: the transient note travels with every verdict.
 */
export function psuVerdict(peakSustainedDcW: number, ratedW: number): PsuVerdict {
  const loadFraction = ratedW > 0 ? peakSustainedDcW / ratedW : Infinity;
  const headroomW = Math.round(ratedW - peakSustainedDcW);
  const recommendedW = SIZES.find((s) => peakSustainedDcW / s <= COMFORTABLE) ?? Math.ceil(peakSustainedDcW / COMFORTABLE / 100) * 100;
  const peak = Math.round(peakSustainedDcW);
  const pct = Math.round(loadFraction * 100);
  if (loadFraction > 1) {
    return {
      band: 'over', loadFraction, headroomW, recommendedW,
      sentence: `Your parts drew ${peak} W sustained, more than the ${ratedW} W the supply is rated for. A ${recommendedW} W supply is the fix, not a setting.`
    };
  }
  if (loadFraction > TIGHT) {
    return {
      band: 'tight', loadFraction, headroomW, recommendedW,
      sentence: `Peak sustained draw was ${peak} W, ${pct} % of the ${ratedW} W rating. That leaves ${headroomW} W for the spikes a graphics card adds on top; a ${recommendedW} W supply would be comfortable.`
    };
  }
  if (loadFraction < GENEROUS) {
    return {
      band: 'generous', loadFraction, headroomW, recommendedW: null,
      sentence: `Peak sustained draw was ${peak} W, ${pct} % of the ${ratedW} W rating. The supply is bigger than this machine needs; that costs a little efficiency at idle and nothing else.`
    };
  }
  return {
    band: 'good', loadFraction, headroomW, recommendedW: null,
    sentence: `Peak sustained draw was ${peak} W, ${pct} % of the ${ratedW} W rating: ${headroomW} W of headroom, in the range supplies are built for.`
  };
}
