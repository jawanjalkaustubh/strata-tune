import React, { useMemo } from 'react';
import type { GpuFacts, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Bar, toneByLimit, toneByThresholds } from './Bar';
import { Pill, type Tone } from './Pill';
import { PinHeader } from './PinHeader';
import { CardSchematic } from './CardSchematic';
import { gpuLayout } from './gpuLayout';
import { decodeReasons } from './reasons';
import { GPU_IDLE, hasAny, hasBit, IDLE_HINT, SLOWDOWN, SW_POWER_CAP, THERMAL_OR_BRAKE } from '../../analysis/nvmlBits';
import { fanState } from './fans';
import { gpuTitle, vendorOf } from './vendors';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  panel?: PanelChrome;
}

/** The NVML node the rename is keyed by. */
export const gpuKey = (gpu: GpuFacts | undefined) => (gpu ? `/nvml/${gpu.index}` : undefined);

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const degrees = (x: number) => `${x.toFixed(0)} °C`;
const mhz = (x: number) => `${x.toFixed(0)} MHz`;
const percent = (x: number) => `${x.toFixed(0)} %`;

/**
 * Laid out like the CPU panel (phase1-polish item 4): the card schematic on the left with
 * the perf-limit pills under it, the 12V-2x6 block filling the column to its right, the
 * compact bars beneath. The schematic takes 42 % of the panel (300–380 px) so its
 * figures grow with the panel rather than staying a small tile in a wide box.
 */
