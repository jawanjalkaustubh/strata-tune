import React from 'react';
import type { HeldClocks, PstateDeltas } from '../../collector-types';
import { VENDOR_MATCH_MHZ, vendorMatches, vendorMemoryNvml, VENDOR_MEMORY_FACTOR } from '../../analysis/tune';
import { updateSettings, useSettings } from '../useSettings';

export interface VendorCheck {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/**
 * The cross-check the collector repeats before its first write (plan section 16, rule 2), shown
 * as the value is typed: the memory offset entered against what the card holds above the
 * driver's ceiling. The core cannot be checked under a power cap; the additivity check guards
 * it. Without a held memory clock (nothing has loaded the card yet) the line says so.
 */
export function vendorCheck(memory: { value: number; unit: 'effective' | 'nvml' } | null, held: HeldClocks | null, ceilingMemMhz: number | null, deltas: PstateDeltas | null = null): VendorCheck {
  // Our own route holds the tune (a hunt restored it, and the driver keeps P0 deltas across a reboot): nothing is foreign and nothing needs typing.
  if (deltas && (deltas.coreMhz !== 0 || deltas.memMhz !== 0) && (!held || ceilingMemMhz === null || vendorMatches(held.memMhz, ceilingMemMhz, deltas.memMhz))) {
    return { tone: 'ok', text: `The driver reads your tune through our route: core +${deltas.coreMhz} · memory +${deltas.memMhz} (about +${deltas.memMhz * VENDOR_MEMORY_FACTOR} on the slider). The hunt starts from it; your vendor tool's Apply can land short while our route holds it — zero and re-apply there if the monitor reads low.` };
  }
  if (!memory || memory.value === 0) {
    // The tick already shows a memory clock above the driver's ceiling: another tool is tuning the card, and the hunt would refuse; say so before Find.
    if (held && ceilingMemMhz !== null && held.memMhz > ceilingMemMhz + VENDOR_MATCH_MHZ) {
      const above = held.memMhz - ceilingMemMhz;
      return { tone: 'warn', text: `Your card holds ${held.memMhz} MHz memory, ${above} above the driver's ${ceilingMemMhz} ceiling: another tool is tuning it (about +${above * VENDOR_MEMORY_FACTOR} on its slider). Enter what that tool's sliders show before the hunt, or it is refused before anything is written.` };
    }
    return { tone: 'muted', text: 'Nothing entered: a stock card is hunted from its own offsets; a card tuned by a tool whose values are not entered here is refused before anything is written.' };
  }
  const nvml = vendorMemoryNvml(memory);
  if (!held || ceilingMemMhz === null) return { tone: 'muted', text: `+${nvml} MHz in our units; not checked yet, the held memory clock is read under load and the hunt checks it before anything is written.` };
  const holds = held.memMhz - ceilingMemMhz;
  return vendorMatches(held.memMhz, ceilingMemMhz, nvml)
    ? { tone: 'ok', text: `Matches the ${held.memMhz} MHz the card holds (${ceilingMemMhz} + ${holds}; +${nvml} in our units).` }
    : { tone: 'warn', text: `Does not match: the card holds ${held.memMhz} MHz, ${holds > 0 ? `${ceilingMemMhz} + ${holds}` : 'the driver ceiling'}, not ${ceilingMemMhz} + ${nvml}. Is the tune applied in the vendor tool?` };
}

interface Props {
  /** The vendor values the last result climbed on top of, the prefill when the settings hold none. */
  lastRun: PstateDeltas | null;
  /** The driver's own P0 deltas: when our route holds the tune they are the prefill and the check says so. */
  deltas?: PstateDeltas | null;
  held: HeldClocks | null;
  ceilingMemMhz: number | null;
  disabled: boolean;
  /** Plan 17d: on a laptop the tune lives in the vendor app (Armoury Crate, Legion Vantage, Omen Gaming Hub) or Afterburner, and the question names them. */
  laptop?: boolean;
  /** Writes our 0 / 0 so the vendor tool's Apply owns the card again; offered while our route holds the tune. */
  onRelease?: () => void;
}

const parse = (raw: string): number | null => {
  const n = Number.parseInt(raw.replace(/\s|\+/g, ''), 10);
  return Number.isInteger(n) ? n : null;
};

/**
 * "What does your vendor tool show?" (plan section 16: a P0 delta write replaces the vendor
 * tool's offset, so the hunt writes vendor + step and restores vendor). Two fields, in the
 * tool's own units (core MHz; memory as GPU Tweak III's and Afterburner's sliders count it,
 * the effective rate, twice ours), remembered in the settings and sent with every start.
 */
export const VendorForm: React.FC<Props> = ({ lastRun, deltas = null, held, ceilingMemMhz, disabled, laptop = false, onRelease }) => {
  const s = useSettings();
  const ours = deltas && (deltas.coreMhz !== 0 || deltas.memMhz !== 0) ? deltas : null;
  const core = s.vendorCoreOffsetMhz ?? lastRun?.coreMhz ?? ours?.coreMhz ?? null;
  const memory = s.vendorMemoryOffset ?? (lastRun ? { value: lastRun.memMhz, unit: 'effective' as const } : ours ? { value: ours.memMhz * VENDOR_MEMORY_FACTOR, unit: 'effective' as const } : null);
  const check = vendorCheck(memory, held, ceilingMemMhz, ours);
  const tone = check.tone === 'ok' ? 'text-emerald-400' : check.tone === 'warn' ? 'text-amber-300' : 'text-studio-subtle';
  return (
    <div className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 space-y-1.5 min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-mini text-studio-text">{laptop ? 'What does your vendor app (Armoury Crate, Legion Vantage, Omen Gaming Hub) or Afterburner show?' : 'What does your vendor tool show?'}</span>
        <label className="inline-flex items-center gap-1.5 text-mini text-studio-muted">
          core +
          <input
            type="number"
            step={1}
            className="figure w-20 h-6 px-1.5 rounded border border-studio-border-light bg-studio-bg text-studio-text text-[12px] outline-none focus:border-studio-accent"
            value={core ?? ''}
            placeholder="0"
            disabled={disabled}
            aria-label="Vendor tool core offset, MHz"
            onChange={(e) => updateSettings({ vendorCoreOffsetMhz: parse(e.target.value) })}
          />
          MHz
        </label>
        <label className="inline-flex items-center gap-1.5 text-mini text-studio-muted">
          memory +
          <input
            type="number"
            step={2}
            className="figure w-24 h-6 px-1.5 rounded border border-studio-border-light bg-studio-bg text-studio-text text-[12px] outline-none focus:border-studio-accent"
            value={memory?.value ?? ''}
            placeholder="0"
            disabled={disabled}
            aria-label="Vendor tool memory offset, slider units"
            onChange={(e) => {
              const v = parse(e.target.value);
              updateSettings({ vendorMemoryOffset: v === null ? null : { value: v, unit: memory?.unit ?? 'effective' } });
            }}
          />
          <span title={`GPU Tweak III and Afterburner count the effective rate, ${VENDOR_MEMORY_FACTOR}× the clock NVML reports; a tool that shows the NVML clock is entered as NVML`}>(slider units)</span>
        </label>
        <label className="inline-flex items-center gap-1 text-micro text-studio-subtle">
          <input type="checkbox" className="accent-emerald-500" checked={memory?.unit === 'nvml'} disabled={disabled || !memory} onChange={(e) => memory && updateSettings({ vendorMemoryOffset: { value: memory.value, unit: e.target.checked ? 'nvml' : 'effective' } })} />
          my tool shows the NVML clock
        </label>
      </div>
      <p className={`text-micro whitespace-normal break-words ${tone}`}>
        {check.text}
        {ours && onRelease && (
          <button className="btn ml-2 align-middle" disabled={disabled} onClick={onRelease} title="Writes our offsets back to 0 / 0 (nothing else changes); then press Apply in your vendor tool and its write lands in full">
            Release to vendor tool
          </button>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-mini text-studio-muted" title="Plan section 16: your own caution for a night run. A rung whose predicted clock would pass the cap is not written and the ladder ends with 'stopped at your cap'. Empty is no cap.">
          Never test above
        </span>
        <label className="inline-flex items-center gap-1.5 text-mini text-studio-muted">
          core
          <input
            type="number"
            step={5}
            min={0}
            className="figure w-20 h-6 px-1.5 rounded border border-studio-border-light bg-studio-bg text-studio-text text-[12px] outline-none focus:border-studio-accent"
            value={s.coreCapMhz ?? ''}
            placeholder="no cap"
            disabled={disabled}
            aria-label="Never test above this SM clock, MHz"
            onChange={(e) => updateSettings({ coreCapMhz: parse(e.target.value) })}
          />
          MHz
        </label>
        <label className="inline-flex items-center gap-1.5 text-mini text-studio-muted">
          memory
          <input
            type="number"
            step={5}
            min={0}
            className="figure w-20 h-6 px-1.5 rounded border border-studio-border-light bg-studio-bg text-studio-text text-[12px] outline-none focus:border-studio-accent"
            value={s.memCapMhz ?? ''}
            placeholder="no cap"
            disabled={disabled}
            aria-label="Never test above this memory clock, NVML MHz"
            onChange={(e) => updateSettings({ memCapMhz: parse(e.target.value) })}
          />
          MHz <span className="text-micro text-studio-subtle">(NVML clocks, as the monitor shows them)</span>
        </label>
      </div>
    </div>
  );
};
