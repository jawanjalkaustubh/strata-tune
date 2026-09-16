import React, { useMemo } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Bar, toneByLimit, toneByThresholds } from './Bar';
import { boardRails, railTone } from './rails';
import { fanState } from './fans';
import { vendorOf } from './vendors';
import { cpuLimits } from './cpuLimits';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
  panel?: PanelChrome;
}

/** The snapshot has no LHM node for the board itself, so the rename key is a fixed name (settings.ts). */
export const BOARD_KEY = '/motherboard';

/** Manufacturer as the vendor table spells it, then the product: "MSI MAG X870E TOMAHAWK WIFI (MS-7E59)". */
export function boardName(snapshot: StaticSnapshot | null): string {
  if (!snapshot) return 'Board';
  const { manufacturer, product } = snapshot.motherboard;
  const vendor = vendorOf(manufacturer).vendor || manufacturer.replace(/\s*(Co\.|Ltd\.|Inc\.|Corporation|Computer).*$/i, '').trim();
  return [vendor, product].filter(Boolean).join(' ') || 'Board';
}

const volts = (x: number) => `${x.toFixed(3)} V`;
const degrees = (x: number) => `${x.toFixed(1)} °C`;

export const BoardPanel: React.FC<Props> = ({ index, tick, ring, snapshot, panel }) => {
  const cpuName = snapshot?.cpu.name;
  const layout = useMemo(() => {
    const io = index.hardware(/^(SuperIO|EmbeddedController)$/i);
    const temps = index.findAll(io, 'Temperature', /./).map((f) => f.meta);
    const controls = index.findAll(io, 'Control', /./).map((f) => f.meta);
    // LHM names the duty "Pump Fan" but the tacho "Pump Fan #1"; the same header otherwise shares its name.
    const fans = index.findAll(io, 'Fan', /./).map((f) => {
      const short = f.meta.name.replace(/\s#\d+$/, '');
      const duty = controls.find((c) => c.hardware === f.meta.hardware && (c.name === f.meta.name || c.name === short));
      return { id: f.meta.id, name: f.meta.name, duty: duty?.id };
    });
    return { rails: boardRails(index, io, cpuName), temps, fans };
  }, [index, cpuName]);
  const vendor = useMemo(() => vendorOf(snapshot?.motherboard.manufacturer), [snapshot]);
  // The super-IO's "CPU Core" reading is the same die the CPU panel judges against Tjmax; one temperature must not get two verdicts on one screen.
  const tjmax = cpuLimits(cpuName).tjmax;
  const isCpuTemp = (name: string) => /\bCPU\b/i.test(name) && !/socket/i.test(name);

  if (!layout.rails.length && !layout.temps.length && !layout.fans.length) return null;

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id: string) => ring.series((t) => t.sensors[id]);
  const fanHigh = Math.max(...layout.fans.map((f) => ring.high((t) => t.sensors[f.id])), 2000);
  const fans = layout.fans.map((f) => ({ ...f, rpm: v(f.id), duty: v(f.duty), state: fanState(v(f.id), v(f.duty)) }));
  const unused = fans.filter((f) => f.state.unused).length;
  const bios = snapshot?.motherboard.biosVersion ? `BIOS ${snapshot.motherboard.biosVersion}${snapshot.motherboard.biosDate ? ` · ${snapshot.motherboard.biosDate}` : ''}` : undefined;

  return (
    <Panel kind="Board" title={boardName(snapshot)} nameKey={BOARD_KEY} vendor={vendor} aside={bios && <span className="figure text-[12px] text-studio-muted truncate">{bios}</span>} {...panel}>
      <div className="split-3">
        {layout.rails.length > 0 && (
          <div className="bars space-y-1.5 min-w-0">
            <h3 className="label text-studio-subtle">Rails</h3>
            {layout.rails.map((r) => (
              <Bar key={r.id} label={r.label} value={v(r.id)} format={volts} min={r.min} max={r.max} band={r.band} limit={r.limit} limitLabel={r.limitLabel} tone={railTone(r, v(r.id) ?? 0)} history={hist(r.id)} />
            ))}
          </div>
        )}
        {layout.temps.length > 0 && (
          <div className="bars space-y-1.5 min-w-0">
            <h3 className="label text-studio-subtle">Temperatures</h3>
            {layout.temps.map((m) =>
              isCpuTemp(m.name) && tjmax ? (
                <Bar key={m.id} label={m.name} value={v(m.id)} format={degrees} max={tjmax + 10} limit={tjmax} limitLabel={`Tjmax ${tjmax} °C`} tone={toneByLimit(v(m.id) ?? 0, tjmax)} history={hist(m.id)} />
              ) : (
                <Bar key={m.id} label={m.name} value={v(m.id)} format={degrees} max={100} tone={toneByThresholds(v(m.id) ?? 0, 70, 90)} history={hist(m.id)} />
              )
            )}
          </div>
        )}
        {layout.fans.length > 0 && (
          <div className="bars space-y-1.5 min-w-0">
            <h3 className="label text-studio-subtle">Fans</h3>
            {fans.map((f) =>
              f.state.unused ? null : (
                <Bar
                  key={f.id}
                  label={f.name}
                  value={f.rpm}
                  format={(x) => `${x.toFixed(0)} rpm`}
                  max={fanHigh * 1.1}
                  sub={f.state.note || f.duty === undefined ? undefined : `${f.duty.toFixed(0)} %`}
                  note={f.state.note}
                  tone={f.state.tone}
                  history={hist(f.id)}
                />
              )
            )}
            {unused > 0 && <p className="label text-studio-subtle pl-0.5">{`${unused} header${unused > 1 ? 's' : ''} unused`}</p>}
          </div>
        )}
      </div>
    </Panel>
  );
};
