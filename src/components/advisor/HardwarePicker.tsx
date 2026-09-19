import React from 'react';
import type { PickerChoice } from './hardware';

interface Props {
  gpuNames: string[];
  choice: PickerChoice;
  onChange: (c: PickerChoice) => void;
}

const field = 'h-7 px-2 rounded-control border border-studio-border bg-studio-surface text-mini text-studio-text figure focus:border-studio-border-light';

/** Standalone inputs when no collector is connected: spec numbers stand in for the snapshot. */
export const HardwarePicker: React.FC<Props> = ({ gpuNames, choice, onChange }) => {
  const num = (raw: string, fallback: number | null) => {
    const v = Number(raw);
    return raw.trim() === '' ? null : Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="label">GPU (spec)</span>
        <select className={`${field} min-w-[14rem]`} value={choice.gpuName} onChange={(e) => onChange({ ...choice, gpuName: e.target.value })}>
          {gpuNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">RAM GiB</span>
        <input className={`${field} w-20`} inputMode="numeric" value={choice.ramGiB} onChange={(e) => onChange({ ...choice, ramGiB: num(e.target.value, choice.ramGiB) ?? choice.ramGiB })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Model drive free GiB</span>
        <input
          className={`${field} w-24`}
          inputMode="numeric"
          placeholder="unknown"
          value={choice.freeDiskGiB ?? ''}
          onChange={(e) => onChange({ ...choice, freeDiskGiB: num(e.target.value, choice.freeDiskGiB) })}
        />
      </label>
    </div>
  );
};
