import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api, ipcErrorMessage } from '../../api';
import type { GpuFacts, SensorRow, StaticSnapshot } from '../../collector-types';
import { SensorIndex } from '../monitor/sensors';
import { cpuLayout, type CoreIds } from '../monitor/cpuLayout';
import { cachedSensorMeta, cachedSnapshot } from '../monitor/cache';
import { decodeReasons } from '../monitor/reasons';
import { gpuTitle } from '../monitor/vendors';
import { memGbpsOf, nvmlMemOffsetMhz } from '../advisor/thisCard';

/** The table polls the collector's latest row rather than subscribing to ticks, so opening it over the Monitor page cannot end that page's subscription (the main process keeps one flag). */
const POLL_MS = 500;

interface Props {
  connected: boolean;
}

export interface CoreRow {
  label: string;
  nominalMhz: number | null;
  effectiveMhz: number | null;
  loadPct: number | null;
}

const value = (row: SensorRow | null, id: string | undefined): number | null => {
  if (!row || !id) return null;
  const v = row.values[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** One row per physical core: the nominal clock the core reports, the effective clock (the honest figure: a parked core reads ~0), the mean load of its threads. */
export function coreRows(cores: CoreIds[], row: SensorRow | null): CoreRow[] {
  return cores.map((c) => {
    const loads = c.loads.map((id) => value(row, id)).filter((v): v is number => v !== null);
    return {
      label: `${c.type ? `${c.type}-` : ''}Core #${c.n}`,
      nominalMhz: value(row, c.nominal),
      effectiveMhz: value(row, c.effective),
      loadPct: loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null
    };
  });
}

const mhz = (v: number | null) => (v === null ? '' : `${Math.round(v)}`);
const pct = (v: number | null) => (v === null ? '' : `${Math.round(v)} %`);

/** Plain text of the table, for the Copy button and a forum post. */
export function clocksText(cpuName: string, rows: CoreRow[], gpus: GpuFacts[]): string {
  const lines = [`${cpuName.trim()} — core clocks (MHz nominal / effective, load)`];
  for (const r of rows) lines.push(`${r.label.padEnd(12)} ${mhz(r.nominalMhz).padStart(5)} / ${mhz(r.effectiveMhz).padStart(5)}  ${pct(r.loadPct)}`);
  for (const g of gpus) {
    lines.push('', `${gpuTitle(g)} — SM ${g.clocks.smMhz} MHz · memory ${g.clocks.memMhz} MHz (${memGbpsOf(g.clocks.memMhz).toFixed(1)} Gbps) · ${g.temperatureC} °C · ${Math.round(g.powerMw / 1000)} W · limits: ${decodeReasons(g.clocksEventReasons.raw).map((x) => x.label).join(', ')}`);
    // The memory offset in NVML MHz beside the NVML ceilings (the driver counts it on the effective rate, twice NVML's clock).
    if (g.clockOffsets) lines.push(`driver ceilings SM ${g.clockOffsets.maxClockSmMhz ?? '?'} · memory ${g.clockOffsets.maxClockMemMhz ?? '?'} MHz · offsets ${g.clockOffsets.smMhz ?? '?'} / ${nvmlMemOffsetMhz(g.clockOffsets) ?? '?'}${g.clockOffsets.memMhz !== null ? ` (+${g.clockOffsets.memMhz} on the effective rate)` : ''}`);
    if (g.pstateDeltas) lines.push(`NVAPI P0 deltas core ${g.pstateDeltas.coreMhz} · memory ${g.pstateDeltas.memMhz} MHz`);
  }
  return lines.join('\n');
}

/** About → Clocks (plan 17): a live per-core and GPU clock table, 2 Hz, plain DOM. */
export const ClocksTool: React.FC<Props> = ({ connected }) => {
  const [index, setIndex] = useState<SensorIndex | null>(null);
  const [snapshot, setSnapshot] = useState<StaticSnapshot | null>(null);
  const [row, setRow] = useState<SensorRow | null>(null);
  const [gpus, setGpus] = useState<GpuFacts[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!api || !connected) return;
    let live = true;
    cachedSensorMeta()
      .then((m) => live && setIndex(new SensorIndex(m)))
      .catch((e) => live && setError(ipcErrorMessage(e)));
    cachedSnapshot()
      .then((s) => live && setSnapshot(s))
      .catch(() => {
        /* the core count falls back to the sensor tree */
      });
    const c = api.collector;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const [latest, g] = await Promise.all([c.sensorsLatest(), c.gpu()]);
        if (!live) return;
        setRow(latest);
        setGpus(g);
        setError('');
      } catch (e) {
        if (live) setError(ipcErrorMessage(e));
      } finally {
        busy = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [connected]);

  const layout = useMemo(() => (index ? cpuLayout(index, snapshot?.cpu) : null), [index, snapshot]);
  const rows = useMemo(() => (layout ? coreRows(layout.cores, row) : []), [layout, row]);
  const cpuName = snapshot?.cpu.name ?? (layout && index ? index.hardwareName(index.hardware(/^cpu$/i)[0]) ?? 'CPU' : 'CPU');
  const avg = value(row, layout?.avgEffective);

  const copy = () => {
    navigator.clipboard
      .writeText(clocksText(cpuName, rows, gpus))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setError('Could not copy to the clipboard'));
  };

  if (!connected) return <p className="text-mini text-studio-muted">The clock table reads the collector; it is not connected.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mini text-studio-text">{cpuName.trim()}</span>
        {avg !== null && <span className="text-micro text-studio-subtle">average effective {Math.round(avg)} MHz</span>}
        <span className="flex-1" />
        <button className="btn h-6" onClick={copy} disabled={rows.length === 0}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy table'}
        </button>
      </div>
      {error && <p className="text-micro text-rose-300">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-mini text-studio-subtle">{index ? 'No per-core clock sensors in the tree (PawnIO not usable?).' : 'Reading the sensor list…'}</p>
      ) : (
        <div className="grid gap-x-6 sm:grid-cols-2">
          {[rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))].map((half, n) => (
            <table key={n} className="w-full text-mini figure">
              <thead>
                <tr className="label">
                  <th className="text-left font-medium py-0.5">Core</th>
                  <th className="text-right font-medium py-0.5">Nominal</th>
                  <th className="text-right font-medium py-0.5">Effective</th>
                  <th className="text-right font-medium py-0.5">Load</th>
                </tr>
              </thead>
              <tbody>
                {half.map((r) => (
                  <tr key={r.label} className="border-t border-studio-border/60">
                    <td className="py-0.5 text-studio-muted font-sans">{r.label}</td>
                    <td className="py-0.5 text-right text-studio-subtle">{mhz(r.nominalMhz)}</td>
                    <td className="py-0.5 text-right text-studio-text">{mhz(r.effectiveMhz)}</td>
                    <td className="py-0.5 text-right text-studio-muted">{pct(r.loadPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
      {gpus.map((g) => (
        <div key={g.index} className="rounded-md border border-studio-border bg-studio-panel/60 px-3 py-2 space-y-1">
          <div className="text-mini text-studio-text">{gpuTitle(g)}</div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-4 gap-y-1 text-mini figure">
            <span>
              <span className="label mr-2">SM</span>
              {g.clocks.smMhz} MHz
            </span>
            <span>
              <span className="label mr-2">Memory</span>
              {g.clocks.memMhz} MHz · {memGbpsOf(g.clocks.memMhz).toFixed(1)} Gbps
            </span>
            <span>
              <span className="label mr-2">Board</span>
              {Math.round(g.powerMw / 1000)} W · {g.temperatureC} °C
            </span>
            <span>
              <span className="label mr-2">Limits</span>
              <span className="font-sans">{decodeReasons(g.clocksEventReasons.raw).map((x) => x.label).join(', ')}</span>
            </span>
            {g.clockOffsets && (
              <span>
                <span className="label mr-2">Ceilings</span>
                {g.clockOffsets.maxClockSmMhz ?? '?'} / {g.clockOffsets.maxClockMemMhz ?? '?'} MHz
              </span>
            )}
            {g.pstateDeltas && (
              <span>
                <span className="label mr-2">P0 deltas</span>
                {g.pstateDeltas.coreMhz >= 0 ? '+' : ''}
                {g.pstateDeltas.coreMhz} / {g.pstateDeltas.memMhz >= 0 ? '+' : ''}
                {g.pstateDeltas.memMhz} MHz
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
