import React, { useMemo } from 'react';
import type { StaticSnapshot, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel } from './Panel';
import { Bar, toneByThresholds } from './Bar';
import { boardRails, railTone } from './rails';
import { fanState } from './fans';
import { vendorOf } from './vendors';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
}

const volts = (x: number) => `${x.toFixed(3)} V`;
const degrees = (x: number) => `${x.toFixed(1)} °C`;

export const BoardPanel: React.FC<Props> = ({ index, tick, ring, snapshot }) => {
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

  if (!layout.rails.length && !layout.temps.length && !layout.fans.length) return null;

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id: string) => ring.series((t) => t.sensors[id]);
  const fanHigh = Math.max(...layout.fans.map((f) => ring.high((t) => t.sensors[f.id])), 2000);
  const fans = layout.fans.map((f) => ({ ...f, rpm: v(f.id), duty: v(f.duty), state: fanState(v(f.id), v(f.duty)) }));
  const unused = fans.filter((f) => f.state.unused).length;
  const bios = snapshot?.motherboard.biosVersion ? `BIOS ${snapshot.motherboard.biosVersion}${snapshot.motherboard.biosDate ? ` · ${snapshot.motherboard.biosDate}` : ''}` : undefined;

  return (
    <Panel title="Board" vendor={vendor} className="xl:col-span-2" aside={bios && <span className="figure text-[12px] text-studio-muted truncate">{bios}</span>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-3">
        {layout.rails.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="label text-studio-subtle">Rails</h3>
            {layout.rails.map((r) => (
              <Bar key={r.id} label={r.label} value={v(r.id)} format={volts} min={r.min} max={r.max} band={r.band} limit={r.limit} limitLabel={r.limitLabel} tone={railTone(r, v(r.id) ?? 0)} history={hist(r.id)} />
            ))}
          </div>
        )}
        {layout.temps.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="label text-studio-subtle">Temperatures</h3>
            {layout.temps.map((m) => (
              <Bar key={m.id} label={m.name} value={v(m.id)} format={degrees} max={100} tone={toneByThresholds(v(m.id) ?? 0, 70, 90)} history={hist(m.id)} />
            ))}
          </div>
        )}
        {layout.fans.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="label text-studio-subtle">Fans</h3>
            {fans.map((f) =>
              f.state.unused ? null : (
                <Bar
                  key={f.id}
                  label={f.name}
                  value={f.rpm}
                  format={(x) => `${x.toFixed(0)} rpm`}
                  max={fanHigh * 1.1}
                  sub={f.state.note ?? (f.duty !== undefined ? `${f.duty.toFixed(0)} %` : undefined)}
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