export const GpuPanel: React.FC<Props> = ({ index, tick, ring, panel }) => {
  const gpu: GpuFacts | undefined = tick.gpu[0];
  const gpuName = gpu?.name;
  const layout = useMemo(() => gpuLayout(index, gpuName), [index, gpuName]);
  const vendor = useMemo(() => vendorOf(gpuName), [gpuName]);

  if (!gpu) {
    return (
      <Panel kind="GPU" title="GPU" {...panel}>
        <p className="text-mini text-studio-muted">The collector reports no NVML GPU.</p>
      </Panel>
    );
  }

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));
  const g = (pick: (f: GpuFacts) => number) => ring.series((t) => (t.gpu[0] ? pick(t.gpu[0]) : undefined));

  const powerW = gpu.powerMw / 1000;
  const limitW = gpu.powerLimitMw / 1000;
  const maxLimitW = gpu.powerMaxLimitMw / 1000;
  const powerMax = Math.max(limitW, maxLimitW, powerW) * 1.05 || 100;
  const reasons = gpu.clocksEventReasons.raw;
  const idle = hasBit(reasons, GPU_IDLE) || (hasBit(reasons, IDLE_HINT) && gpu.utilisation.gpu < 5);
  // The reference is the highest SM clock this session: a gap below it means something
  // only when the driver says so with a slowdown bit (plan 17a); otherwise it is the boost
  // governor, and the perf-limit pills carry the reason.
  const smHigh = Math.max(ring.high((t) => t.gpu[0]?.clocks.smMhz), gpu.clocks.smMhz);
  const clockMax = Math.max(smHigh, 1500) * 1.05;
  const slowed = hasAny(reasons, SLOWDOWN);
  const gap = smHigh - gpu.clocks.smMhz;
  const smTone: Tone = idle ? 'idle' : hasAny(reasons, THERMAL_OR_BRAKE) ? 'bad' : hasBit(reasons, SW_POWER_CAP) ? 'warn' : 'ok';
  const memMax = Math.max(ring.high((t) => t.gpu[0]?.clocks.memMhz), gpu.clocks.memMhz, 1000) * 1.05;
  const fanHigh = Math.max(...layout.fans.map((f) => ring.high((t) => t.sensors[f.id])), 2000);
  const unusedFans = layout.fans.filter((f) => fanState(v(f.id), v(f.duty)).unused).length;
  const engineLoad = (ids: string[]) => Math.max(0, ...ids.map((id) => tick.sensors[id] ?? 0));
  const connectorA = v(layout.connectorA);
  const pills = (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="label mr-1">Perf limit</span>
      {decodeReasons(reasons).map((r) => (
        <Pill key={r.label} tone={r.tone} className={r.mono ? 'normal-case' : ''} title={`clocks event reasons 0x${reasons.toString(16)}`}>
          {r.label}
        </Pill>
      ))}
    </div>
  );

  return (
    <Panel kind="GPU" title={gpuTitle(gpu)} nameKey={gpuKey(gpu)} vendor={vendor} aside={<span className="figure text-[12px] text-studio-muted truncate">driver {gpu.driver}</span>} {...panel}>
      <div className="split">
        <div className="shrink-0 w-[42%] min-w-[min(100%,300px)] max-w-[min(100%,380px)] space-y-1.5">
          <CardSchematic
            vendor={vendor}
            coreC={gpu.temperatureC}
            hotSpotC={v(layout.hotSpot)}
            coreV={v(layout.coreV)}
            smMhz={gpu.clocks.smMhz}
            memMhz={gpu.clocks.memMhz}
            vramUsedMiB={gpu.vram.usedMiB}
            vramTotalMiB={gpu.vram.totalMiB}
            memJunctionC={v(layout.memJunction)}
            pcie={{ gen: gpu.pcie.currentGen, width: gpu.pcie.currentWidth, maxGen: gpu.pcie.maxGen, maxWidth: gpu.pcie.maxWidth }}
            rx={v(layout.rx)}
            tx={v(layout.tx)}
            rxHistory={hist(layout.rx)}
            txHistory={hist(layout.tx)}
            fans={layout.fans.map((f) => ({ name: f.name, rpm: v(f.id), duty: v(f.duty), history: hist(f.id) }))}
            engines={layout.engines.map((e) => ({ name: e.name, load: engineLoad(e.ids) }))}
            connectorW={v(layout.connectorW)}
            connectorA={connectorA}
            idle={idle}
            histories={{ coreC: g((f) => f.temperatureC), vramUsedMiB: g((f) => f.vram.usedMiB) }}
          />
          {pills}
        </div>
        <div className="flex-1 min-w-0">
          {layout.pins.length > 0 ? (
            <PinHeader
              pins={layout.pins.map((p) => ({ n: p.n, amps: v(p.ampsId), volts: v(p.voltsId), watts: v(p.wattsId) }))}
              totalAmps={connectorA}
              totalWatts={v(layout.connectorW)}
              history={(p) => hist(layout.pins.find((x) => x.n === p.n)?.ampsId)}
            />
          ) : (
            <p className="text-micro text-studio-subtle leading-relaxed">No per-pin connector sensing on this card; the board power below is NVML's total.</p>
          )}
        </div>
      </div>
      <div className="split-2 pt-1">
        <div className="bars space-y-1.5 min-w-0">
          <Bar label="Core temp" value={gpu.temperatureC} format={degrees} max={100} tone={toneByThresholds(gpu.temperatureC, 80, 88)} history={g((f) => f.temperatureC)} />
          <Bar label="Hot spot" value={v(layout.hotSpot)} format={degrees} max={110} tone={toneByThresholds(v(layout.hotSpot) ?? 0, 90, 100)} history={hist(layout.hotSpot)} />
          <Bar label="Memory junction" value={v(layout.memJunction)} format={degrees} max={110} tone={toneByThresholds(v(layout.memJunction) ?? 0, 90, 100)} history={hist(layout.memJunction)} />
          <Bar
            label="Board power"
            value={powerW}
            format={(x) => `${x.toFixed(0)} W`}
            max={powerMax}
            limit={limitW || undefined}
            limitLabel={`Power limit ${limitW.toFixed(0)} W`}
            mark={maxLimitW && maxLimitW !== limitW ? maxLimitW : undefined}
            markLabel={`Maximum limit ${maxLimitW.toFixed(0)} W`}
            sub={limitW ? `of ${limitW.toFixed(0)} W` : undefined}
            tone={toneByLimit(powerW, limitW || undefined, 0.95)}
            history={g((f) => f.powerMw / 1000)}
          />
          <Bar
            label="VRAM"
            value={gpu.vram.usedMiB}
            format={gib}
            max={gpu.vram.totalMiB || 1}
            sub={`of ${gib(gpu.vram.totalMiB)}`}
            tone={toneByLimit(gpu.vram.usedMiB, gpu.vram.totalMiB || undefined, 0.9)}
            history={g((f) => f.vram.usedMiB)}
          />
          {layout.fans.map((f) => {
            const rpm = v(f.id);
            const duty = v(f.duty);
            const state = fanState(rpm, duty);
            if (state.unused) return null;
            return (
              <Bar
                key={f.id}
                label={f.name}
                value={rpm}
                format={(x) => `${x.toFixed(0)} rpm`}
                max={fanHigh * 1.1}
                sub={state.note || duty === undefined ? undefined : `${duty.toFixed(0)} %`}
                note={state.note}
                tone={state.tone}
                history={hist(f.id)}
              />
            );
          })}
          {unusedFans > 0 && <p className="label text-studio-subtle pl-0.5">{`${unusedFans} fan${unusedFans > 1 ? 's' : ''} stopped`}</p>}
        </div>
        <div className="bars space-y-1.5 min-w-0">
          <Bar
            label="SM clock"
            value={gpu.clocks.smMhz}
            format={mhz}
            max={clockMax}
            mark={smHigh}
            markLabel={`Highest this session ${smHigh.toFixed(0)} MHz`}
            sub={slowed && gap > 0 ? `−${gap.toFixed(0)} MHz` : undefined}
            tone={smTone}
            history={g((f) => f.clocks.smMhz)}
          />
          <Bar label="Memory clock" value={gpu.clocks.memMhz} format={mhz} max={memMax} tone={idle ? 'idle' : 'ok'} history={g((f) => f.clocks.memMhz)} />
          <Bar label="GPU load" value={gpu.utilisation.gpu} format={percent} max={100} tone={gpu.utilisation.gpu < 5 ? 'idle' : 'ok'} history={g((f) => f.utilisation.gpu)} />
          {/* No bus-load bar: LHM's "GPU Bus" (NVAPI's bus utilisation domain) reads 57–100 % on this idle RTX 5090; the PCIe edge's Rx/Tx sparkline is the honest link figure. */}
          <Bar label="Memory ctrl" value={gpu.utilisation.memory} format={percent} max={100} tone={gpu.utilisation.memory < 5 ? 'idle' : 'ok'} history={g((f) => f.utilisation.memory)} />
        </div>
      </div>
    </Panel>
  );
};
