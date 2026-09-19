import React, { useState } from 'react';
import { Pencil } from 'lucide-react';
import { PSU_RATINGS, PSU_TRANSIENT_NOTE, type PsuRating } from '../../analysis/psu';
import type { Settings } from '../../settings';
import { updateSettings, useSettings } from '../useSettings';

/** The supply as set, or null until both fields are: a wattage without a badge cannot give a wall figure. */
export function psuOf(s: Settings): { watts: number; rating: PsuRating } | null {
  return s.psuWatts !== null && s.psuWatts > 0 && s.psuRating !== null ? { watts: s.psuWatts, rating: s.psuRating } : null;
}

/** "Gold", "Titanium", "80 PLUS" for the plain badge, "no badge" for none: the word that fits after "est.,". */
export function psuBadge(rating: PsuRating): string {
  if (rating === 'none') return 'no badge';
  if (rating === 'white') return '80 PLUS';
  return rating.charAt(0).toUpperCase() + rating.slice(1);
}

const field = 'h-6 px-1.5 rounded-control border border-studio-border bg-studio-bg text-mini text-studio-text figure outline-none focus:border-studio-border-light';

/**
 * The PSU asked once (plan section 13): wattage and 80 PLUS badge, inline where the
 * figure is used, on the stats card's PSU tile and under the Monitor's SYSTEM POWER row.
 * Set, it shows "1300 W · Platinum" with a pencil; unset, the one affordance that leads here.
 * The select opens on Gold, the commonest retail badge; nothing is stored until Save.
 */
export const PsuForm: React.FC = () => {
  const settings = useSettings();
  const psu = psuOf(settings);
  const [editing, setEditing] = useState(false);
  const [watts, setWatts] = useState(settings.psuWatts === null ? '' : String(settings.psuWatts));
  const [rating, setRating] = useState<PsuRating>(settings.psuRating ?? 'gold');
  const valid = Number.isFinite(Number(watts)) && Number(watts) > 0;

  const open = () => {
    setWatts(settings.psuWatts === null ? '' : String(settings.psuWatts));
    setRating(settings.psuRating ?? 'gold');
    setEditing(true);
  };
  const save = () => {
    if (!valid) return;
    updateSettings({ psuWatts: Math.round(Number(watts)), psuRating: rating });
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap" role="group" aria-label="Power supply">
        <input
          className={`${field} w-16`}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="watts"
          autoFocus
          value={watts}
          onChange={(e) => setWatts(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="PSU rated watts"
        />
        <span className="text-[10px] text-studio-subtle">W</span>
        <select className={field} value={rating} onChange={(e) => setRating(e.target.value as PsuRating)} aria-label="80 PLUS rating">
          {PSU_RATINGS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <button className="btn btn-accent h-6" disabled={!valid} onClick={save}>
          Save
        </button>
        <button className="btn h-6" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </span>
    );
  }
  if (!psu) {
    return (
      <button className="btn h-6 px-1.5 text-studio-text" onClick={open} title="Your supply's rated watts and 80 PLUS badge: the wall-side figure and the headroom verdict need them">
        Set your PSU
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap min-w-0" title={PSU_TRANSIENT_NOTE}>
      <span className="figure text-mini text-studio-text">
        {psu.watts} W · {psuBadge(psu.rating)}
      </span>
      <button className="text-studio-subtle hover:text-studio-text" onClick={open} title="Change the PSU" aria-label="Change the PSU">
        <Pencil size={10} />
      </button>
    </span>
  );
};
