import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { updateSettings, useSettings } from '../useSettings';
import { cpuLimits } from './cpuLimits';
import { CPU_TUNING_FIELDS, cpuTuningDraft, cpuTuningPatch, isSet, type CpuTuningDraft, type CpuTuningKey } from './cpuTuning';

interface Props {
  cpuName?: string;
  /** Plan 17d row 2: a laptop's limits are set in the vendor app (Armoury Crate, Legion Vantage, Omen Gaming Hub), not the BIOS, and the fields say so. */
  laptop?: boolean;
  layoutIsDefault: boolean;
  onClose: () => void;
}

const INPUT = 'figure text-[12px] h-7 px-2 rounded bg-studio-bg border border-studio-border-light text-studio-text outline-none';
const EMPTY: CpuTuningDraft = { cpuPptW: '', cpuTdcA: '', cpuEdcA: '', coAllCore: '', coPerCore: '' };

/** The tag every consumer of a typed value carries (the bar tick, the header strip, the audit), so nobody reads it as a sensor. */
const SetByYou: React.FC = () => <span className="label text-[10px] text-studio-accent whitespace-nowrap">set by you</span>;

/**
 * The Monitor page's gear menu: the CPU tuning the user set in the BIOS — PPT, TDC, EDC and
 * Curve Optimizer — which no sensor on Zen 5 can read (docs/dependencies.md), so it is typed
 * here once and tagged "set by you" wherever it is used: the Package bar's limit tick, the
 * header strip and the audit's CPU rules (polish 3 items 2–3). Blank returns a field to "not
 * set": the bar falls back to the part's stock figure, the rules to their generic advice.
 * The layout reset lives here too. Enter saves every field, Escape closes.
 */
export const MonitorMenu: React.FC<Props> = ({ cpuName, laptop = false, layoutIsDefault, onClose }) => {
  const settings = useSettings();
  const limits = cpuLimits(cpuName);
  const [draft, setDraft] = useState<CpuTuningDraft>(() => cpuTuningDraft(settings));
  const first = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    first.current?.focus();
    // A press outside the menu closes it; the gear is left to its own toggle.
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('[data-menu-anchor]')) onClose();
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [onClose]);
  const powerName = limits.powerName ?? 'PPT';
  // TDC, EDC and the Curve Optimizer are PBO settings; an Intel part shows its PL2 alone.
  const amd = powerName === 'PPT';
  const fields = CPU_TUNING_FIELDS.filter((f) => amd || !f.amd);
  const stock = limits.powerW ? `; stock ${powerName} is ${limits.powerW} W` : '';
  const help = laptop
    ? `No sensor reads the power mode a laptop's vendor app (Armoury Crate, Legion Vantage, Omen Gaming Hub) sets: enter the ${powerName} your mode runs at${stock}${amd ? ' and any Curve Optimizer (CO) it applies' : ''}. The Package bar and the audit judge against it. Blank means not set.`
    : amd
      ? `No sensor reads these (no SMU access on Zen 5): enter what you set in the BIOS or Ryzen Master${stock}. The Package bar judges against the PPT, and the audit's CPU advice knows a Curve Optimizer (CO) you already run. Blank means not set.`
      : `No sensor reads a raised limit: enter the ${powerName} you set in the BIOS${stock}. The Package bar and the audit judge against it. Blank means not set.`;
  const dirty = Object.values(draft).some((v) => v !== '');
  const set = (key: keyof CpuTuningDraft, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const save = () => {
    updateSettings(cpuTuningPatch(draft));
    onClose();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') onClose();
  };
  const stored = (key: CpuTuningKey) => isSet(settings[key]);
  return (
    <div ref={box} className="absolute right-0 top-8 z-20 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-md border border-studio-border-light bg-studio-panel p-3 space-y-3" role="dialog" aria-label="Monitor settings">
      <div className="flex items-center justify-between">
        <span className="label text-studio-text">Monitor settings</span>
        <button className="btn-icon w-6 h-6" onClick={onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <fieldset className="space-y-2">
        <legend className="label mb-1.5">{laptop ? 'CPU power mode you set in the vendor app' : 'CPU tuning you set in BIOS'}</legend>
        {fields.map((f, i) => (
          <label key={f.key} className="grid grid-cols-[7rem_6rem_1fr] items-center gap-x-2">
            <span className="text-mini text-studio-muted">{f.key === 'cpuPptW' ? powerName : f.label}</span>
            <input
              ref={i === 0 ? first : undefined}
              type="number"
              min={f.limit ? 1 : undefined}
              step={1}
              className={`${INPUT} w-full`}
              placeholder={f.key === 'cpuPptW' && limits.powerW ? `${limits.powerW} stock` : f.limit ? '' : 'e.g. −30'}
              aria-label={f.key === 'cpuPptW' ? `${powerName} (${f.unit})` : f.unit ? `${f.label} (${f.unit})` : 'Curve Optimizer all-core'}
              value={draft[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              onKeyDown={keys}
            />
            <span className="flex items-center gap-2 min-w-0">
              {f.unit && <span className="figure text-[12px] text-studio-muted">{f.unit}</span>}
              {stored(f.key) && <SetByYou />}
            </span>
          </label>
        ))}
        {amd && (
          // A note is longer than a figure: the whole width, under its label, so it is read and not scrolled.
          <label className="block space-y-1">
            <span className="flex items-center gap-2">
              <span className="text-mini text-studio-muted">CO per core</span>
              {!!settings.coPerCore?.trim() && <SetByYou />}
            </span>
            <input
              type="text"
              className={`${INPUT} w-full`}
              placeholder="your note, e.g. −30, cores 3 and 7 at −20"
              aria-label="Curve Optimizer per-core note"
              value={draft.coPerCore}
              onChange={(e) => set('coPerCore', e.target.value)}
              onKeyDown={keys}
            />
          </label>
        )}
        <p className="text-micro text-studio-subtle leading-relaxed">{help}</p>
        <div className="flex items-center justify-end gap-2">
          <button className="btn" onClick={() => setDraft(EMPTY)} disabled={!dirty}>
            Clear
          </button>
          <button className="btn btn-accent" onClick={save}>
            Save
          </button>
        </div>
      </fieldset>
      <div className="flex items-center justify-between gap-3 border-t border-studio-border pt-2">
        <span className="text-micro text-studio-subtle">Drag a header to move a panel, its corner to resize.</span>
        <button className="btn shrink-0" disabled={layoutIsDefault} onClick={() => updateSettings({ monitorLayout: null })}>
          Reset layout
        </button>
      </div>
    </div>
  );
};
