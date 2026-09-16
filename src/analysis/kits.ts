import kits from '../data/kits.json';

/**
 * Rated memory speed from the kit part number (master plan §7). WMI's Speed
 * field reports the configured speed on this board, not the SPD rating, so the
 * EXPO check has to read the rating out of the part number instead. Each row of
 * kits.json is one vendor's naming scheme; a part no row matches is unknown, and
 * unknown is never a flag (plan risk R5).
 */
export type KitProfile = 'xmp' | 'jedec';

interface KitRule {
  vendor: string;
  pattern: string;
  /** 'capture' when the group is the MT/s, 'captureX100' when it is the MT/s divided by 100 (KF560 → 6000). */
  speedFrom: 'capture' | 'captureX100';
  /** 'xmp' kits carry an XMP/EXPO profile to enable; 'jedec' parts run at whatever the platform allows. */
  profile: KitProfile;
  note: string;
}

export interface RatedKit {
  vendor: string;
  ratedMts: number;
  profile: KitProfile;
}

const RULES = (kits as KitRule[]).map(rule => ({ ...rule, regex: new RegExp(rule.pattern, 'i') }));

/** DDR4 starts at 1600; nothing sold reaches 12000. A capture outside this is a misread, not a kit. */
const MIN_MTS = 1600;
const MAX_MTS = 12000;

/**
 * One of the two identical DIMMs here returns SPD junk after the part number
 * (collector README, carried into Phase 1), so the string is cut at the first
 * byte that is not printable ASCII.
 */
export function cleanPartNumber(raw: string): string {
  const printable = /^[\x20-\x7E]*/.exec(raw.trim());
  return (printable ? printable[0] : '').trim().toUpperCase();
}

export function ratedSpeedFor(partNumber: string): RatedKit | null {
  const part = cleanPartNumber(partNumber);
  if (!part) return null;
  for (const rule of RULES) {
    const m = rule.regex.exec(part);
    if (!m) continue;
    const mts = Number(m[1]) * (rule.speedFrom === 'captureX100' ? 100 : 1);
    if (mts >= MIN_MTS && mts <= MAX_MTS) return { vendor: rule.vendor, ratedMts: mts, profile: rule.profile };
  }
  return null;
}
